// epk-reader.js — Parse EAGPKG$$ v2.0 asset packs
//
// Handles two record-section variants found in the wild:
//
//   Variant A (standard / records inside EPW):
//     Records are plain binary: "0HEAD", "FILE", "END$$" tags, no separators.
//
//   Variant B (standalone .epk files, eagler resource packs):
//     The records section is a raw-deflate stream with a GZIP header (1F 8B)
//     but no valid CRC/ISIZE footer — it is often truncated at EOF.
//     Decompressed via DecompressionStream('deflate-raw') which tolerates partial input.
//     Inside: "HEAD" (4-byte) instead of "0HEAD" (5-byte); optional ">" after each FILE.
//     Additional uncompressed FILE records may follow outside the compressed block.

import { decompressSync } from 'fflate'
import { rawInflatePartial } from './compression.js'

// ── MIME types ───────────────────────────────────────────────────────────

function mimeFor(name) {
  const ext = name.split('.').pop().toLowerCase()
  return ({
    png: 'image/png',  jpg: 'image/jpeg', jpeg: 'image/jpeg',
    ogg: 'audio/ogg',  wav: 'audio/wav',  mp3: 'audio/mpeg',
    json: 'application/json', mcmeta: 'application/json',
    txt: 'text/plain', lang: 'text/plain',
    vsh: 'text/plain', fsh: 'text/plain', glsl: 'text/plain',
    dat: 'application/octet-stream', nrm: 'application/octet-stream',
    bin: 'application/octet-stream', class: 'application/octet-stream',
  })[ext] ?? 'application/octet-stream'
}

// ── Skip GZIP 10-byte fixed header (FLG-based extras) ────────────────────

function skipGzipHeader(buf, pos) {
  const FLG = buf[pos + 3]
  let   p   = pos + 10
  if (FLG & 4)  { const xl = buf[p] | (buf[p + 1] << 8); p += 2 + xl }
  if (FLG & 8)  { while (p < buf.length && buf[p] !== 0) p++; p++ }
  if (FLG & 16) { while (p < buf.length && buf[p] !== 0) p++; p++ }
  if (FLG & 2)  { p += 2 }
  return p
}

// ── Record parser (handles both Variant A and B inside a decoded buffer) ──

function parseRecords(buf, onLog) {
  const dec   = new TextDecoder()
  const files = []
  let   pos   = 0

  while (pos < buf.length) {
    if (pos + 4 > buf.length) break

    // END$$ — stop
    if (pos + 5 <= buf.length &&
        buf[pos]===0x45 && buf[pos+1]===0x4e && buf[pos+2]===0x44 &&
        buf[pos+3]===0x24 && buf[pos+4]===0x24) break

    // "0HEAD" (5-byte, Variant A) — skip to '>'
    if (pos + 5 <= buf.length &&
        buf[pos]===0x30 && buf[pos+1]===0x48 && buf[pos+2]===0x45 &&
        buf[pos+3]===0x41 && buf[pos+4]===0x44) {
      pos += 5
      while (pos < buf.length && buf[pos] !== 0x3e) pos++
      pos++; continue
    }

    // "HEAD" (4-byte, Variant B) — skip to '>'
    if (buf[pos]===0x48 && buf[pos+1]===0x45 && buf[pos+2]===0x41 && buf[pos+3]===0x44) {
      pos += 4
      while (pos < buf.length && buf[pos] !== 0x3e) pos++
      pos++; continue
    }

    // "FILE" record
    if (buf[pos]===0x46 && buf[pos+1]===0x49 && buf[pos+2]===0x4c && buf[pos+3]===0x45) {
      pos += 4
      const nameLen = buf[pos++]
      if (pos + nameLen > buf.length) break
      const filename = dec.decode(buf.slice(pos, pos + nameLen))
      pos += nameLen

      if (pos + 8 > buf.length) break
      const recSize    = (buf[pos]<<24 | buf[pos+1]<<16 | buf[pos+2]<<8 | buf[pos+3]) >>> 0
      pos += 4; pos += 4   // skip CRC32

      const contentLen = recSize - 4
      if (contentLen < 0 || pos + contentLen > buf.length) break

      let content = buf.slice(pos, pos + contentLen)
      pos += contentLen

      // optional '>' separator (Variant B)
      if (pos < buf.length && buf[pos] === 0x3e) pos++

      // transparent GZIP of individual record content
      if (content.length >= 2 && content[0] === 0x1f && content[1] === 0x8b) {
        try   { content = decompressSync(content) }
        catch { onLog?.(`Warning: GZIP decompress failed for ${filename}`) }
      }

      files.push({ filename, content })
      continue
    }

    pos++
  }

  return files
}

// ── Scan raw buffer for uncompressed FILE records after a compressed block ─
// Uses a printability heuristic to avoid false matches inside compressed bytes.

