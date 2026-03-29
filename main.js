// main.js — App entry point, UI wiring
import { parseEpw } from './epw-reader.js'
import { buildEpw  } from './epw-writer.js'
import { makeZip   } from './compression.js'
import './style.css'

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function downloadBlob(data, filename, mimeType = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([data], { type: mimeType }))
  const a   = Object.assign(document.createElement('a'), { href: url, download: filename })
  document.body.appendChild(a); a.click()
  setTimeout(() => { URL.revokeObjectURL(url); a.remove() }, 1500)
}

function fmt(n) {
  if (n < 1024)        return `${n} B`
  if (n < 1048576)     return `${(n/1024).toFixed(1)} KB`
  return `${(n/1048576).toFixed(2)} MB`
}

// ─────────────────────────────────────────────────────────────────────────────
// Log panel helpers
// ─────────────────────────────────────────────────────────────────────────────

let _logEl = null

function setLogEl(el) { _logEl = el }

function log(msg, type = 'info') {
  if (!_logEl) return
  const line = document.createElement('div')
  line.className = 'log-line'
  line.dataset.type = type
  line.textContent = msg
  _logEl.appendChild(line)
  _logEl.scrollTop = _logEl.scrollHeight
}
function logClear()        { if (_logEl) _logEl.innerHTML = '' }
function logOk(msg)        { log(msg, 'ok') }
function logWarn(msg)      { log(msg, 'warn') }
function logErr(msg)       { log(msg, 'err') }
function logSection(msg)   { log(msg, 'section') }

// ─────────────────────────────────────────────────────────────────────────────
// Tab switching
// ─────────────────────────────────────────────────────────────────────────────

function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn))
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === target))
      // Sync log panel to active tab
      setLogEl(document.getElementById(target === 'tab-extract' ? 'extract-log' : 'compile-log'))
    })
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// EXTRACTOR TAB
// ─────────────────────────────────────────────────────────────────────────────

let extractedFiles = []

