import { defineConfig } from 'vite'

export default defineConfig({
  optimizeDeps: {
    // These packages must NOT be pre-bundled — xz-decompress ships its own
    // WASM init logic that breaks if Vite rewrites the import.
    exclude: ['xz-decompress'],
  },
  build: {
    target: 'esnext',
    // Allow large chunks (WASM files, big client blobs)
    chunkSizeWarningLimit: 4096,
  },
  server: {
    // In local dev, proxy the XZ compress API to a local Node process.
    // Run `vercel dev` for full serverless emulation, or use the proxy below
    // pointing at a simple local express server if preferred.
    proxy: {},
  },
})
