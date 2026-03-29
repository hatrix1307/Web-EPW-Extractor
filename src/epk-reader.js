// epk-reader.js — Parse EAGPKG$$ v2.0 asset packs

import { readU32BE } from './binary.js'
import { gzipDecompress } from './compression.js'

/** Detect basic MIME type from filename extension. */
function mimeFor(name) {
  const ext = name.split('.').pop().toLowerCase()
  return ({
    png:  'image/png',
    jpg:  'image/jpeg',
    jpeg: 'image/jpeg',
    ogg:  'audio/ogg',
    wav:  'audio/wav',
    json: 'application/json',
    txt:  'text/plain',
    lang: 'text/plain',
    mcmeta: 'application/json',
    bin:  'application/octet-stream',
    class: 'application/octet-stream',
  })[ext] ?? 'application/octet-stream'
}

/**
 * Parse an EAGPKG$$ v2.0 EPK blob.
 * Returns { epkName: string, files: Array<{ name, data, type }> }
 */
export function parseEpk(raw, onLog) {
  const buf = raw instanceof Uint8Array ? raw : new Uint8Array(raw)
  const dec = new TextDecoder()
  let pos = 0

  // ── Magic ──────────────────────────────────────────────────────────────────
  const magic = dec.decode(buf.slice(0, 8))
  if (magic !== 'EAGPKG$$') throw new Error('EPK magic mismatch')
  pos = 8

  // ── Version string ─────────────────────────────────────────────────────────
  const verLen = buf[pos++]
  pos += verLen  // skip version bytes

  // ── EPK filename ───────────────────────────────────────────────────────────
  const fnLen    = buf[pos++]
  const epkName  = dec.decode(buf.slice(pos, pos + fnLen))
  pos += fnLen

  // ── Null terminator ────────────────────────────────────────────────────────
  pos++ // 0x00

  // ── Scan to \n\n\0 marker ──────────────────────────────────────────────────
  let found = false
  while (pos < buf.length - 2) {
    if (buf[pos] === 0x0a && buf[pos + 1] === 0x0a && buf[pos + 2] === 0x00) {
      pos += 3  // skip past \n\n\0
      found = true
      break
    }
    pos++
  }
  if (!found) throw new Error('EPK: could not find \\n\\n\\0 marker')

  // ── Binary section header: 8-byte timestamp + 4-byte entry count ──────────
  pos += 8  // timestamp (uint64 BE)
  pos += 4  // entry count (informational)

  // ── Derive output directory from EPK filename ──────────────────────────────
  // "assets.epk" → "assets", "assets.1.0.epk" or "assets.1.0" → "assets.1.0"
  let dir = epkName.replace(/\.epk$/, '')

  const files = []

  // ── Records ────────────────────────────────────────────────────────────────
  while (pos < buf.length) {
    if (pos + 5 > buf.length) break

    const tag5 = dec.decode(buf.slice(pos, pos + 5))

    // END$$ — stop
    if (tag5 === 'END$$') break

    // 0HEAD — skip until '>' byte
    if (tag5 === '0HEAD') {
      pos += 5
      while (pos < buf.length && buf[pos] !== 0x3e) pos++
      pos++ // skip '>'
      continue
    }

    // FILE record — 4-byte tag "FILE"
    if (buf[pos] === 0x46 && buf[pos + 1] === 0x49 && buf[pos + 2] === 0x4c && buf[pos + 3] === 0x45) {
      pos += 4
      const nameLen  = buf[pos++]
      const filename = dec.decode(buf.slice(pos, pos + nameLen))
      pos += nameLen

      const recordSize = readU32BE(buf, pos);  pos += 4
      /* CRC32 */                               pos += 4
      const contentLen = recordSize - 4

      if (pos + contentLen > buf.length) {
        onLog?.(`Warning: FILE record for "${filename}" overruns buffer — skipping`)
        break
      }

      let content = buf.slice(pos, pos + contentLen)
      pos += contentLen

      // Transparent GZIP decompression
      if (content[0] === 0x1f && content[1] === 0x8b) {
        try   { content = gzipDecompress(content) }
        catch { onLog?.(`Warning: GZIP decompress failed for ${filename}`) }
      }

      files.push({ name: `${dir}/${filename}`, data: content, type: mimeFor(filename) })
      continue
    }

    // Unknown byte — scan forward to next known marker
    pos++
  }

  onLog?.(`EPK "${epkName}": extracted ${files.length} files`)
  return { epkName, dir, files }
}