function initExtractor() {
  const dropzone   = document.getElementById('extract-drop')
  const fileInput  = document.getElementById('extract-file')
  const btnDlAll   = document.getElementById('btn-download-zip')
  const btnDlSel   = document.getElementById('btn-download-selected')
  const fileList   = document.getElementById('extract-file-list')
  const metaPanel  = document.getElementById('extract-meta')
  const filterEl   = document.getElementById('extract-filter')
  const countEl    = document.getElementById('extract-count')

  // Drag-and-drop
  dropzone.addEventListener('dragover',  e => { e.preventDefault(); dropzone.classList.add('drag-over') })
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'))
  dropzone.addEventListener('drop', e => {
    e.preventDefault(); dropzone.classList.remove('drag-over')
    const f = e.dataTransfer.files[0]; if (f) handleEpwFile(f)
  })
  dropzone.addEventListener('click', () => fileInput.click())
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) handleEpwFile(fileInput.files[0]) })

  // Filter
  filterEl?.addEventListener('input', renderFileList)

  // Download all as ZIP
  btnDlAll.addEventListener('click', async () => {
    if (!extractedFiles.length) return
    log('Building ZIP archive…')
    const map = {}
    for (const f of extractedFiles) map[f.name] = f.data
    const zip = makeZip(map)
    downloadBlob(zip, 'epw_extracted.zip', 'application/zip')
    logOk(`ZIP download started — ${fmt(zip.length)}`)
  })

  // Download selected
  btnDlSel?.addEventListener('click', async () => {
    const checked = [...document.querySelectorAll('.file-row input[type=checkbox]:checked')]
    if (!checked.length) return
    if (checked.length === 1) {
      const f = extractedFiles[+checked[0].dataset.idx]
      downloadBlob(f.data, f.name.split('/').pop(), f.mimeType)
      return
    }
    const map = {}
    for (const cb of checked) {
      const f = extractedFiles[+cb.dataset.idx]; map[f.name] = f.data
    }
    const zip = makeZip(map)
    downloadBlob(zip, 'epw_selection.zip', 'application/zip')
    logOk(`Downloaded ${checked.length} files as ZIP.`)
  })

  async function handleEpwFile(file) {
    logClear(); fileList.innerHTML = ''; metaPanel.innerHTML = ''
    btnDlAll.disabled = true; btnDlSel.disabled = true
    extractedFiles = []
    countEl.textContent = ''

    log(`Loading "${file.name}" — ${fmt(file.size)}`)
    dropzone.classList.add('loading')
    dropzone.querySelector('.dz-label').innerHTML =
      `<strong>Processing…</strong> this may take a moment for large files`

    try {
      const buffer = await file.arrayBuffer()

      const { metadata, files } = await parseEpw(new Uint8Array(buffer), rawLog)
      extractedFiles = files

      // Render metadata
      metaPanel.innerHTML = `
        <div class="meta-grid">
          <span class="meta-key">Package</span><span class="meta-val">${esc(metadata.packageName||'—')}</span>
          <span class="meta-key">Client</span> <span class="meta-val">${esc(metadata.clientName||'—')}</span>
          <span class="meta-key">Variant</span><span class="meta-val">${esc(metadata.variantId||'—')}</span>
          <span class="meta-key">Author</span> <span class="meta-val">${esc(metadata.authorTag||'—')}</span>
          <span class="meta-key">Files</span>  <span class="meta-val">${files.length.toLocaleString()}</span>
          <span class="meta-key">Input</span>  <span class="meta-val">${fmt(buffer.byteLength)}</span>
        </div>`

      renderFileList()

      if (files.length > 0) { btnDlAll.disabled = false; btnDlSel.disabled = false }
      logOk(`Done — ${files.length.toLocaleString()} files extracted from "${file.name}"`)
    } catch(err) {
      logErr(`Extraction failed: ${err.message}`)
      console.error(err)
    } finally {
      dropzone.classList.remove('loading')
      dropzone.querySelector('.dz-label').innerHTML =
        `<strong>Click or drag</strong> another <code>.epw</code> file to re-extract`
    }
  }

  function rawLog(msg) {
    // Map prefix characters to type
    if (msg.startsWith('✓') || msg.startsWith('Done') || msg.startsWith('EPK')) log(msg, 'ok')
    else if (msg.startsWith('Warning') || msg.startsWith('⚠')) log(msg, 'warn')
    else if (msg.startsWith('✗') || msg.startsWith('Error')) log(msg, 'err')
    else if (msg.match(/^(Magic|File size|Metadata|Found|Section \[|XZ|EPK|Decompressing|PNG|WASM|HTML|JS|TDBG|BLOB|Skipping)/)) log(msg, 'section')
    else log(msg)
  }

  function renderFileList() {
    const query = filterEl?.value.trim().toLowerCase() ?? ''
    const filtered = query
      ? extractedFiles.filter(f => f.name.toLowerCase().includes(query))
      : extractedFiles

    countEl.textContent = filtered.length !== extractedFiles.length
      ? `${filtered.length.toLocaleString()} / ${extractedFiles.length.toLocaleString()}`
      : `${extractedFiles.length.toLocaleString()} files`

    fileList.innerHTML = ''
    filtered.forEach((f) => {
      const idx = extractedFiles.indexOf(f)
      const row = document.createElement('div')
      row.className = 'file-row'
      row.innerHTML = `
        <input type="checkbox" class="file-cb" data-idx="${idx}" />
        <span class="file-icon">${iconFor(f.name)}</span>
        <span class="file-name" title="${esc(f.name)}">${esc(f.name)}</span>
        <span class="file-size">${fmt(f.data.length)}</span>
        <button class="btn-dl-single" data-idx="${idx}">Save</button>`
      fileList.appendChild(row)
    })

    fileList.querySelectorAll('.btn-dl-single').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation()
        const f = extractedFiles[+btn.dataset.idx]
        downloadBlob(f.data, f.name.split('/').pop(), f.mimeType)
      })
    })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPILER TAB
// ─────────────────────────────────────────────────────────────────────────────

const compilerInputs = {
  pngFiles: [], bootstrapJs: null, bootstrapWasm: null,
  launcherHtml: null, clientJs: null, clientWasm: null,
  workerWasm: null, tdbgBlob: null,
  assetsFiles: [], langFiles: [],
}

function initCompiler() {
  const slots = [
    { id: 'slot-png',   multi: true,  key: 'pngFiles',      accept: '.png',       label: 'PNG',   hint: 'favicon PNGs' },
    { id: 'slot-bjs',   multi: false, key: 'bootstrapJs',   accept: '.js',        label: 'JS',    hint: 'bootstrap.js (raw)' },
    { id: 'slot-bwasm', multi: false, key: 'bootstrapWasm', accept: '.wasm',      label: 'WASM',  hint: 'bootstrap.wasm (raw)' },
    { id: 'slot-html',  multi: false, key: 'launcherHtml',  accept: '.html,.htm', label: 'HTML',  hint: 'launcher.html → XZ' },
    { id: 'slot-cjs',   multi: false, key: 'clientJs',      accept: '.js',        label: 'JS',    hint: 'client.js → XZ' },
    { id: 'slot-cwasm', multi: false, key: 'clientWasm',    accept: '.wasm',      label: 'WASM',  hint: 'client.wasm → XZ' },
    { id: 'slot-wwasm', multi: false, key: 'workerWasm',    accept: '.wasm',      label: 'WASM',  hint: 'worker.wasm → XZ' },
    { id: 'slot-tdbg',  multi: false, key: 'tdbgBlob',      accept: '.tdbg',      label: 'TDBG',  hint: 'teavm_debug.tdbg → XZ' },
    { id: 'slot-assets',multi: true,  key: 'assetsFiles',   accept: '*',          label: 'FILES', hint: 'asset files → primary EPK → XZ' },
    { id: 'slot-lang',  multi: true,  key: 'langFiles',     accept: '.lang,.json',label: 'FILES', hint: 'lang files → secondary EPK → XZ' },
  ]
  slots.forEach(wireSlot)

  document.getElementById('btn-compile').addEventListener('click', runCompile)
  document.getElementById('btn-reset-compiler')?.addEventListener('click', resetCompiler)
}

