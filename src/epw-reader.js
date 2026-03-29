// epw-reader.js — Parse EAG$WASM EPW container files

import { readU32LE, readCStr } from './binary.js'
import { xzDecompress, gzipDecompress } from './compression.js'
import { parseEpk } from './epk-reader.js'

const EPW_MAGIC = [0x45, 0x41, 0x47, 0x24, 0x57, 0x41, 0x53, 0x4d]

// ── Content-type detection ─────────────────────────────────────────────────

function detectType(d) {
  const n = d.length

  // Short printable ASCII → label (discard)
  if (n <= 64 && d.every(b => b === 0 || (b >= 0x20 && b <= 0x7e))) return 'label'

  if (n >= 8 && d[0] === 0x89 && d[1] === 0x50 && d[2] === 0x4e && d[3] === 0x47
             && d[4] === 0x0d && d[5] === 0x0a && d[6] === 0x1a && d[7] === 0x0a)
    return 'png'

  if (n >= 4 && d[0] === 0x00 && d[1] === 0x61 && d[2] === 0x73 && d[3] === 0x6d)
    return 'wasm'

  if (n >= 6 && d[0] === 0xfd && d[1] === 0x37 && d[2] === 0x7a
             && d[3] === 0x58 && d[4] === 0x5a && d[5] === 0x00)
    return 'xz'

  if (n >= 2 && d[0] === 0x1f && d[1] === 0x8b)
    return 'gzip'

  if (n >= 8 && d[0] === 0x45 && d[1] === 0x41 && d[2] === 0x47 && d[3] === 0x50
             && d[4] === 0x4b && d[5] === 0x47 && d[6] === 0x24 && d[7] === 0x24)
    return 'epk'

  if (n >= 4 && d[0] === 0x74 && d[1] === 0x64 && d[2] === 0x62 && d[3] === 0x67)
    return 'tdbg'

  if (n > 0 && d[0] === 0x3c)
    return 'html'

  if (n > 0 && (d[0] === 0x28 || d[0] === 0x21 || d[0] === 0x22 || d[0] === 0x27))
    return 'js'

  return 'blob'
}

// ── Naming state ──────────────────────────────────────────────────────────

const PNG_NAMES  = ['favicon_256.png', 'favicon_96.png', 'favicon_48.png', 'favicon_32.png']
const WASM_NAMES = ['bootstrap.wasm', 'client.wasm', 'worker.wasm']
const JS_NAMES   = ['bootstrap.js', 'client.js']

class NamingState {
  constructor() {
    this.pngs  = 0
    this.wasms = 0
    this.jss   = 0
    this.blobs = 0
  }
  nextPng()  { return 'client/' + (PNG_NAMES[this.pngs++]  ?? `favicon_extra_${this.pngs}.png`) }
  nextWasm() { return 'client/' + (WASM_NAMES[this.wasms++] ?? `extra_${this.wasms}.wasm`) }
  nextJs()   { return 'client/' + (JS_NAMES[this.jss++]    ?? `extra_${this.jss}.js`) }
  nextBlob() { return `client/blob_${this.blobs++}.bin` }
}

// ── Section processor (recursive through XZ / GZIP wrappers) ──────────────

async function processData(data, state, results, onLog) {
  const type = detectType(data)

  if (type === 'label') {
    onLog?.(`  Skipping label: "${new TextDecoder().decode(data).replace(/\0/g, '')}"`)
    return
  }

  if (type === 'xz') {
    onLog?.('  Decompressing XZ section…')
    const inner = await xzDecompress(data)
    await processData(inner, state, results, onLog)
    return
  }

  if (type === 'gzip') {
    onLog?.('  Decompressing GZIP section…')
    const inner = gzipDecompress(data)
    await processData(inner, state, results, onLog)
    return
  }

  if (type === 'png') {
    const name = state.nextPng()
    onLog?.(`  PNG  → ${name}  (${data.length} bytes)`)
    results.push({ name, data, mimeType: 'image/png' })
    return
  }

  if (type === 'wasm') {
    const name = state.nextWasm()
    onLog?.(`  WASM → ${name}  (${data.length} bytes)`)
    results.push({ name, data, mimeType: 'application/wasm' })
    return
  }

  if (type === 'html') {
    onLog?.(`  HTML → client/launcher.html  (${data.length} bytes)`)
    results.push({ name: 'client/launcher.html', data, mimeType: 'text/html' })
    return
  }

  if (type === 'js') {
    const name = state.nextJs()
    onLog?.(`  JS   → ${name}  (${data.length} bytes)`)
    results.push({ name, data, mimeType: 'text/javascript' })
    return
  }

  if (type === 'tdbg') {
    onLog?.(`  TDBG → client/teavm_debug.tdbg  (${data.length} bytes)`)
    results.push({ name: 'client/teavm_debug.tdbg', data, mimeType: 'application/octet-stream' })
    return
  }

  if (type === 'epk') {
    onLog?.(`  EPK  detected, parsing…`)
    const { files } = parseEpk(data, onLog)
    results.push(...files)
    return
  }

  // Fallback blob
  const name = state.nextBlob()
  onLog?.(`  BLOB → ${name}  (${data.length} bytes, type=${type})`)
  results.push({ name, data, mimeType: 'application/octet-stream' })
}