function scanForOuterFiles(buf, onLog) {
  for (let i = 0; i < buf.length - 8; i++) {
    // END$$ — nothing more to find
    if (buf[i]===0x45 && buf[i+1]===0x4e && buf[i+2]===0x44 && buf[i+3]===0x24 && buf[i+4]===0x24) break

    // FILE — validate name length and printable name
    if (buf[i]===0x46 && buf[i+1]===0x49 && buf[i+2]===0x4c && buf[i+3]===0x45) {
      const nl = buf[i + 4]
      if (nl > 0 && nl <= 200 && i + 5 + nl <= buf.length) {
        const nameBytes = buf.slice(i + 5, i + 5 + nl)
        if (nameBytes.every(b => b >= 0x20 && b <= 0x7e)) {
          onLog?.(`  Found uncompressed FILE records at outer offset ${i}`)
          return parseRecords(buf.slice(i), onLog)
        }
      }
    }
  }
  return []
}

// ── Main EPK parser ───────────────────────────────────────────────────────

/**
 * Parse an EAGPKG$$ v2.0 EPK blob (Variant A or B).
 *
 * @param {Uint8Array|ArrayBuffer} raw
 * @param {(msg:string)=>void}     [onLog]
 * @returns {Promise<{ epkName, dir, version, timestamp, files[] }>}
 */
export async function parseEpk(raw, onLog) {
  const buf = raw instanceof Uint8Array ? raw : new Uint8Array(raw)
  const dec = new TextDecoder()
  let   pos = 0

  // ── Magic ──────────────────────────────────────────────────────────────
  if (dec.decode(buf.slice(0, 8)) !== 'EAGPKG$$')
    throw new Error('Not an EPK file (expected EAGPKG$$ magic)')
  pos = 8

  // ── Version ────────────────────────────────────────────────────────────
  const verLen  = buf[pos++]
  const version = dec.decode(buf.slice(pos, pos + verLen)); pos += verLen

  // ── EPK filename ───────────────────────────────────────────────────────
  const fnLen   = buf[pos++]
  const epkName = dec.decode(buf.slice(pos, pos + fnLen)); pos += fnLen
  pos++   // null terminator

  // ── Scan to \n\n\0 ─────────────────────────────────────────────────────
  let found = false
  while (pos < buf.length - 2) {
    if (buf[pos] === 0x0a && buf[pos + 1] === 0x0a && buf[pos + 2] === 0x00) {
      pos += 3; found = true; break
    }
    pos++
  }
  if (!found) throw new Error('EPK: could not find \\n\\n\\0 marker')

  // ── Binary header (8-byte timestamp + 4-byte count) ───────────────────
  const tsHi = (buf[pos]<<24|buf[pos+1]<<16|buf[pos+2]<<8|buf[pos+3])>>>0; pos+=4
  const tsLo = (buf[pos]<<24|buf[pos+1]<<16|buf[pos+2]<<8|buf[pos+3])>>>0; pos+=4
  const timestamp = tsHi * 0x100000000 + tsLo
  pos += 4   // entry count

  const dir = epkName.replace(/\.epk$/i, '')

  // ── Records section ────────────────────────────────────────────────────
  let rawFiles

  if (buf[pos] === 0x1f && buf[pos + 1] === 0x8b) {
    // ── Variant B: GZIP-headed raw deflate, possibly truncated ───────────
    onLog?.(`  Variant B: GZIP-compressed records — using DecompressionStream…`)
    const deflateStart = skipGzipHeader(buf, pos)
    const deflateData  = buf.slice(deflateStart)

    const inner = await rawInflatePartial(deflateData)
    if (!inner.length) throw new Error('Decompressed 0 bytes — format may be unsupported in this browser')
    onLog?.(`  Inflated ${deflateData.length} → ${inner.length} bytes`)

    rawFiles = parseRecords(inner, onLog)

    // Scan outer buffer for any uncompressed FILE records after the compressed block
    const outerFiles = scanForOuterFiles(buf.slice(pos), onLog)
    rawFiles.push(...outerFiles)
  } else {
    // ── Variant A: plain records ──────────────────────────────────────────
    rawFiles = parseRecords(buf.slice(pos), onLog)
  }

  const files = rawFiles.map(({ filename, content }) => {
    // Avoid double-prefix: some EPKs store filenames already beginning with
    // the dir name (e.g. "assets/eagler/..." inside "assets.epk" -> dir="assets").
    const sep = dir + '/'
    const name = filename.startsWith(sep) ? filename : sep + filename
    return { name, data: content, mimeType: mimeFor(filename) }
  })

  onLog?.(`EPK "${epkName}" (${version}): extracted ${files.length} files`)
  return { epkName, dir, version, timestamp, files }
}
