'use strict'

// AstroSharp for macOS: Electron main process.
//
// The Windows build is an Electron 5 shell that starts a bundled copy of R
// ("R-Portable-Win") on a fixed port and points a window at it. This is the
// macOS counterpart. It unpacks the R runtime that ships inside the app (first
// launch only), starts the unmodified Shiny app on a free local port through
// r/launch.R, and shows it in a window. Built without a bundled runtime, it
// looks for an R installed on the Mac instead.

const { app, BrowserWindow, Menu, dialog, shell, screen, ipcMain, powerSaveBlocker } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const net = require('net')
const http = require('http')
const readline = require('readline')
const { spawn, spawnSync } = require('child_process')

const APP_NAME = 'AstroSharp'
const IS_MAC = process.platform === 'darwin'
const SHINY_DIR = path.join(__dirname, 'shiny')
const LAUNCH_R = path.join(__dirname, 'r', 'launch.R')
const TAG = '@@ASTROSHARP@@'
const MIN_R = [4, 1]

// The app carries its own R (a conda-forge R with every package AstroSharp
// needs) as runtime/runtime.tar.gz. It was built for one fixed location, named
// in runtime/runtime.json, and is unpacked there on first launch.
const PAYLOAD_DIR = path.join(__dirname, 'runtime')
const PAYLOAD_ARCHIVE = path.join(PAYLOAD_DIR, 'runtime.tar.gz')

const URLS = {
  r: 'https://cloud.r-project.org/bin/macosx/',
  xquartz: 'https://www.xquartz.org/',
  upstream: 'https://github.com/deepskydetail/AstroSharp',
  donate: 'https://buymeacoffee.com/deepskydetail'
}

app.setName(APP_NAME)

let rscript = null        // { path, version, arch, bundled }
let appFiles = { shiny: SHINY_DIR, launch: LAUNCH_R } // what R runs; see ensureBundledRuntime
let backend = null        // { child, port, ready, exited, error, tail, install }
let splash = null
let splashState = { status: 'Starting\u2026', detail: '', fraction: null }
let mainWindow = null
let quitting = false
let logStream = null
let logFile = null

// ---------------------------------------------------------------- logging ---

function initLog () {
  const dir = app.getPath('logs')
  fs.mkdirSync(dir, { recursive: true })
  logFile = path.join(dir, `${APP_NAME}.log`)
  try {
    if (fs.statSync(logFile).size > 1024 * 1024) fs.renameSync(logFile, logFile + '.old')
  } catch (_) { /* no log yet */ }
  logStream = fs.createWriteStream(logFile, { flags: 'a' })
  log(`--- ${APP_NAME} ${app.getVersion()} starting (Electron ${process.versions.electron}, ${process.platform} ${process.arch}, ${os.release()}) ---`)
}

function log (line) {
  const text = `[${new Date().toISOString()}] ${line}\n`
  if (logStream) logStream.write(text)
  if (!app.isPackaged) process.stdout.write(text)
}

// ----------------------------------------------------------- locating R -----

function rscriptCandidates () {
  const home = os.homedir()
  const list = []
  if (process.env.ASTROSHARP_RSCRIPT) list.push(process.env.ASTROSHARP_RSCRIPT)
  if (IS_MAC) {
    list.push(
      '/Library/Frameworks/R.framework/Resources/bin/Rscript', // installer from CRAN
      '/opt/homebrew/bin/Rscript',                             // Homebrew, Apple Silicon
      '/usr/local/bin/Rscript',                                // Homebrew (Intel), CRAN symlink
      '/opt/local/bin/Rscript',                                // MacPorts
      path.join(home, '.homebrew', 'bin', 'Rscript'),
      path.join(home, 'homebrew', 'bin', 'Rscript')
    )
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) list.push(path.join(dir, 'Rscript'))
  }
  return [...new Set(list)]
}

function probeRscript (file) {
  try { fs.accessSync(file, fs.constants.X_OK) } catch (_) { return null }
  const res = spawnSync(file, ['--vanilla', '-e', 'cat("RVER", R.version$major, R.version$minor, R.version$arch, sep = "|")'],
    { encoding: 'utf8', timeout: 30000 })
  const m = /RVER\|(\d+)\|(\d+)\.(\d+)\|(\S+)/.exec(res.stdout || '')
  if (!m) {
    log(`R probe failed for ${file}: ${(res.stderr || res.error || '').toString().trim().slice(0, 300)}`)
    return null
  }
  return { path: file, version: [Number(m[1]), Number(m[2]), Number(m[3])], arch: m[4] }
}

