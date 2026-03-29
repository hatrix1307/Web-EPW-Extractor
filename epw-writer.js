// epw-writer.js — Build EAG$WASM EPW container files

import { readU32LE, writeU32LE, concat, strBytes, crc32 } from './binary.js'
import { xzCompress } from './compression.js'
import { buildEpk } from './epk-writer.js'

/**
 * Build an EPW file from a set of component files.
 *
 * @param {object} opts
 * @param {object}       opts.metadata     - { packageName, clientName, variantId, authorTag }
 * @param {Uint8Array[]} opts.pngFiles     - favicon PNGs (raw, uncompressed in EPW)
 * @param {Uint8Array}   opts.bootstrapJs  - bootstrap.js (stored raw)
 * @param {Uint8Array}   opts.bootstrapWasm- bootstrap.wasm (stored raw)
 * @param {Uint8Array}   opts.launcherHtml - launcher.html (will be XZ compressed)
 * @param {Uint8Array}   opts.clientJs     - client.js  (will be XZ compressed)
 * @param {Uint8Array}   opts.clientWasm   - client.wasm (will be XZ compressed)
 * @param {Uint8Array}   opts.workerWasm   - worker.wasm (will be XZ compressed)
 * @param {Uint8Array}   opts.tdbgBlob     - teavm_debug.tdbg (will be XZ compressed)
 * @param {Array<{name:string,data:Uint8Array}>} opts.assetsFiles  - primary asset files → built into EPK
 * @param {string}       opts.assetsEpkName  - e.g. "assets.epk"
 * @param {Array<{name:string,data:Uint8Array}>} opts.langFiles    - lang files → secondary EPK
 * @param {string}       opts.langEpkName    - e.g. "assets.1.0.epk"
 * @param {(msg:string)=>void} [opts.onLog]
 * @returns {Promise<Uint8Array>}
 */