function resetCompiler() {
  for (const key of Object.keys(compilerInputs)) {
    compilerInputs[key] = Array.isArray(compilerInputs[key]) ? [] : null
  }
  document.querySelectorAll('.slot').forEach(s => {
    s.classList.remove('has-files')
    const b = s.querySelector('.slot-badge'); if(b) { b.textContent = 'no file'; b.classList.remove('has-files') }
  })
  logClear()
  log('Compiler inputs reset.')
}

async function runCompile() {
  const btn = document.getElementById('btn-compile')
  btn.disabled = true; logClear()

  const meta = {
    packageName: v('meta-package') || 'net.lax1dude.eaglercraft.v1_8.client',
    clientName:  v('meta-client')  || 'Eaglercraft',
    variantId:   v('meta-variant') || 'u0',
    authorTag:   v('meta-author')  || 'EPW-Tools',
  }
  const assetsEpkName  = v('meta-assets-epk')    || 'assets.epk'
  const langEpkName    = v('meta-lang-epk')       || 'assets.1.0.epk'
  const outFilename    = v('meta-out-filename')   || 'client.epw'

  const hasXzSections = compilerInputs.launcherHtml || compilerInputs.clientJs ||
    compilerInputs.clientWasm || compilerInputs.workerWasm || compilerInputs.tdbgBlob ||
    compilerInputs.assetsFiles.length || compilerInputs.langFiles.length

  if (hasXzSections) {
    log('Note: XZ compression uses the /api/xz-compress serverless endpoint.', 'warn')
    log('      Deploy to Vercel or run "vercel dev" locally for compression support.', 'warn')
  }

  try {
    log('Starting EPW compilation…')
    const epw = await buildEpw({
      metadata: meta, ...compilerInputs,
      assetsEpkName, langEpkName,
      onLog: msg => log(msg),
    })
    logOk(`EPW assembled: ${fmt(epw.length)}`)
    downloadBlob(epw, outFilename, 'application/octet-stream')
    logOk(`Download started: "${outFilename}"`)
  } catch(err) {
    logErr(`Compilation failed: ${err.message}`)
    console.error(err)
  } finally {
    btn.disabled = false
  }
}

function wireSlot({ id, multi, key, accept }) {
  const zone  = document.getElementById(id); if (!zone) return
  const input = zone.querySelector('input[type=file]')
  const badge = zone.querySelector('.slot-badge')

  if (input) { input.multiple = multi; input.accept = accept }

  const setFiles = async (fileList) => {
    const arr = Array.from(fileList)
    const loaded = await Promise.all(arr.map(f =>
      f.arrayBuffer().then(b => ({ name: f.name, data: new Uint8Array(b) }))
    ))
    if (multi) compilerInputs[key] = compilerInputs[key].concat(loaded.map(f => f.data ?? f))
    else        compilerInputs[key] = loaded[0]?.data ?? null

    // For assetsFiles/langFiles, keep { name, data } objects
    if (key === 'assetsFiles' || key === 'langFiles') {
      if (multi) {
        const existing = compilerInputs[key].slice(0, compilerInputs[key].length - loaded.length)
        compilerInputs[key] = existing.concat(loaded)
      } else {
        compilerInputs[key] = loaded[0] ? [loaded[0]] : []
      }
    }

    const count = Array.isArray(compilerInputs[key]) ? compilerInputs[key].length : (compilerInputs[key] ? 1 : 0)
    if (badge) {
      badge.textContent = `${count} file${count !== 1 ? 's' : ''}`
      badge.classList.toggle('has-files', count > 0)
    }
    zone.classList.toggle('has-files', count > 0)
  }

  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over') })
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'))
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('drag-over'); if(e.dataTransfer.files.length) setFiles(e.dataTransfer.files) })
  zone.addEventListener('click', () => input?.click())
  input?.addEventListener('change', () => { if(input.files.length) setFiles(input.files) })
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function v(id) { return document.getElementById(id)?.value.trim() ?? '' }
function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }
function iconFor(name) {
  const ext = name.split('.').pop().toLowerCase()
  return ({ png:'🖼', wasm:'⚙', html:'🌐', js:'📜', tdbg:'🐛',
            ogg:'🔊', wav:'🔊', json:'📋', lang:'🔤', mcmeta:'📋',
            vsh:'🎨', fsh:'🎨' })[ext] ?? '📄'
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  setLogEl(document.getElementById('extract-log'))
  initTabs()
  initExtractor()
  initCompiler()
})
