// api/xz-compress.js — Vercel serverless function
// Accepts a raw binary POST body and returns XZ-compressed bytes.
// Uses @napi-rs/lzma (native Node.js binding, not available in browser).

import { xz } from '@napi-rs/lzma'

export const config = {
  api: {
    bodyParser: false,         // we read the stream manually
    responseLimit: '512mb',
  },
}

/** Collect all chunks from a Node.js readable stream into a Buffer. */
async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end',  () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export default async function handler(req, res) {
  // CORS — allow the Vite dev server and any same-origin request
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  try {
    const body = await readBody(req)
    if (!body.length) {
      res.status(400).json({ error: 'Empty body' })
      return
    }

    // XZ compression level 6 (balanced speed/ratio)
    const compressed = xz.compressSync(body, 6)

    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('X-Decomp-Size', body.length.toString())
    res.status(200).send(compressed)
  } catch (err) {
    console.error('XZ compress error:', err)
    res.status(500).json({ error: err.message })
  }
}