export async function buildEpw(opts) {
  const {
    metadata   = {},
    pngFiles   = [],
    bootstrapJs   = null,
    bootstrapWasm = null,
    launcherHtml  = null,
    clientJs      = null,
    clientWasm    = null,
    workerWasm    = null,
    tdbgBlob      = null,
    assetsFiles   = [],
    assetsEpkName = 'assets.epk',
    langFiles     = [],
    langEpkName   = 'assets.1.0.epk',
    onLog,
  } = opts

  const log = onLog ?? (() => {})

  // ── Build list of section blobs ────────────────────────────────────────────
  // Each blob: { data: Uint8Array, compress: boolean }

  const sections = []

  const addRaw = (data) => { if (data?.length) sections.push({ data, compress: false }) }
  const addXz  = async (data, label) => {
    if (!data?.length) return
    log(`Compressing ${label} with XZ…`)
    const compressed = await xzCompress(data)
    sections.push({ data: compressed, compress: false, decomp: data.length })
    log(`  ${data.length} → ${compressed.length} bytes`)
  }
  const addLabel = (str) => {
    sections.push({ data: strBytes(str), compress: false, isLabel: true })
  }

  // PNGs (raw)
  for (const png of pngFiles) addRaw(png)

  // Inline JS / WASM (raw)
  addRaw(bootstrapJs)
  addRaw(bootstrapWasm)

  // XZ-compressed client files (order matches known EPW builds)
  await addXz(launcherHtml, 'launcher.html')
  await addXz(clientJs,     'client.js')
  await addXz(clientWasm,   'client.wasm (main)')
  await addXz(tdbgBlob,     'teavm_debug.tdbg')
  await addXz(workerWasm,   'worker.wasm')

  // Primary assets EPK → XZ
  if (assetsFiles.length > 0) {
    addLabel(assetsEpkName)
    log(`Building EPK: ${assetsEpkName} (${assetsFiles.length} files)…`)
    const epkBlob = buildEpk(assetsEpkName, assetsFiles)
    await addXz(epkBlob, assetsEpkName)
  }

  // Lang EPK → XZ
  if (langFiles.length > 0) {
    addLabel(langEpkName.replace(/\.epk$/, '').split('.').pop() || 'lang')
    log(`Building EPK: ${langEpkName} (${langFiles.length} files)…`)
    const langEpkBlob = buildEpk(langEpkName, langFiles)
    await addXz(langEpkBlob, langEpkName)
  }

  // ── String table ───────────────────────────────────────────────────────────
  // Strings are packed at 0x180 in the real format; we build them here.
  const enc          = new TextEncoder()
  const STR_TABLE_OFF = 0x180

  const metaStrings = [
    metadata.packageName ?? 'net.lax1dude.eaglercraft.v1_8.client',
    metadata.clientName  ?? 'Eaglercraft',
    metadata.variantId   ?? 'u0',
    metadata.authorTag   ?? 'Generated',
  ]

  // Pack strings contiguously, compute offsets
  const strParts = []
  const strOffsets = []
  let strCursor = STR_TABLE_OFF
  for (const s of metaStrings) {
    strOffsets.push(strCursor)
    const b = enc.encode(s)
    strParts.push(new Uint8Array([...b, 0x00]))  // null-terminated
    strCursor += b.length + 1
  }

  // ── Compute section data offsets ───────────────────────────────────────────
  // The data blobs are placed after the string table.
  // Header is fixed at 0x160 (end of section table) + some padding to 0x180 for strings.
  // Strings start at 0x180 and run to strCursor.
  // Data starts at strCursor, aligned to 4 bytes.
  let dataStart = strCursor
  if (dataStart % 4 !== 0) dataStart += 4 - (dataStart % 4)

  // Calculate absolute offsets for each section blob
  let cursor = dataStart
  const sectionOffsets = []
  for (const s of sections) {
    sectionOffsets.push(cursor)
    cursor += s.data.length
  }
  const totalSize = cursor

  // ── Build fixed header ─────────────────────────────────────────────────────
  const header = new Uint8Array(0x160)   // 0x00–0x15F

  // Magic
  header.set(strBytes('EAG$WASM'), 0x00)

  // Total size (uint32 LE) — we write a placeholder, fix up below
  writeU32LE(header, 0x08, totalSize)

  // Checksum / build ID — use CRC32 of the metadata string
  const buildTag = enc.encode(metaStrings[0])
  writeU32LE(header, 0x0C, crc32(buildTag))

  // Unknown header bytes (0x10–0x17) — copy a sane default from real EPWs
  header[0x10] = 0x01
  header[0x11] = 0x00
  header[0x12] = 0x01
  header[0x13] = 0x00

  // ── Metadata entries at 0x18–0x57 (4 × 16 bytes) ─────────────────────────
  // Entry[0] pair0 = packageName, pair1 = clientName
  // Entry[1] pair0 = variantId,   pair1 = authorTag
  // Entries [2..3] are duplicates of [0..1] (from spec)
  const writeMetaPair = (base, pairIdx, strIdx) => {
    const off = base + pairIdx * 8
    writeU32LE(header, off,     strOffsets[strIdx])
    writeU32LE(header, off + 4, metaStrings[strIdx].length)
  }
  writeMetaPair(0x18, 0, 0)  // packageName
  writeMetaPair(0x18, 1, 1)  // clientName
  writeMetaPair(0x28, 0, 2)  // variantId
  writeMetaPair(0x28, 1, 3)  // authorTag
  // entries 0x38, 0x48 left as zero (duplicates, optional)

  // ── Unknown block at 0x58 ─────────────────────────────────────────────────
  // Mirror real EPW: last field is data start offset, second field is section count
  writeU32LE(header, 0x5C, sections.filter(s => !s.isLabel).length)
  writeU32LE(header, 0x60 - 4, dataStart)  // 0x5C is already written above; place dataStart at 0x64

  // Actually the real EPW has the 0x58 block as: [some_hash, 0x19d, 0x2, data_start_off]
  // We replicate just the data start offset at position 0x5C (12 bytes into 0x58 block)
  writeU32LE(header, 0x58 + 12, dataStart)

  // ── Section table at 0x60–0x15F ───────────────────────────────────────────
  // We use a simple incremental type_field (0, 1, 2, …) — clients should detect by content anyway
  const validSects = sections.filter(s => !s.isLabel)
  let   sectIdx    = 0
  let   rawIdx     = 0  // index into original `sections` array

  for (let i = 0; i < sections.length && sectIdx < 16; i++) {
    const s   = sections[i]
    const base = 0x60 + sectIdx * 16
    writeU32LE(header, base,      i)                          // type_field
    writeU32LE(header, base +  4, sectionOffsets[i])          // data_offset
    writeU32LE(header, base +  8, s.data.length)              // comp_size
    writeU32LE(header, base + 12, s.decomp ?? 0)              // decomp_size
    sectIdx++
  }

  // ── Assemble final buffer ──────────────────────────────────────────────────
  const strTableBuf = concat(...strParts)
  // Padding between string table end and data start
  const padLen = dataStart - STR_TABLE_OFF - strTableBuf.length
  const pad    = new Uint8Array(Math.max(0, padLen))
  // Padding between 0x160 header end and 0x180 string table start
  const headerPad = new Uint8Array(STR_TABLE_OFF - header.length)  // 0x180 - 0x160 = 0x20

  const blobParts = sections.map(s => s.data)

  const result = concat(header, headerPad, strTableBuf, pad, ...blobParts)

  // Fix up total size in case our calculation was off
  writeU32LE(result, 0x08, result.length)

  log(`EPW assembled: ${result.length} bytes (${(result.length / 1048576).toFixed(2)} MB)`)
  return result
}