// ── Main parser ────────────────────────────────────────────────────────────

/**
 * Parse an EPW file buffer.
 *
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {(msg: string) => void} [onLog]
 * @returns {Promise<{ metadata: object, files: Array<{name,data,mimeType}> }>}
 */
export async function parseEpw(buffer, onLog) {
  const buf = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)

  // ── Magic ──────────────────────────────────────────────────────────────────
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== EPW_MAGIC[i]) throw new Error('Not a valid EPW file (bad magic bytes)')
  }
  onLog?.('Magic OK: EAG$WASM')

  const totalSize = readU32LE(buf, 0x08)
  onLog?.(`File size: ${buf.length} bytes (header says ${totalSize})`)

  // ── Metadata entries: four 16-byte entries at 0x18–0x57 ───────────────────
  // Each 16-byte entry holds TWO (string_offset, string_length) pairs of 4 bytes each.
  // Pair 0 at [+0..+7], pair 1 at [+8..+15].
  const META_KEYS  = ['packageName', 'clientName', 'variantId', 'authorTag']
  const META_BASES = [0x18, 0x28, 0x38, 0x48]
  const metadata   = {}

  // From actual EPW analysis: entry[0].pair0=packageName, entry[0].pair1=clientName,
  // entry[1].pair0=variantId, entry[1].pair1=authorTag (entries 2–3 are duplicates).
  const readMetaStr = (base, pairIndex) => {
    const off = base + pairIndex * 8
    const strOff = readU32LE(buf, off)
    const strLen = readU32LE(buf, off + 4)
    if (strOff > 0 && strLen > 0 && strOff + strLen <= buf.length) {
      return new TextDecoder().decode(buf.slice(strOff, strOff + strLen))
    }
    return ''
  }

  metadata.packageName = readMetaStr(0x18, 0)
  metadata.clientName  = readMetaStr(0x18, 1)
  metadata.variantId   = readMetaStr(0x28, 0)
  metadata.authorTag   = readMetaStr(0x28, 1)

  onLog?.(`Metadata: package=${metadata.packageName} client=${metadata.clientName} variant=${metadata.variantId} author=${metadata.authorTag}`)

  // ── Section entries: 16 entries × 16 bytes at 0x60–0x15F ─────────────────
  const sectionEntries = []
  for (let i = 0; i < 16; i++) {
    const base       = 0x60 + i * 16
    const typeField  = readU32LE(buf, base)
    const dataOffset = readU32LE(buf, base +  4)
    const compSize   = readU32LE(buf, base +  8)
    const decompSize = readU32LE(buf, base + 12)
    if (dataOffset === 0 && compSize === 0) continue
    sectionEntries.push({ index: i, typeField, dataOffset, compSize, decompSize })
  }
  onLog?.(`Found ${sectionEntries.length} non-empty section entries`)

  // ── Process sections ──────────────────────────────────────────────────────
  const state   = new NamingState()
  const results = []

  for (let si = 0; si < sectionEntries.length; si++) {
    const { index, dataOffset, compSize } = sectionEntries[si]
    onLog?.(`\nSection [${index}] offset=${dataOffset} size=${compSize}`)

    if (dataOffset + compSize > buf.length) {
      onLog?.(`  Section overruns file — skipping`)
      continue
    }

    const sectionData = buf.slice(dataOffset, dataOffset + compSize)
    await processData(sectionData, state, results, onLog)
  }

  onLog?.(`\nExtraction complete. ${results.length} files.`)
  return { metadata, files: results }
}
