// epk-reader.js — Parse EAGPKG$$ v2.0 asset packs

import { readU32BE } from './binary.js'
import { gzipDecompress } from './compression.js'

/** Detect basic MIME type from filename extension. */
function mimeFor(name) {
  const ext = name.split('.').pop().toLowerCase()
  return ({
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    ogg: 'audio/ogg', wav: 'audio/wav', mp3: 'audio/mpeg',
    json: 'application/json', mcmeta: 'application/json',
    txt: 'text/plain', lang: 'text/plain',
    vsh: 'text/plain', fsh: 'text/plain', glsl: 'text/plain',
    bin: 'application/octet-stream', class: 'application/octet-stream',
  })[ext] ?? 'application/octet-stream'
}

/**
 * Parse an EAGPKG$$ v2.0 EPK blob.
 *
 * @param {Uint8Array|ArrayBuffer} raw
 * @param {(msg:string)=>void}     [onLog]
 * @returns {{ epkName: string, dir: string, timestamp: number, files: Array<{name,data,mimeType}> }}
 */
export function parseEpk(raw, onLog) {
  const buf = raw instanceof Uint8Array ? raw : new Uint8Array(raw)
  const dec = new TextDecoder()
  let pos = 0

  // ── Magic ──────────────────────────────────────────────────────────────────
  const magic = dec.decode(buf.slice(0, 8))
  if (magic !== 'EAGPKG$$') throw new Error('Not an EPK file (expected EAGPKG$$ magic)')
  pos = 8

  // ── Version string ─────────────────────────────────────────────────────────
  const verLen    = buf[pos++]
  const version   = dec.decode(buf.slice(pos, pos + verLen))
  pos += verLen

  // ── EPK filename ───────────────────────────────────────────────────────────
  const fnLen  = buf[pos++]
  const epkName = dec.decode(buf.slice(pos, pos + fnLen))
  pos += fnLen

  // ── Null terminator ────────────────────────────────────────────────────────
  pos++ // 0x00

  // ── Scan to \n\n\0 marker ──────────────────────────────────────────────────
  let found = false
  while (pos < buf.length - 2) {
    if (buf[pos] === 0x0a && buf[pos + 1] === 0x0a && buf[pos + 2] === 0x00) {
      pos += 3; found = true; break
    }
    pos++
  }
  if (!found) throw new Error('EPK: could not find \\n\\n\\0 marker')

  // ── Binary section header: 8-byte timestamp (uint64 BE) + 4-byte count ────
  // Read timestamp as two 32-bit halves (JS can't do full uint64)
  const tsHi  = readU32BE(buf, pos);     pos += 4
  const tsLo  = readU32BE(buf, pos);     pos += 4
  const timestamp = tsHi * 0x100000000 + tsLo   // ms since epoch (may lose precision >2^53)
  pos += 4  // entry count (informational)

  // ── Output directory derived from EPK filename ─────────────────────────────
  const dir = epkName.replace(/\.epk$/i, '')

  const files = []

  // ── Records ────────────────────────────────────────────────────────────────
  while (pos < buf.length) {
    if (pos + 5 > buf.length) break

    const tag5 = dec.decode(buf.slice(pos, pos + 5))

    if (tag5 === 'END$$') break

    // 0HEAD — skip key/value metadata block
    if (tag5 === '0HEAD') {
      pos += 5
      while (pos < buf.length && buf[pos] !== 0x3e) pos++
      pos++ // skip '>'
      continue
    }

    // FILE record
    if (buf[pos]===0x46 && buf[pos+1]===0x49 && buf[pos+2]===0x4c && buf[pos+3]===0x45) {
      pos += 4
      const nameLen  = buf[pos++]
      const filename = dec.decode(buf.slice(pos, pos + nameLen))
      pos += nameLen

      const recordSize = readU32BE(buf, pos); pos += 4
      /* CRC32 */                              pos += 4
      const contentLen = recordSize - 4

      if (pos + contentLen > buf.length) {
        onLog?.(`Warning: FILE record for "${filename}" overruns buffer — skipping`)
        break
      }

      let content = buf.slice(pos, pos + contentLen)
      pos += contentLen

      // Transparent GZIP decompression of individual file records
      if (content[0] === 0x1f && content[1] === 0x8b) {
        try   { content = gzipDecompress(content) }
        catch { onLog?.(`Warning: GZIP decompress failed for ${filename}`) }
      }

      files.push({ name: `${dir}/${filename}`, data: content, mimeType: mimeFor(filename) })
      continue
    }

    pos++ // unknown — scan forward
  }

  onLog?.(`EPK "${epkName}" (${version}): extracted ${files.length} files`)
  return { epkName, dir, version, timestamp, files }
}
