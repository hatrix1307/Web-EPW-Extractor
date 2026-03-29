// binary.js — low-level buffer helpers

export function readU32LE(buf, off) {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0
}

export function writeU32LE(buf, off, val) {
  val >>>= 0
  buf[off]     =  val        & 0xff
  buf[off + 1] = (val >>  8) & 0xff
  buf[off + 2] = (val >> 16) & 0xff
  buf[off + 3] = (val >> 24) & 0xff
}

export function readU32BE(buf, off) {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0
}

export function writeU32BE(buf, off, val) {
  val >>>= 0
  buf[off]     = (val >> 24) & 0xff
  buf[off + 1] = (val >> 16) & 0xff
  buf[off + 2] = (val >>  8) & 0xff
  buf[off + 3] =  val        & 0xff
}

/** Write a uint64 as two 32-bit halves (big-endian). */
export function writeU64BE(buf, off, ms) {
  const lo = ms % 0x100000000
  const hi = Math.floor(ms / 0x100000000)
  writeU32BE(buf, off,     hi)
  writeU32BE(buf, off + 4, lo)
}

/** Concatenate any number of Uint8Arrays into one. */
export function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out   = new Uint8Array(total)
  let   off   = 0
  for (const p of parts) { out.set(p, off); off += p.length }
  return out
}

export const enc = new TextEncoder()
export const dec = new TextDecoder()

export function strBytes(s)   { return enc.encode(s) }
export function bytesStr(b)   { return dec.decode(b) }

/** Read a null-terminated UTF-8 string from buf starting at off. */
export function readCStr(buf, off) {
  let end = off
  while (end < buf.length && buf[end] !== 0) end++
  return dec.decode(buf.slice(off, end))
}

/** CRC32 table (for EPK records). */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    t[i] = c
  }
  return t
})()

export function crc32(data, seed = 0) {
  let crc = seed ^ 0xffffffff
  for (const b of data) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
