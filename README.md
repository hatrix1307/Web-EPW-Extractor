# EPW Tools

A browser-based utility to **extract** and **compile** Eaglercraft `.epw` (EAG$WASM) asset pack files.

Tested against a real `assets.epw` — correctly identifies and extracts all 13,155 files from the primary asset EPK.

## Features

**Extractor**
- Drag-and-drop `.epw` files, get all contents extracted instantly
- Handles all section types: PNG favicons, inline JS/WASM, XZ-compressed HTML/JS/WASM/tdbg, EPK v2.0 archives
- EPK records transparently GZIP-decompressed where needed
- Live filterable file list with per-file save or bulk ZIP download

**Compiler**
- Drop individual components into labeled slots
- Fills in all EPW header fields, metadata strings, and section table
- Builds primary and secondary EPK archives automatically
- XZ compression via `/api/xz-compress` serverless endpoint (Vercel)

## Quick Start

```bash
npm install
npm run dev       # Vite dev server — extraction works immediately
vercel dev        # Full stack — enables XZ compression for compiler tab
```

## Deploy to Vercel

Push to GitHub, import in Vercel — build settings are auto-detected.

| Setting | Value |
|---------|-------|
| Framework | Vite |
| Build command | `npm run build` |
| Output directory | `dist` |

The `/api/xz-compress` endpoint is a Vercel serverless function using `@napi-rs/lzma`. It activates automatically on deploy.

## Architecture

| Component | Tech | Notes |
|-----------|------|-------|
| XZ decompress | `xz-decompress` (WASM) | Browser-safe, no server needed |
| XZ compress | `@napi-rs/lzma` (native) | Serverless function only |
| GZIP | `fflate` | Browser, sync |
| ZIP output | `fflate` | Browser, sync |
| Dev/build | Vite 5 | |

## File Structure

```
epw-tools/
├── api/
│   └── xz-compress.js      Vercel serverless — XZ compression
├── src/
│   ├── main.js             UI wiring, tab logic
│   ├── style.css           Dark terminal theme
│   ├── binary.js           Low-level buffer read/write helpers
│   ├── compression.js      XZ + GZIP + ZIP wrappers
│   ├── epk-reader.js       EAGPKG$$ v2.0 parser
│   ├── epk-writer.js       EAGPKG$$ v2.0 builder
│   ├── epw-reader.js       EAG$WASM parser
│   └── epw-writer.js       EAG$WASM builder
├── index.html
├── vite.config.js
├── vercel.json
└── package.json
```

## Format Notes

The `.epw` format (`EAG$WASM` magic) is **not** the same as `EAGPKG$$`. Do not use `EaglerBinaryTools.jar` on these files.

XZ sections use the **XZ container** format (magic `FD 37 7A 58 5A 00`, LZMA2 inside), not raw LZMA1. Pure-JS LZMA1 libraries (like `lzma-js`) will fail on these.