// A Mac app started from Finder gets a bare PATH, so R installed through
// conda, asdf, rig and the like is invisible to the checks above. Ask the
// user's login shell as a last resort.
function rscriptFromLoginShell () {
  if (!IS_MAC) return null
  const res = spawnSync(process.env.SHELL || '/bin/zsh', ['-lic', 'command -v Rscript'],
    { encoding: 'utf8', timeout: 10000 })
  const line = (res.stdout || '').split('\n').map(s => s.trim()).filter(s => s.startsWith('/')).pop()
  return line || null
}

function versionOk (v) {
  return v[0] > MIN_R[0] || (v[0] === MIN_R[0] && v[1] >= MIN_R[1])
}

// Returns { found, tooOld }: the first usable R, or the newest too-old one.
function findRscript () {
  let tooOld = null
  const candidates = rscriptCandidates()
  const consider = (file) => {
    const info = probeRscript(file)
    if (!info) return null
    log(`found R ${info.version.join('.')} (${info.arch}) at ${file}`)
    if (versionOk(info.version)) return info
    tooOld = tooOld || info
    return null
  }
  for (const file of candidates) {
    const info = consider(file)
    if (info) return { found: info, tooOld }
  }
  const fromShell = rscriptFromLoginShell()
  if (fromShell && !candidates.includes(fromShell)) {
    const info = consider(fromShell)
    if (info) return { found: info, tooOld }
  }
  return { found: null, tooOld }
}

// -------------------------------------------------------- bundled runtime ---

function bundledRuntimeInfo () {
  if (process.env.ASTROSHARP_USE_SYSTEM_R) return null
  let info
  try { info = JSON.parse(fs.readFileSync(path.join(PAYLOAD_DIR, 'runtime.json'), 'utf8')) } catch (_) { return null }
  if (info.platform !== process.platform || info.arch !== process.arch) return null
  if (!fs.existsSync(PAYLOAD_ARCHIVE)) return null
  return info
}

function readStamp (file) {
  try { return fs.readFileSync(file, 'utf8').trim() } catch (_) { return null }
}

function removeLater (dir) {
  fs.promises.rm(dir, { recursive: true, force: true }).catch((err) => log(`could not remove ${dir}: ${err.message}`))
}

function unpackRuntime (info) {
  const partial = `${info.prefix}.partial`
  fs.rmSync(partial, { recursive: true, force: true })
  fs.mkdirSync(partial, { recursive: true })
  return new Promise((resolve, reject) => {
    // The archive is read by this process and fed to tar, so tar itself never
    // has to open a file inside the application bundle.
    const tar = spawn('/usr/bin/tar', ['-xzf', '-', '-C', partial], { stdio: ['pipe', 'ignore', 'pipe'] })
    const total = fs.statSync(PAYLOAD_ARCHIVE).size
    let read = 0
    let lastShown = 0
    let stderr = ''
    const source = fs.createReadStream(PAYLOAD_ARCHIVE)
    source.on('data', (chunk) => {
      read += chunk.length
      if (read - lastShown > total / 100) {
        lastShown = read
        setSplash({ fraction: Math.min(0.98, read / total) })
      }
    })
    source.on('error', reject)
    tar.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000) })
    tar.stdin.on('error', () => { /* tar exited early; its exit code reports why */ })
    tar.on('error', reject)
    tar.on('close', (code) => {
      if (code !== 0) return reject(new Error(`Unpacking R failed (tar exit ${code}). ${stderr.trim()}`))
      try {
        fs.writeFileSync(path.join(partial, '.astrosharp-runtime'), info.id + '\n')
        if (fs.existsSync(info.prefix)) {
          const old = `${info.prefix}.old-${Date.now()}`
          fs.renameSync(info.prefix, old)
          removeLater(old)
        }
        fs.renameSync(partial, info.prefix)
        resolve()
      } catch (err) { reject(err) }
    })
    source.pipe(tar.stdin)
  })
}

