// compression.js — XZ and GZIP wrappers for browser use
//
// XZ decompression: xz-decompress (WASM, browser-safe)
// XZ compression:   /api/xz-compress (Vercel serverless, @napi-rs/lzma)
// GZIP:             fflate (pure JS, browser-safe)

import { decompressSync, compressSync, zipSync } from 'fflate'
import xzPkg from 'xz-decompress'

const { XzReadableStream } = xzPkg

// ── XZ Decompression (browser WASM) ───────────────────────────────────────

export async function xzDecompress(data) {
  const input = data instanceof Uint8Array ? data : new Uint8Array(data)
  const readable = new ReadableStream({
    start(ctrl) { ctrl.enqueue(input); ctrl.close() },
  })
  const xzStream = new XzReadableStream(readable)
  const reader   = xzStream.getReader()
  const chunks   = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  const total  = chunks.reduce((n, c) => n + c.length, 0)
  const result = new Uint8Array(total)
  let   off    = 0
  for (const c of chunks) { result.set(c, off); off += c.length }
  return result
}

// ── XZ Compression (Vercel serverless API) ───────────────────────────────

export async function xzCompress(data, onLog) {
  const input = data instanceof Uint8Array ? data : new Uint8Array(data)
  onLog?.(`  Sending ${(input.length / 1024).toFixed(0)} KB to /api/xz-compress…`)
  let resp
  try {
    resp = await fetch('/api/xz-compress', {
      method:  'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body:    input,
    })
  } catch (netErr) {
    throw new Error(
      `XZ compression API unreachable (${netErr.message}). ` +
      `Deploy to Vercel or run "vercel dev" locally.`
    )
  }
  if (!resp.ok) {
    const msg = await resp.text().catch(() => resp.statusText)
    throw new Error(`XZ compress API error ${resp.status}: ${msg}`)
  }
  const out = new Uint8Array(await resp.arrayBuffer())
  onLog?.(`  Compressed: ${(out.length / 1024).toFixed(0)} KB (${(out.length / input.length * 100).toFixed(0)}%)`)
  return out
}

// ── GZIP ──────────────────────────────────────────────────────────────────

export function gzipDecompress(data) {
  return decompressSync(data instanceof Uint8Array ? data : new Uint8Array(data))
}

export function gzipCompress(data, level = 6) {
  return compressSync(data instanceof Uint8Array ? data : new Uint8Array(data), { level })
}

// ── ZIP output ────────────────────────────────────────────────────────────

export function makeZip(files) {
  const input = {}
  for (const [k, v] of Object.entries(files)) {
    input[k] = v instanceof Uint8Array ? v : new Uint8Array(v)
  }
  return zipSync(input, { level: 0 })
}
