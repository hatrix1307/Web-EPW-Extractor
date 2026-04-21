// main.js — App entry point, UI wiring
import { parseEpw } from './epw-reader.js'
import { parseEpk } from './epk-reader.js'
import { buildEpw  } from './epw-writer.js'
import { buildEpk  } from './epk-writer.js'
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
  if (n < 1024)    return `${n} B`
  if (n < 1048576) return `${(n/1024).toFixed(1)} KB`
  return `${(n/1048576).toFixed(2)} MB`
}

function fmtDate(ms) {
  if (!ms) return '—'
  try { return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' }
  catch { return '—' }
}

// ─────────────────────────────────────────────────────────────────────────────
// Log
// ─────────────────────────────────────────────────────────────────────────────

let _logEl = null
function setLogEl(el) { _logEl = el }
function log(msg, type = 'info') {
  if (!_logEl) return
  const line = document.createElement('div')
  line.className = 'log-line'; line.dataset.type = type; line.textContent = msg
  _logEl.appendChild(line); _logEl.scrollTop = _logEl.scrollHeight
}
function logClear() { if (_logEl) _logEl.innerHTML = '' }
function logOk(m)   { log(m, 'ok') }
function logWarn(m) { log(m, 'warn') }
function logErr(m)  { log(m, 'err') }

function autoLog(msg) {
  if (/^(✓|Done|EPK "|extracted)/.test(msg))                           log(msg, 'ok')
  else if (/^(Warning|⚠)/.test(msg))                                   log(msg, 'warn')
  else if (/^(✗|Error|failed)/.test(msg))                              log(msg, 'err')
  else if (/^(Magic|File size|Metadata|Found|Section \[|\s+(PNG|WASM|HTML|JS|TDBG|BLOB|XZ|EPK|Decompressing|Skipping))/.test(msg)) log(msg, 'section')
  else log(msg)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tabs (top-level and compiler sub-tabs)
// ─────────────────────────────────────────────────────────────────────────────

function initTabs() {
  // Top-level tabs
  document.querySelectorAll('.tab-btn[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab
      document.querySelectorAll('.tab-btn[data-tab]').forEach(b => b.classList.toggle('active', b === btn))
      document.querySelectorAll('.tab-panel[id]').forEach(p => p.classList.toggle('active', p.id === target))
      setLogEl(document.getElementById(target === 'tab-extract' ? 'extract-log' : 'compile-log-epw'))
    })
  })

  // Compiler sub-tabs (EPW / EPK)
  document.querySelectorAll('.subtab-btn[data-subtab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.subtab
      document.querySelectorAll('.subtab-btn[data-subtab]').forEach(b => b.classList.toggle('active', b === btn))
      document.querySelectorAll('.subtab-panel[id]').forEach(p => p.classList.toggle('active', p.id === target))
      setLogEl(document.getElementById(
        target === 'subtab-epw' ? 'compile-log-epw' : 'compile-log-epk'
      ))
    })
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// File-type detection from magic bytes
// ─────────────────────────────────────────────────────────────────────────────

function detectFileType(buf) {
  if (buf[0]===0x45&&buf[1]===0x41&&buf[2]===0x47&&buf[3]===0x24&&
      buf[4]===0x57&&buf[5]===0x41&&buf[6]===0x53&&buf[7]===0x4d) return 'epw'
  if (buf[0]===0x45&&buf[1]===0x41&&buf[2]===0x47&&buf[3]===0x50&&
      buf[4]===0x4b&&buf[5]===0x47&&buf[6]===0x24&&buf[7]===0x24) return 'epk'
  return 'unknown'
}

// ─────────────────────────────────────────────────────────────────────────────
// EXTRACTOR TAB
// ─────────────────────────────────────────────────────────────────────────────

let extractedFiles = []

function initExtractor() {
  const dropzone  = document.getElementById('extract-drop')
  const fileInput = document.getElementById('extract-file')
  const btnDlAll  = document.getElementById('btn-download-zip')
  const btnDlSel  = document.getElementById('btn-download-selected')
  const fileList  = document.getElementById('extract-file-list')
  const metaPanel = document.getElementById('extract-meta')
  const filterEl  = document.getElementById('extract-filter')
  const countEl   = document.getElementById('extract-count')

  dropzone.addEventListener('dragover',  e => { e.preventDefault(); dropzone.classList.add('drag-over') })
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'))
  dropzone.addEventListener('drop', e => {
    e.preventDefault(); dropzone.classList.remove('drag-over')
    const f = e.dataTransfer.files[0]; if (f) handleFile(f)
  })
  dropzone.addEventListener('click', () => fileInput.click())
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) handleFile(fileInput.files[0]) })

  filterEl?.addEventListener('input', renderFileList)

  btnDlAll.addEventListener('click', async () => {
    if (!extractedFiles.length) return
    log('Building ZIP archive…')
    const map = {}
    for (const f of extractedFiles) map[f.name] = f.data
    const zip = makeZip(map)
    downloadBlob(zip, 'extracted.zip', 'application/zip')
    logOk(`ZIP download started — ${fmt(zip.length)}`)
  })

  btnDlSel?.addEventListener('click', async () => {
    const checked = [...document.querySelectorAll('.file-row input[type=checkbox]:checked')]
    if (!checked.length) return
    if (checked.length === 1) {
      const f = extractedFiles[+checked[0].dataset.idx]
      return downloadBlob(f.data, f.name.split('/').pop(), f.mimeType)
    }
    const map = {}
    for (const cb of checked) { const f = extractedFiles[+cb.dataset.idx]; map[f.name] = f.data }
    downloadBlob(makeZip(map), 'selection.zip', 'application/zip')
    logOk(`Downloaded ${checked.length} files as ZIP.`)
  })

  async function handleFile(file) {
    logClear(); fileList.innerHTML = ''; metaPanel.innerHTML = ''
    btnDlAll.disabled = true; btnDlSel.disabled = true
    extractedFiles = []; countEl.textContent = ''

    log(`Loading "${file.name}" — ${fmt(file.size)}`)
    dropzone.classList.add('loading')
    dropzone.querySelector('.dz-label').innerHTML = `<strong>Processing…</strong>`

    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const kind  = detectFileType(bytes)

      if (kind === 'epw') {
        await handleEpw(bytes, file.name, metaPanel)
      } else if (kind === 'epk') {
        await handleEpk(bytes, file.name, metaPanel)
      } else {
        throw new Error(`Unrecognised file format. Expected an EPW (EAG$WASM) or EPK (EAGPKG$$) file.`)
      }

      renderFileList()
      if (extractedFiles.length > 0) { btnDlAll.disabled = false; btnDlSel.disabled = false }
      logOk(`Done — ${extractedFiles.length.toLocaleString()} files extracted.`)
    } catch(err) {
      logErr(`Extraction failed: ${err.message}`)
      console.error(err)
    } finally {
      dropzone.classList.remove('loading')
      dropzone.querySelector('.dz-label').innerHTML =
        `<strong>Click or drag</strong> an <code>.epw</code> or <code>.epk</code> file here`
    }
  }

  async function handleEpw(bytes, filename, metaPanel) {
    const { metadata, files } = await parseEpw(bytes, autoLog)
    extractedFiles = files
    metaPanel.innerHTML = `
      <div class="file-type-badge epw-badge">EPW</div>
      <div class="meta-grid">
        <span class="meta-key">Package</span><span class="meta-val">${esc(metadata.packageName||'—')}</span>
        <span class="meta-key">Client</span> <span class="meta-val">${esc(metadata.clientName||'—')}</span>
        <span class="meta-key">Variant</span><span class="meta-val">${esc(metadata.variantId||'—')}</span>
        <span class="meta-key">Author</span> <span class="meta-val">${esc(metadata.authorTag||'—')}</span>
        <span class="meta-key">Files</span>  <span class="meta-val">${files.length.toLocaleString()}</span>
        <span class="meta-key">Size</span>   <span class="meta-val">${fmt(bytes.length)}</span>
      </div>`
  }

  async function handleEpk(bytes, filename, metaPanel) {
    const { epkName, version, timestamp, files } = parseEpk(bytes, autoLog)
    extractedFiles = files
    metaPanel.innerHTML = `
      <div class="file-type-badge epk-badge">EPK</div>
      <div class="meta-grid">
        <span class="meta-key">EPK name</span> <span class="meta-val">${esc(epkName)}</span>
        <span class="meta-key">Version</span>  <span class="meta-val">${esc(version||'—')}</span>
        <span class="meta-key">Built</span>    <span class="meta-val">${fmtDate(timestamp)}</span>
        <span class="meta-key">Files</span>    <span class="meta-val">${files.length.toLocaleString()}</span>
        <span class="meta-key">Size</span>     <span class="meta-val">${fmt(bytes.length)}</span>
      </div>`
  }

  function renderFileList() {
    const query    = filterEl?.value.trim().toLowerCase() ?? ''
    const filtered = query ? extractedFiles.filter(f => f.name.toLowerCase().includes(query)) : extractedFiles

    countEl.textContent = filtered.length !== extractedFiles.length
      ? `${filtered.length.toLocaleString()} / ${extractedFiles.length.toLocaleString()}`
      : `${extractedFiles.length.toLocaleString()} files`

    fileList.innerHTML = ''
    filtered.forEach(f => {
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
// COMPILER — EPW sub-tab
// ─────────────────────────────────────────────────────────────────────────────

const epwInputs = {
  pngFiles: [], bootstrapJs: null, bootstrapWasm: null,
  launcherHtml: null, clientJs: null, clientWasm: null,
  workerWasm: null, tdbgBlob: null,
  assetsFiles: [], langFiles: [],
}

function initEpwCompiler() {
  const slots = [
    { id: 'slot-png',    multi: true,  key: 'pngFiles',      accept: '.png',        isAsset: false },
    { id: 'slot-bjs',    multi: false, key: 'bootstrapJs',   accept: '.js',         isAsset: false },
    { id: 'slot-bwasm',  multi: false, key: 'bootstrapWasm', accept: '.wasm',       isAsset: false },
    { id: 'slot-html',   multi: false, key: 'launcherHtml',  accept: '.html,.htm',  isAsset: false },
    { id: 'slot-cjs',    multi: false, key: 'clientJs',      accept: '.js',         isAsset: false },
    { id: 'slot-cwasm',  multi: false, key: 'clientWasm',    accept: '.wasm',       isAsset: false },
    { id: 'slot-wwasm',  multi: false, key: 'workerWasm',    accept: '.wasm',       isAsset: false },
    { id: 'slot-tdbg',   multi: false, key: 'tdbgBlob',      accept: '.tdbg',       isAsset: false },
    { id: 'slot-assets', multi: true,  key: 'assetsFiles',   accept: '*',           isAsset: true  },
    { id: 'slot-lang',   multi: true,  key: 'langFiles',     accept: '.lang,.json', isAsset: true  },
  ]
  slots.forEach(s => wireSlot(s, epwInputs))

  document.getElementById('btn-compile-epw').addEventListener('click', runEpwCompile)
  document.getElementById('btn-reset-epw')?.addEventListener('click', () => resetInputs(epwInputs, 'compile-log-epw'))
}

async function runEpwCompile() {
  const btn = document.getElementById('btn-compile-epw')
  setLogEl(document.getElementById('compile-log-epw'))
  btn.disabled = true; logClear()

  const meta = {
    packageName: v('meta-package') || 'net.lax1dude.eaglercraft.v1_8.client',
    clientName:  v('meta-client')  || 'Eaglercraft',
    variantId:   v('meta-variant') || 'u0',
    authorTag:   v('meta-author')  || 'EPW-Tools',
  }
  const assetsEpkName = v('meta-assets-epk')   || 'assets.epk'
  const langEpkName   = v('meta-lang-epk')      || 'assets.1.0.epk'
  const outFilename   = v('meta-epw-out')       || 'client.epw'

  const hasXz = epwInputs.launcherHtml || epwInputs.clientJs || epwInputs.clientWasm ||
    epwInputs.workerWasm || epwInputs.tdbgBlob || epwInputs.assetsFiles.length || epwInputs.langFiles.length
  if (hasXz) {
    logWarn('XZ compression runs via /api/xz-compress — deploy to Vercel or run "vercel dev".')
  }

  try {
    log('Starting EPW compilation…')
    const epw = await buildEpw({ metadata: meta, ...epwInputs, assetsEpkName, langEpkName, onLog: autoLog })
    logOk(`EPW ready: ${fmt(epw.length)}`)
    downloadBlob(epw, outFilename, 'application/octet-stream')
    logOk(`Download started: "${outFilename}"`)
  } catch(err) {
    logErr(`EPW compilation failed: ${err.message}`)
    console.error(err)
  } finally { btn.disabled = false }
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPILER — EPK sub-tab
// ─────────────────────────────────────────────────────────────────────────────

const epkInputs = { files: [] }

function initEpkCompiler() {
  wireSlot({ id: 'slot-epk-files', multi: true, key: 'files', accept: '*', isAsset: true }, epkInputs)
  document.getElementById('btn-compile-epk').addEventListener('click', runEpkCompile)
  document.getElementById('btn-reset-epk')?.addEventListener('click', () => resetInputs(epkInputs, 'compile-log-epk'))

  // Also allow dropping an existing EPK to "re-pack" (extract then repack)
  const repackDrop = document.getElementById('slot-epk-repack')
  if (repackDrop) {
    const inp = repackDrop.querySelector('input[type=file]')
    repackDrop.addEventListener('dragover', e => { e.preventDefault(); repackDrop.classList.add('drag-over') })
    repackDrop.addEventListener('dragleave', () => repackDrop.classList.remove('drag-over'))
    repackDrop.addEventListener('drop', e => {
      e.preventDefault(); repackDrop.classList.remove('drag-over')
      if (e.dataTransfer.files[0]) handleEpkRepack(e.dataTransfer.files[0])
    })
    repackDrop.addEventListener('click', () => inp?.click())
    inp?.addEventListener('change', () => { if (inp.files[0]) handleEpkRepack(inp.files[0]) })
  }
}

async function handleEpkRepack(file) {
  setLogEl(document.getElementById('compile-log-epk'))
  logClear()
  log(`Loading EPK "${file.name}" to re-pack…`)
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (detectFileType(bytes) !== 'epk') throw new Error('File is not an EPK (EAGPKG$$ magic required)')
    const { files, epkName } = parseEpk(bytes, autoLog)
    // Strip the dir prefix so paths are relative again
    const stripped = files.map(f => {
      const dir = epkName.replace(/\.epk$/i, '')
      const relName = f.name.startsWith(dir + '/') ? f.name.slice(dir.length + 1) : f.name
      return { name: relName, data: f.data }
    })
    epkInputs.files = stripped
    const badge = document.querySelector('#slot-epk-files .slot-badge')
    if (badge) { badge.textContent = `${stripped.length} files`; badge.classList.add('has-files') }
    document.getElementById('slot-epk-files')?.classList.add('has-files')
    // Pre-fill EPK name
    const nameEl = document.getElementById('meta-epk-name')
    if (nameEl && !nameEl.value) nameEl.value = epkName
    logOk(`Loaded ${stripped.length} files from "${epkName}" — ready to repack.`)
  } catch(err) {
    logErr(`Repack load failed: ${err.message}`)
  }
}

async function runEpkCompile() {
  const btn = document.getElementById('btn-compile-epk')
  setLogEl(document.getElementById('compile-log-epk'))
  btn.disabled = true; logClear()

  const epkName   = v('meta-epk-name')   || 'assets.epk'
  const outFile   = v('meta-epk-out')    || epkName

  if (!epkInputs.files.length) {
    logWarn('No files loaded. Drop asset files into the slot above, or load an existing EPK to repack.')
    btn.disabled = false; return
  }

  try {
    log(`Building EPK "${epkName}" with ${epkInputs.files.length} files…`)
    const epk = buildEpk(epkName, epkInputs.files)
    logOk(`EPK ready: ${fmt(epk.length)}`)
    downloadBlob(epk, outFile, 'application/octet-stream')
    logOk(`Download started: "${outFile}"`)
  } catch(err) {
    logErr(`EPK compilation failed: ${err.message}`)
    console.error(err)
  } finally { btn.disabled = false }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared: slot wiring + reset
// ─────────────────────────────────────────────────────────────────────────────

function wireSlot({ id, multi, key, accept, isAsset }, store) {
  const zone  = document.getElementById(id); if (!zone) return
  const input = zone.querySelector('input[type=file]')
  const badge = zone.querySelector('.slot-badge')
  if (input) { input.multiple = multi; input.accept = accept }

  const setFiles = async (fileList) => {
    const loaded = await Promise.all(Array.from(fileList).map(f =>
      f.arrayBuffer().then(b => ({ name: f.name, data: new Uint8Array(b) }))
    ))

    if (isAsset || Array.isArray(store[key])) {
      store[key] = multi ? (store[key] || []).concat(loaded) : (loaded[0] ? [loaded[0]] : [])
    } else {
      store[key] = loaded[0]?.data ?? null
    }

    const count = Array.isArray(store[key]) ? store[key].length : (store[key] ? 1 : 0)
    if (badge) { badge.textContent = `${count} file${count!==1?'s':''}`; badge.classList.toggle('has-files', count>0) }
    zone.classList.toggle('has-files', count > 0)
  }

  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over') })
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'))
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('drag-over'); if(e.dataTransfer.files.length) setFiles(e.dataTransfer.files) })
  zone.addEventListener('click', () => input?.click())
  input?.addEventListener('change', () => { if(input.files.length) setFiles(input.files) })
}

function resetInputs(store, logId) {
  for (const key of Object.keys(store)) store[key] = Array.isArray(store[key]) ? [] : null
  document.querySelectorAll('.slot').forEach(s => {
    s.classList.remove('has-files')
    const b = s.querySelector('.slot-badge'); if (b) { b.textContent = 'no file'; b.classList.remove('has-files') }
  })
  setLogEl(document.getElementById(logId)); logClear(); log('Inputs reset.')
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function v(id)  { return document.getElementById(id)?.value.trim() ?? '' }
function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }
function iconFor(name) {
  const ext = name.split('.').pop().toLowerCase()
  return ({ png:'🖼', wasm:'⚙', html:'🌐', js:'📜', tdbg:'🐛',
            ogg:'🔊', wav:'🔊', json:'📋', lang:'🔤', mcmeta:'📋',
            vsh:'🎨', fsh:'🎨', glsl:'🎨' })[ext] ?? '📄'
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  setLogEl(document.getElementById('extract-log'))
  initTabs()
  initExtractor()
  initEpwCompiler()
  initEpkCompiler()
})