// Makes sure the bundled R is unpacked at its fixed location, and that R runs
// the Shiny app from a copy next to it rather than from inside the bundle
// (a bundle kept in Documents or Downloads is behind macOS's privacy prompts
// as far as R, a separate program, is concerned).
async function ensureBundledRuntime (info) {
  const root = path.dirname(info.prefix)
  fs.mkdirSync(root, { recursive: true })
  if (readStamp(path.join(info.prefix, '.astrosharp-runtime')) !== info.id) {
    log(`unpacking bundled R (${info.id}) to ${info.prefix}`)
    setSplash({ status: 'Setting up AstroSharp (first launch only)\u2026', detail: 'Unpacking its copy of R.', fraction: 0 })
    await unpackRuntime(info)
    log('bundled R unpacked')
  }
  const appCopy = path.join(root, 'app')
  if (readStamp(path.join(appCopy, '.astrosharp-app')) !== info.build) {
    setSplash({ status: 'Setting up AstroSharp (first launch only)\u2026', detail: 'Copying the models.', fraction: null })
    const partial = `${appCopy}.partial`
    fs.rmSync(partial, { recursive: true, force: true })
    fs.cpSync(SHINY_DIR, path.join(partial, 'shiny'), { recursive: true })
    fs.cpSync(path.dirname(LAUNCH_R), path.join(partial, 'r'), { recursive: true })
    fs.writeFileSync(path.join(partial, '.astrosharp-app'), info.build + '\n')
    if (fs.existsSync(appCopy)) {
      const old = `${appCopy}.old-${Date.now()}`
      fs.renameSync(appCopy, old)
      removeLater(old)
    }
    fs.renameSync(partial, appCopy)
    log(`app files copied to ${appCopy}`)
  }
  appFiles = { shiny: path.join(appCopy, 'shiny'), launch: path.join(appCopy, 'r', 'launch.R') }
  const file = path.join(info.prefix, 'bin', 'Rscript')
  fs.accessSync(file, fs.constants.X_OK)
  return { path: file, version: String(info.r).split('.').map(Number), arch: info.arch, bundled: true, prefix: info.prefix }
}

// ----------------------------------------------------------------- splash ---

function createSplash () {
  if (splash && !splash.isDestroyed()) return
  splash = new BrowserWindow({
    width: 520,
    height: 330,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    backgroundColor: '#1c1e22',
    title: APP_NAME,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  splash.loadFile(path.join(__dirname, 'splash.html'))
  splash.webContents.on('did-finish-load', () => pushSplash())
  splash.once('ready-to-show', () => splash && splash.show())
  splash.on('closed', () => { splash = null })
}

function pushSplash () {
  if (!splash || splash.isDestroyed() || splash.webContents.isLoading()) return
  const { status, detail, fraction } = splashState
  splash.webContents.executeJavaScript(
    `window.setStatus(${JSON.stringify(status)}, ${JSON.stringify(detail)}, ${fraction === null ? 'null' : fraction})`
  ).catch(() => {})
}

function setSplash (patch) {
  splashState = Object.assign({}, splashState, patch)
  pushSplash()
}

// ---------------------------------------------------------------- backend ---

function getFreePort () {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

// Where the R packages go. Deliberately not "~/Library/Application Support":
// the multicore models start their worker processes through the snow package,
// which refuses to run from a path that contains a space.
function packageLibraryRoot () {
  if (process.env.ASTROSHARP_LIB) return process.env.ASTROSHARP_LIB
  const home = os.homedir()
  if (!IS_MAC) return path.join(home, '.astrosharp', 'R-library')
  if (!/\s/.test(home)) return path.join(home, 'Library', APP_NAME, 'R-library')
  return path.join('/Users/Shared', APP_NAME, os.userInfo().username.replace(/\s+/g, '_'), 'R-library')
}

function backendEnv (port) {
  const env = Object.assign({}, process.env, {
    ASTROSHARP_MODE: 'window',
    ASTROSHARP_APPDIR: appFiles.shiny,
    ASTROSHARP_PORT: String(port),
    ASTROSHARP_PARENT_PID: String(process.pid)
  })
  if (rscript.bundled) {
    // Keep the bundled R to itself: no package folders, profiles or settings
    // from an R that may also be installed on this Mac.
    env.ASTROSHARP_BUNDLED = '1'
    const empty = path.join(path.dirname(appFiles.launch), 'empty')
    env.R_LIBS_USER = path.join(rscript.prefix, 'no-user-library')
    env.R_PROFILE_USER = empty
    env.R_ENVIRON_USER = empty
    for (const name of ['R_HOME', 'RHOME', 'R_LIBS', 'R_LIBS_SITE', 'R_PROFILE', 'R_ENVIRON', 'R_DEFAULT_PACKAGES', 'DYLD_LIBRARY_PATH', 'DYLD_FALLBACK_LIBRARY_PATH']) delete env[name]
  } else {
    env.ASTROSHARP_LIB = packageLibraryRoot()
  }
  // Finder-launched apps have no locale and a minimal PATH.
  if (!env.LANG && !env.LC_ALL) env.LANG = 'en_US.UTF-8'
  if (IS_MAC) {
    const extra = [path.dirname(rscript.path), '/opt/homebrew/bin', '/usr/local/bin', '/opt/X11/bin']
    env.PATH = [...new Set([...extra, ...(env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin').split(':')])].join(':')
  }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

function handleBackendLine (be, line) {
  if (line.startsWith(TAG)) {
    let msg
    try { msg = JSON.parse(line.slice(TAG.length)) } catch (_) { log(`R (unparsed): ${line}`); return }
    log(`R event: ${JSON.stringify(msg)}`)
    if (msg.type === 'status') {
      be.install = null
      setSplash({ status: msg.message, detail: '', fraction: null })
    } else if (msg.type === 'install') {
      be.install = { total: Number(msg.total) || 0, done: 0, installed: 0, fromSource: msg.source === 'TRUE' }
      setSplash({
        status: msg.message,
        detail: be.install.fromSource
          ? 'This copy of R builds packages from source, which can take a long time.'
          : 'This takes a few minutes and needs an internet connection.',
        fraction: 0
      })
    } else if (msg.type === 'error') {
      be.error = msg
    }
    return
  }
  log(`R: ${line}`)
  be.tail.push(line)
  if (be.tail.length > 40) be.tail.shift()
  if (be.install) {
    // install.packages() prints a "trying URL" line per download and, later, one
    // line per package it has unpacked (binary) or built (source).
    const inst = be.install
    const dl = /trying URL '.*\/([^/_']+)_[^/']*'/.exec(line)
    const building = /installing \*source\* package ['\u2018]([^'\u2019]+)['\u2019]/.exec(line)
    const installed = /successfully unpacked|^\* DONE \(/.test(line)
    if (dl) inst.done += 1
    if (installed) inst.installed += 1
    if (dl || building || installed) {
      const total = inst.total || 1
      // Ready-made packages: downloading is the slow part. From source: building is.
      const wDownload = inst.fromSource ? 0.1 : 0.9
      const patch = { fraction: Math.min(0.97, (wDownload * inst.done + (0.97 - wDownload) * inst.installed) / total) }
      if (dl) patch.detail = `Downloading ${dl[1]} (${Math.min(inst.done, total)} of ${total})`
      else if (building) patch.detail = `Building ${building[1]}\u2026`
      else patch.detail = `Installed ${Math.min(inst.installed, total)} of ${total}`
      setSplash(patch)
    }
  }
}

function waitForServer (be) {
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (be.exited) return reject(new Error('The R process exited before the app was ready.'))
      const req = http.get({ host: '127.0.0.1', port: be.port, path: '/', timeout: 3000 }, (res) => {
        res.resume()
        if (res.statusCode === 200) resolve()
        else setTimeout(tick, 400)
      })
      req.on('timeout', () => req.destroy())
      req.on('error', () => setTimeout(tick, 400))
    }
    tick()
  })
}

async function startBackend () {
  const port = await getFreePort()
  log(`starting R backend on port ${port}: ${rscript.path}`)
  const child = spawn(rscript.path, ['--vanilla', appFiles.launch], {
    cwd: os.homedir(),
    env: backendEnv(port),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true // own process group, so R's worker processes can be stopped with it
  })
  const be = { child, port, ready: false, exited: false, error: null, tail: [], install: null }
  backend = be
  for (const stream of [child.stdout, child.stderr]) {
    readline.createInterface({ input: stream }).on('line', (line) => handleBackendLine(be, line))
  }
  child.on('error', (err) => {
    log(`could not start R: ${err.message}`)
    be.exited = true
    be.error = be.error || { code: 'spawn', message: `Could not start R (${rscript.path}): ${err.message}` }
  })
  child.on('exit', (code, signal) => {
    log(`R backend exited (code ${code}, signal ${signal})`)
    be.exited = true
    if (be.onExit) be.onExit()
    if (!quitting && be.ready && backend === be) onBackendCrashed(be)
  })

  try {
    await waitForServer(be)
  } catch (err) {
    if (!quitting && backend === be) await onStartupFailed(be, err)
    return
  }
  be.ready = true
  log(`R backend is ready on http://127.0.0.1:${port}`)
  setSplash({ status: 'Opening AstroSharp\u2026', detail: '', fraction: null })
  showMainWindow(be)
}

function killBackend (be, done) {
  let finished = false
  const finish = () => { if (!finished) { finished = true; if (done) done() } }
  if (!be || be.exited) return finish()
  be.onExit = finish
  const signalGroup = (sig) => {
    try { process.kill(-be.child.pid, sig) } catch (_) {
      try { be.child.kill(sig) } catch (_) { /* already gone */ }
    }
  }
  signalGroup('SIGTERM')
  setTimeout(() => { if (!be.exited) signalGroup('SIGKILL') }, 2000)
  setTimeout(finish, 3000)
}

function restartBackend () {
  const old = backend
  if (old) old.stopping = true
  backend = null
  setBusy(false)
  createSplash()
  setSplash({ status: 'Restarting\u2026', detail: '', fraction: null })
  killBackend(old, () => {
    if (!quitting) startBackend().catch(onFatal)
  })
}

// ---------------------------------------------------------- error dialogs ---

async function messageBox (options) {
  const parent = [mainWindow, splash].find(w => w && !w.isDestroyed() && w.isVisible())
  const opts = Object.assign({ type: 'warning', title: APP_NAME, noLink: true }, options)
  const res = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts)
  return res.response
}

async function showNoRDialog (tooOld) {
  const message = tooOld
    ? `AstroSharp needs R ${MIN_R.join('.')} or newer`
    : 'AstroSharp needs R, which is not installed on this Mac'
  const detail = (tooOld
    ? `Found R ${tooOld.version.join('.')} at ${tooOld.path}, which is too old.\n\n`
    : 'AstroSharp does its image processing in R, a free statistics program.\n\n') +
    'Download the R installer for your Mac from the R project (choose the ' +
    (process.arch === 'arm64' ? 'arm64 / Apple silicon' : 'x86_64 / Intel') +
    ' .pkg file), install it, then open AstroSharp again.\n\n' +
    'AstroSharp also needs XQuartz (xquartz.org), which R uses for the X11 libraries.'
  const choice = await messageBox({ message, detail, buttons: ['Download R', 'Get XQuartz', 'Quit'], defaultId: 0, cancelId: 2 })
  if (choice === 0) await shell.openExternal(URLS.r)
  if (choice === 1) await shell.openExternal(URLS.xquartz)
  app.quit()
}

async function onStartupFailed (be, err) {
  const info = be.error || { code: 'unknown', message: err.message }
  log(`startup failed: ${info.code}: ${info.message}`)
  if (info.code === 'xquartz') {
    const choice = await messageBox({
      message: 'AstroSharp needs XQuartz',
      detail: info.message,
      buttons: ['Download XQuartz', 'Quit'],
      defaultId: 0,
      cancelId: 1
    })
    if (choice === 0) await shell.openExternal(URLS.xquartz)
    return app.quit()
  }
  const tail = be.tail.slice(-12).join('\n')
  const choice = await messageBox({
    type: 'error',
    message: 'AstroSharp could not start',
    detail: info.message + (info.code === 'unknown' && tail ? `\n\nLast messages from R:\n${tail}` : '') +
      `\n\nFull log: ${logFile}`,
    buttons: ['Try Again', 'Show Log', 'Quit'],
    defaultId: 0,
    cancelId: 2
  })
  if (choice === 0) return startBackend().catch(onFatal)
  if (choice === 1) shell.showItemInFolder(logFile)
  app.quit()
}

async function onBackendCrashed (be) {
  setBusy(false)
  const tail = be.tail.slice(-10).join('\n')
  const choice = await messageBox({
    type: 'error',
    message: 'The R process behind AstroSharp stopped unexpectedly',
    detail: (tail ? `Last messages from R:\n${tail}\n\n` : '') +
      'Very large images can run R out of memory; a smaller "Chunk Size" or the Preview mode may help.\n\n' +
      `Full log: ${logFile}`,
    buttons: ['Restart', 'Show Log', 'Quit'],
    defaultId: 0,
    cancelId: 2
  })
  if (choice === 0) return restartBackend()
  if (choice === 1) shell.showItemInFolder(logFile)
  app.quit()
}

function onFatal (err) {
  log(`fatal: ${err && err.stack ? err.stack : err}`)
  dialog.showErrorBox(APP_NAME, `${err && err.message ? err.message : err}\n\nLog: ${logFile}`)
  app.quit()
}

// ------------------------------------------------------------ main window ---

function isAppUrl (url, be) {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.port === String(be.port)
  } catch (_) { return false }
}

function showMainWindow (be) {
  const url = `http://127.0.0.1:${be.port}/`
  if (mainWindow && !mainWindow.isDestroyed()) {
    // Reusing the window after a backend restart.
    mainWindow.appBackend = be
    mainWindow.loadURL(url)
    if (splash) splash.close()
    return
  }
  const area = screen.getPrimaryDisplay().workAreaSize
  mainWindow = new BrowserWindow({
    width: Math.min(1500, area.width),
    height: Math.min(1020, area.height),
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#222222', // the app's "darkly" theme
    title: APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  mainWindow.appBackend = be
  const wc = mainWindow.webContents

  // The window only ever shows the local Shiny app; anything else opens in the browser.
  wc.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url, mainWindow.appBackend)) wc.downloadURL(url)
    else if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  wc.on('will-navigate', (event, url) => {
    if (isAppUrl(url, mainWindow.appBackend)) return
    event.preventDefault()
    if (/^https?:/i.test(url)) shell.openExternal(url)
  })

  wc.session.on('will-download', (event, item) => {
    const name = item.getFilename() || 'Processed.tif'
    item.setSaveDialogOptions({
      title: 'Save processed image',
      defaultPath: path.join(app.getPath('downloads'), name),
      filters: /\.tiff?$/i.test(name) ? [{ name: 'TIFF image', extensions: ['tif', 'tiff'] }] : []
    })
    item.once('done', (e, state) => {
      log(`download ${state}: ${item.getSavePath() || name}`)
      if (state === 'completed') {
        if (IS_MAC) app.dock.downloadFinished(item.getSavePath())
      } else if (state === 'interrupted') {
        messageBox({
          message: 'The processed image could not be saved',
          detail: 'R did not produce a file. Choose a TIFF, press "Update Sliders" and wait for "Your Processed Image" to appear before downloading.',
          buttons: ['OK']
        })
      }
    })
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    if (splash) splash.close()
  })
  mainWindow.on('closed', () => {
    mainWindow = null
    setBusy(false)
    if (!quitting) app.quit() // like the Windows build: closing the window ends the app
  })
  mainWindow.loadURL(url)
}

// Reload the page (the R session behind it starts fresh, like a browser refresh).
function reloadApp () {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (backend && backend.ready && !backend.exited) mainWindow.webContents.reload()
  else restartBackend()
}

// ------------------------------------------------- busy state (see preload) ---

// While R is working (which can take a long time on a full-size image) keep
// macOS from idle-sleeping or napping the app, and nudge the Dock when a long
// job finishes in the background.
let blockerId = null
let busySince = null
let idleTimer = null

function setBusy (busy) {
  clearTimeout(idleTimer)
  if (busy) {
    if (blockerId === null) {
      blockerId = powerSaveBlocker.start('prevent-app-suspension')
      busySince = Date.now()
      log('R is busy; keeping the system awake')
    }
    return
  }
  if (blockerId === null) return
  idleTimer = setTimeout(() => {
    powerSaveBlocker.stop(blockerId)
    blockerId = null
    const longJob = busySince && Date.now() - busySince > 20000
    log(`R is idle again after ${Math.round((Date.now() - (busySince || Date.now())) / 1000)}s`)
    busySince = null
    if (IS_MAC && longJob && mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
      app.dock.bounce('informational')
    }
  }, 1500)
}

let lastAutoReload = 0

ipcMain.on('astrosharp:busy', (event, busy) => {
  if (mainWindow && event.sender === mainWindow.webContents) setBusy(!!busy)
})

// Shiny greys the page out when its connection drops (typically after the Mac
// has been asleep). R is still running, so just reconnect.
ipcMain.on('astrosharp:disconnected', (event) => {
  if (quitting || !mainWindow || event.sender !== mainWindow.webContents) return
  if (!backend || !backend.ready || backend.exited || backend.stopping) return // quitting, restarting or crashed
  if (Date.now() - lastAutoReload < 10000) return
  lastAutoReload = Date.now()
  log('page lost its connection to R; reloading')
  mainWindow.webContents.reload()
})

// ------------------------------------------------------------------- menu ---

function buildMenu () {
  const template = [
    ...(IS_MAC ? [{
      label: APP_NAME,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    { label: 'File', submenu: [IS_MAC ? { role: 'close' } : { role: 'quit' }] },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: reloadApp },
        { label: 'Restart R', click: () => { if (mainWindow || backend) restartBackend() } },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' }
      ]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'AstroSharp on GitHub', click: () => shell.openExternal(URLS.upstream) },
        { label: 'Support Deep Sky Detail', click: () => shell.openExternal(URLS.donate) },
        { type: 'separator' },
        { label: 'Show Log File', click: () => shell.showItemInFolder(logFile) },
        {
          label: 'Show R Package Folder',
          click: () => {
            const dir = rscript && rscript.bundled ? path.join(rscript.prefix, 'lib', 'R', 'library') : packageLibraryRoot()
            fs.mkdirSync(dir, { recursive: true })
            shell.openPath(dir)
          }
        }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// -------------------------------------------------------------- lifecycle ---

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = mainWindow || splash
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })

  app.whenReady().then(async () => {
    initLog()
    buildMenu()
    app.setAboutPanelOptions({
      applicationName: APP_NAME,
      applicationVersion: app.getVersion(),
      credits: 'Astronomical sharpening tool by Deep Sky Detail.\nmacOS build of github.com/deepskydetail/AstroSharp.',
      copyright: 'MIT License'
    })
    createSplash()

    const bundled = bundledRuntimeInfo()
    if (bundled) {
      try {
        rscript = await ensureBundledRuntime(bundled)
      } catch (err) {
        log(`bundled R could not be set up: ${err && err.stack ? err.stack : err}`)
        await messageBox({
          type: 'error',
          message: 'AstroSharp could not set up its copy of R',
          detail: `${err.message}\n\nAstroSharp unpacks R into ${path.dirname(bundled.prefix)}. Check that this folder can be written to and that the disk has about 1 GB free, then open AstroSharp again.\n\nFull log: ${logFile}`,
          buttons: ['Quit']
        })
        return app.quit()
      }
      log(`using bundled R ${bundled.r} at ${rscript.path}`)
    } else {
      setSplash({ status: 'Looking for R\u2026' })
      const { found, tooOld } = findRscript()
      if (!found) {
        log(tooOld ? 'only an outdated R was found' : 'R was not found')
        return showNoRDialog(tooOld)
      }
      rscript = found
      log(`using R ${found.version.join('.')} (${found.arch}) at ${found.path}`)
    }
    await startBackend()
  }).catch(onFatal)

  app.on('window-all-closed', () => {
    if (!quitting) app.quit()
  })

  app.on('before-quit', (event) => {
    quitting = true
    const be = backend
    if (be && !be.exited && !be.stopping) {
      be.stopping = true
      event.preventDefault()
      killBackend(be, () => app.quit())
    }
  })

  app.on('will-quit', () => {
    if (logStream) { log('quit'); logStream.end() }
  })
}
