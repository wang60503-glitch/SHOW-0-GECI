const startupFs = require("fs")
const startupPath = require("path")

function startupLogPath() {
  const candidates = [
    process.env.APPDATA ? startupPath.join(process.env.APPDATA, "SHOW-0", "logs", "startup.log") : null,
    startupPath.join(process.env.TEMP || process.cwd(), "SHOW-0", "startup.log"),
  ].filter(Boolean)

  for (const candidate of candidates) {
    try {
      startupFs.mkdirSync(startupPath.dirname(candidate), { recursive: true })
      startupFs.appendFileSync(candidate, "", "utf8")
      return candidate
    } catch (_error) {}
  }
  return null
}

const startupDiagnosticsPath = startupLogPath()

function startupLog(message, details) {
  if (!startupDiagnosticsPath) return
  try {
    const payload = details === undefined ? "" : ` ${JSON.stringify(details)}`
    startupFs.appendFileSync(startupDiagnosticsPath, `${new Date().toISOString()} ${message}${payload}\n`, "utf8")
  } catch (_error) {}
}

startupLog("electron-main-reached", {
  cwd: process.cwd(),
  execPath: process.execPath,
  argv: process.argv,
  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE || "",
})

process.on("uncaughtException", (error) => {
  startupLog("uncaughtException", { message: error?.message, stack: error?.stack })
})

process.on("unhandledRejection", (reason) => {
  startupLog("unhandledRejection", {
    message: reason?.message || String(reason),
    stack: reason?.stack,
  })
})

const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require("electron")
const { execFileSync, spawn } = require("child_process")
const fs = require("fs")
const path = require("path")
const { fileURLToPath, pathToFileURL } = require("url")
const { setupKugouIpc } = require("./kugou-ipc.cjs")
const { setupShow0ConfigIpc } = require("./show0-config-ipc.cjs")
const { setupLibraryIpc } = require("./library-ipc.cjs")
const { generateSongWaveforms, readSongWaveforms, updateSongPackage } = require("./song-package-update.cjs")

const isDev = !app.isPackaged
const devServerUrl = process.env.SHOW0_DEV_SERVER_URL || "http://localhost:3000"
let mainWindow = null
let desktopLyricsWindow = null
let dataMigrationInProgress = false
let desktopLyricsPayload = {
  rewriteMode: false,
  usedRewriteLyrics: false,
  lines: [],
  currentLineIndex: 0,
  message: "",
}
const PLAY_MIN_SIZE = { width: 1040, height: 630 }
const PLAY_DEFAULT_SIZE = { width: 1360, height: 760 }
const CREATE_SIZE = { width: 1180, height: 850 }
const DESKTOP_LYRICS_SIZE = { width: 514, height: 331 }
const DESKTOP_LYRICS_MIN_SIZE = { width: 508, height: 107 }
const GATE_TRACK_TYPES = ["accompaniment", "ai_vocal", "mic_wet", "mic_dry", "reverb"]

function gateControlRootDir() {
  const appData = process.env.APPDATA || app.getPath("userData")
  return path.join(appData, "SHOW-0")
}

function gateControlFilePath() {
  return path.join(gateControlRootDir(), "gate-control.json")
}

function gateStatusDirPath() {
  return path.join(gateControlRootDir(), "gate-status")
}

function defaultGateTrackState(trackType) {
  return {
    trackType,
    gateOpen: true,
    levelPercent: 100,
    reverbLevelPercent: trackType === "reverb" ? 100 : undefined,
    updatedAt: "",
  }
}

function normalizeGateTrackState(trackType, value = {}) {
  const base = defaultGateTrackState(trackType)
  const gateOpen = value.gateOpen
  const levelPercent = Math.max(0, Math.min(100, Number(value.levelPercent ?? base.levelPercent) || 0))
  const reverbLevelPercent = Math.max(0, Math.min(100, Number(value.reverbLevelPercent ?? value.levelPercent ?? base.reverbLevelPercent ?? 100) || 0))
  return {
    ...base,
    ...value,
    trackType,
    gateOpen: gateOpen === undefined ? base.gateOpen : Boolean(gateOpen),
    levelPercent,
    reverbLevelPercent: trackType === "reverb" ? reverbLevelPercent : undefined,
    updatedAt: String(value.updatedAt || ""),
  }
}

function defaultGateControlState() {
  const tracks = Object.fromEntries(GATE_TRACK_TYPES.map((trackType) => [trackType, defaultGateTrackState(trackType)]))
  return {
    version: 1,
    source: "SHOW-0",
    updatedAt: "",
    tracks,
  }
}

function readGateControlState() {
  const filePath = gateControlFilePath()
  const existing = safeJson(filePath) || {}
  const now = new Date().toISOString()
  const tracks = {}
  for (const trackType of GATE_TRACK_TYPES) {
    tracks[trackType] = normalizeGateTrackState(trackType, existing.tracks?.[trackType] || {})
  }
  return {
    ...defaultGateControlState(),
    ...existing,
    version: 1,
    updatedAt: String(existing.updatedAt || now),
    path: filePath,
    tracks,
  }
}

function writeGateControlState(payload = {}) {
  const current = readGateControlState()
  const now = new Date().toISOString()
  const tracks = { ...current.tracks }
  for (const trackType of GATE_TRACK_TYPES) {
    const nextTrack = payload.tracks?.[trackType]
    tracks[trackType] = normalizeGateTrackState(trackType, {
      ...tracks[trackType],
      ...(nextTrack || {}),
      updatedAt: nextTrack ? now : tracks[trackType]?.updatedAt,
    })
  }
  const next = {
    version: 1,
    source: String(payload.source || "SHOW-0"),
    updatedAt: now,
    tracks,
  }
  const filePath = gateControlFilePath()
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8")
  return { ok: true, path: filePath, state: { ...next, path: filePath } }
}

function readGatePluginStatus() {
  const statusDir = gateStatusDirPath()
  const now = Date.now()
  const instances = []
  try {
    if (fs.existsSync(statusDir)) {
      for (const entry of fs.readdirSync(statusDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue
        const statusPath = path.join(statusDir, entry.name)
        const status = safeJson(statusPath)
        if (!status) continue
        const updatedAtMs = Number(status.updatedAtMs || 0)
        const ageMs = Number.isFinite(updatedAtMs) && updatedAtMs > 0 ? now - updatedAtMs : now - fs.statSync(statusPath).mtimeMs
        if (ageMs > 5000) continue
        instances.push({ ...status, path: statusPath, ageMs: Math.max(0, Math.round(ageMs)) })
      }
    }
  } catch (_error) {}
  instances.sort((a, b) => String(a.trackType || "").localeCompare(String(b.trackType || "")))
  return { ok: true, connected: instances.length > 0, statusDir, instances }
}

app.disableHardwareAcceleration()
app.commandLine.appendSwitch("no-sandbox")
app.commandLine.appendSwitch("disable-gpu")
app.commandLine.appendSwitch("disable-gpu-compositing")
app.commandLine.appendSwitch("disable-gpu-rasterization")
app.commandLine.appendSwitch("disable-gpu-sandbox")
app.commandLine.appendSwitch("disable-accelerated-2d-canvas")
app.commandLine.appendSwitch("disable-accelerated-video-decode")
app.commandLine.appendSwitch("disable-software-rasterizer")
app.commandLine.appendSwitch("use-gl", "disabled")
app.commandLine.appendSwitch("disable-features", "VizDisplayCompositor,UseSkiaRenderer")
app.on("render-process-gone", (_event, webContents, details) => {
  startupLog("render-process-gone", {
    reason: details?.reason,
    exitCode: details?.exitCode,
    url: webContents?.getURL ? webContents.getURL() : "",
  })
})
app.on("child-process-gone", (_event, details) => {
  startupLog("child-process-gone", details)
})
try {
  app.setPath("userData", isDev ? path.join(__dirname, "..", ".electron-user-data") : path.join(path.dirname(process.execPath), "user-data"))
} catch (_error) {
  // Keep default Electron path if the optimized host blocks custom userData.
}

function log(message) {
  if (isDev) {
    console.log(message)
    return
  }
  try {
    fs.appendFileSync(path.join(path.dirname(process.execPath), "show0-electron.log"), `${new Date().toISOString()} ${message}\n`)
  } catch (_error) {
    // Logging must never prevent app startup.
  }
}

function windowStatePath() {
  return path.join(app.getPath("userData"), "window-state.json")
}

function readWindowState() {
  try {
    const filePath = windowStatePath()
    if (!fs.existsSync(filePath)) return null
    const state = JSON.parse(fs.readFileSync(filePath, "utf8"))
    const bounds = state && typeof state === "object" ? state.bounds : null
    if (!bounds || typeof bounds !== "object") return null
    const width = Math.max(PLAY_MIN_SIZE.width, Number(bounds.width) || PLAY_DEFAULT_SIZE.width)
    const height = Math.max(PLAY_MIN_SIZE.height, Number(bounds.height) || PLAY_DEFAULT_SIZE.height)
    const x = Number.isFinite(Number(bounds.x)) ? Number(bounds.x) : undefined
    const y = Number.isFinite(Number(bounds.y)) ? Number(bounds.y) : undefined
    return {
      bounds: { x, y, width, height },
      maximized: Boolean(state.maximized),
    }
  } catch (_error) {
    return null
  }
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true })
    const state = {
      bounds: mainWindow.isMaximized() ? mainWindow.getNormalBounds() : mainWindow.getBounds(),
      maximized: mainWindow.isMaximized(),
    }
    fs.writeFileSync(windowStatePath(), `${JSON.stringify(state, null, 2)}\n`, "utf8")
  } catch (_error) {
    // Window state persistence must never block app shutdown.
  }
}

function createWindow() {
  startupLog("createWindow-start")
  log(`createWindow packaged=${app.isPackaged} dirname=${__dirname}`)
  const savedWindowState = readWindowState()
  const savedBounds = savedWindowState?.bounds
  mainWindow = new BrowserWindow({
    title: "SHOW-0",
    x: savedBounds?.x,
    y: savedBounds?.y,
    width: savedBounds?.width ?? PLAY_DEFAULT_SIZE.width,
    height: savedBounds?.height ?? PLAY_DEFAULT_SIZE.height,
    minWidth: PLAY_MIN_SIZE.width,
    minHeight: PLAY_MIN_SIZE.height,
    center: !savedBounds,
    backgroundColor: "#061120",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  startupLog("BrowserWindow-created", {
    bounds: mainWindow.getBounds(),
    visible: mainWindow.isVisible(),
  })

  Menu.setApplicationMenu(null)

  if (savedWindowState?.maximized) {
    mainWindow.maximize()
  }

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    startupLog("did-fail-load", { errorCode, errorDescription, validatedURL })
    log(`SHOW-0 failed to load ${validatedURL}: ${errorCode} ${errorDescription}`)
  })

  mainWindow.webContents.on("did-finish-load", () => {
    startupLog("did-finish-load", {
      url: mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.getURL() : "",
    })
    log("SHOW-0 finished load")
  })

  mainWindow.on("close", (event) => {
    startupLog("mainWindow-close", { dataMigrationInProgress })
    if (dataMigrationInProgress) {
      event.preventDefault()
      dialog.showMessageBox(mainWindow, {
        type: "warning",
        title: "数据迁移进行中",
        message: "正在迁移歌曲数据，请勿关闭软件。",
        detail: "数据迁移时禁止关闭软件、移动数据目录或断开磁盘，以免破坏数据。",
        buttons: ["知道了"],
      }).catch(() => {})
      return
    }
    saveWindowState()
  })

  mainWindow.on("closed", () => {
    startupLog("mainWindow-closed")
    log("SHOW-0 window closed")
    if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) {
      desktopLyricsWindow.close()
    }
    mainWindow = null
  })

  if (isDev) {
    log(`loadURL ${devServerUrl}`)
    startupLog("loadURL", { url: devServerUrl })
    mainWindow.loadURL(devServerUrl)
  } else {
    const indexPath = path.join(__dirname, "..", "out", "index.html")
    log(`loadFile ${indexPath} exists=${fs.existsSync(indexPath)}`)
    startupLog("loadFile", { indexPath, exists: fs.existsSync(indexPath) })
    mainWindow.loadFile(indexPath)
  }
}

function loadRoute(window, route) {
  if (isDev) {
    const base = devServerUrl.endsWith("/") ? devServerUrl : `${devServerUrl}/`
    window.loadURL(new URL(route, base).toString())
    return
  }

  const routePath = route.replace(/^\/+/, "")
  if (!routePath) {
    window.loadFile(path.join(__dirname, "..", "out", "index.html"))
    return
  }

  const htmlPath = path.join(__dirname, "..", "out", `${routePath}.html`)
  const indexPath = path.join(__dirname, "..", "out", routePath, "index.html")
  window.loadFile(fs.existsSync(htmlPath) ? htmlPath : indexPath)
}

function sendDesktopLyricsState(open) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send("show0:desktop-lyrics-state", { open })
}

function sendDesktopLyricsPayload() {
  if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) {
    desktopLyricsWindow.webContents.send("show0:desktop-lyrics-payload", desktopLyricsPayload)
  }
}

function safeJson(filePath) {
  try {
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) : null
  } catch (_error) {
    return null
  }
}

function ensurePackageDir(packageDir) {
  const resolved = path.resolve(String(packageDir || ""))
  if (!resolved || !fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error("Song package directory is not available.")
  }
  return resolved
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8")
}

function normalizeMatchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[-_()[\]{}【】（）·.,，。!！?？\s]+/g, "")
}

function safePackageAssetName(name) {
  return safePackageFileName(name).replace(/\.+$/g, "")
}

function walkFilesByExt(rootDir, extensions, maxDepth = 4, maxFiles = 3000) {
  const files = []
  const supported = new Set(extensions.map((item) => item.toLowerCase()))

  function walk(currentDir, depth) {
    if (depth > maxDepth || files.length >= maxFiles) return
    let entries = []
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true })
    } catch (_error) {
      return
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1)
        continue
      }
      if (!entry.isFile() || !supported.has(path.extname(entry.name).toLowerCase())) continue
      files.push({ name: entry.name, path: fullPath })
      if (files.length >= maxFiles) return
    }
  }

  if (rootDir && fs.existsSync(rootDir)) walk(rootDir, 0)
  return files
}

function scoreKrcCandidate(candidate, songInfo, kugouMusicDir) {
  const fileName = normalizeMatchText(candidate.name)
  const artist = normalizeMatchText(songInfo.artist)
  const title = normalizeMatchText(songInfo.title)
  const displayName = normalizeMatchText(songInfo.displayName)
  const audioName = normalizeMatchText(songInfo.audioFileName)
  let confidence = 0
  let matchReason = "no-match"

  if (artist && title && fileName.includes(artist) && fileName.includes(title)) {
    confidence = 0.95
    matchReason = "artist+title"
  } else if (displayName && fileName.includes(displayName)) {
    confidence = 0.9
    matchReason = "displayName"
  } else if (title && fileName.includes(title)) {
    confidence = 0.75
    matchReason = "title"
  } else if (audioName && fileName.includes(audioName)) {
    confidence = 0.72
    matchReason = "audio-file-name"
  } else if (title) {
    const keywords = title.split(/[^\p{L}\p{N}]+/u).map(normalizeMatchText).filter((item) => item.length >= 2)
    const hits = keywords.filter((keyword) => fileName.includes(keyword))
    if (hits.length) {
      confidence = Math.min(0.68, 0.42 + hits.length * 0.08)
      matchReason = "title-keywords"
    }
  }

  if (confidence > 0 && kugouMusicDir && audioName) {
    const audioCandidates = walkFilesByExt(kugouMusicDir, [".kgma", ".kgm", ".kgg", ".mp3", ".wav", ".flac", ".m4a"], 2, 300)
    if (audioCandidates.some((item) => normalizeMatchText(item.name).includes(audioName) || fileName.includes(normalizeMatchText(item.name)))) {
      confidence = Math.min(0.99, confidence + 0.03)
      matchReason += "+audio-dir"
    }
  }

  return { ...candidate, confidence, matchReason }
}

function parseTimestampMs(raw) {
  const match = String(raw || "").match(/(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?/)
  if (!match) return 0
  const minutes = Number(match[1]) || 0
  const seconds = Number(match[2]) || 0
  const fraction = String(match[3] || "0").padEnd(3, "0").slice(0, 3)
  return minutes * 60000 + seconds * 1000 + (Number(fraction) || 0)
}

function parsePlainKrcText(rawText) {
  const text = String(rawText || "").replace(/\r/g, "")
  const lines = []
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim()
    if (!line) continue
    const lrcMatch = line.match(/^\[(\d{1,2}:\d{2}(?:[.:]\d{1,3})?)\](.+)$/)
    if (lrcMatch) {
      const lyricText = lrcMatch[2].replace(/<[^>]+>/g, "").trim()
      if (lyricText) lines.push({ timeMs: parseTimestampMs(lrcMatch[1]), durationMs: 0, text: lyricText })
      continue
    }
    const krcMatch = line.match(/^\[(\d+),(\d+)\](.+)$/)
    if (krcMatch) {
      const lyricText = krcMatch[3].replace(/<[^>]+>/g, "").trim()
      if (lyricText) lines.push({ timeMs: Number(krcMatch[1]) || 0, durationMs: Number(krcMatch[2]) || 0, text: lyricText })
    }
  }
  return lines.sort((a, b) => a.timeMs - b.timeMs)
}

function linesToLrc(lines) {
  return lines.map((line) => {
    const totalSeconds = Math.max(0, Math.floor(line.timeMs / 1000))
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    const centiseconds = Math.floor((line.timeMs % 1000) / 10)
    return `[${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}]${line.text}`
  }).join("\n")
}

function writeLyricImportReport(packageDir, report) {
  const jsonPath = path.join(packageDir, "lyric-import-report.json")
  const mdPath = path.join(packageDir, "lyric-import-report.md")
  writeJson(jsonPath, report)
  const lines = [
    "# SHOW-0 Lyric Import Report",
    "",
    `- Source attempted: ${report.lyricSourceAttempted}`,
    `- KRC search dir: ${report.krcSearchDir || "none"}`,
    `- Selected KRC: ${report.selectedKrcCandidate?.name || "none"}`,
    `- Confidence: ${report.selectedKrcConfidence ?? 0}`,
    `- Match reason: ${report.matchReason || "none"}`,
    `- KRC parse status: ${report.krcParseStatus}`,
    `- Generated lyrics json: ${report.generatedLyricsJson || "none"}`,
    `- Generated lrc: ${report.generatedLrc || "none"}`,
    `- Fallback used: ${report.fallbackUsed}`,
    `- Fallback reason: ${report.fallbackReason || "none"}`,
    "",
    "## Warnings",
    ...((report.warnings || []).length ? report.warnings.map((item) => `- ${item}`) : ["- none"]),
    "",
    "## Errors",
    ...((report.errors || []).length ? report.errors.map((item) => `- ${item}`) : ["- none"]),
  ]
  fs.writeFileSync(mdPath, `${lines.join("\n")}\n`, "utf8")
  return { jsonPath, mdPath }
}

function importKugouKrcLyrics(payload) {
  const errors = []
  const warnings = []
  const packageDir = ensurePackageDir(payload?.songPackageDir)
  const manifestPath = path.join(packageDir, "manifest.json")
  const manifest = safeJson(manifestPath) || {}
  const songInfo = {
    artist: String(payload?.artist || manifest.artist || ""),
    title: String(payload?.title || manifest.title || path.basename(packageDir)),
    displayName: String(payload?.displayName || manifest.displayName || [manifest.artist, manifest.title].filter(Boolean).join(" - ") || path.basename(packageDir)),
    audioFileName: String(payload?.audioFileName || ""),
  }
  const baseName = safePackageAssetName(songInfo.displayName || `${songInfo.artist} - ${songInfo.title}`)
  const lyricsJsonName = `${baseName}.lyrics.json`
  const lrcName = `${baseName}.lrc`
  const lyricsJsonPath = path.join(packageDir, lyricsJsonName)
  const lrcPath = path.join(packageDir, lrcName)
  const force = Boolean(payload?.force)

  const existingLyrics = [
    manifest.lyrics?.json,
    manifest.lyrics?.lrc,
    fs.existsSync(lyricsJsonPath) ? lyricsJsonName : "",
    fs.existsSync(lrcPath) ? lrcName : "",
  ].filter(Boolean)
  if (existingLyrics.length && !force) {
    return { ok: false, needsOverwrite: true, message: "SHOW-0 lyric file already exists.", existingLyrics }
  }

  const krcSearchDir = String(payload?.kugouLyricDir || "").trim()
  const candidates = walkFilesByExt(krcSearchDir, [".krc"], 4, 3000)
    .map((candidate) => scoreKrcCandidate(candidate, songInfo, String(payload?.kugouMusicDir || "")))
    .filter((candidate) => candidate.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence)
  const selected = candidates[0] || null
  const report = {
    timestamp: new Date().toISOString(),
    lyricSourceAttempted: "kugou-krc-import",
    krcSearchDir,
    krcCandidates: candidates.slice(0, 20).map((candidate) => ({ name: candidate.name, confidence: candidate.confidence, matchReason: candidate.matchReason })),
    selectedKrcCandidate: selected ? { name: selected.name } : null,
    selectedKrcConfidence: selected?.confidence || 0,
    matchReason: selected?.matchReason || "",
    krcParseStatus: "not-attempted",
    generatedLyricsJson: "",
    generatedLrc: "",
    fallbackUsed: false,
    fallbackReason: "",
    errors,
    warnings,
  }

  let lines = []
  if (!krcSearchDir || !fs.existsSync(krcSearchDir)) {
    report.fallbackUsed = true
    report.fallbackReason = "kugouLyricDir is not configured or does not exist"
    warnings.push(report.fallbackReason)
  } else if (!selected) {
    report.fallbackUsed = true
    report.fallbackReason = "no matched KRC candidate"
    warnings.push(report.fallbackReason)
  } else if (selected.confidence < 0.7) {
    report.fallbackUsed = true
    report.fallbackReason = "matched KRC confidence is too low"
    warnings.push(report.fallbackReason)
  } else {
    try {
      const rawBuffer = fs.readFileSync(selected.path)
      const plainText = rawBuffer.toString("utf8")
      lines = parsePlainKrcText(plainText)
      report.krcParseStatus = lines.length ? "parsed-plain-text" : "unsupported-or-encrypted-krc"
      if (!lines.length) {
        report.fallbackUsed = true
        report.fallbackReason = "KRC decode is not available for this file; fallback LRC generated"
        warnings.push(report.fallbackReason)
      }
    } catch (error) {
      report.krcParseStatus = "read-failed"
      report.fallbackUsed = true
      report.fallbackReason = error.message
      errors.push(error.message)
    }
  }

  if (!lines.length) {
    const fallbackText = `[00:00.00]${songInfo.displayName || songInfo.title}\n[00:05.00]KRC 不可用，已生成 SHOW-0 LRC 占位歌词`
    lines = parsePlainKrcText(fallbackText)
  }

  const lyricJson = {
    version: "1.0.0",
    source: report.fallbackUsed ? "audio-transcription-lrc-fallback" : "kugou-krc-import",
    importedAt: report.timestamp,
    lines,
  }
  writeJson(lyricsJsonPath, lyricJson)
  fs.writeFileSync(lrcPath, `${linesToLrc(lines)}\n`, "utf8")
  report.generatedLyricsJson = lyricsJsonName
  report.generatedLrc = lrcName

  const now = new Date().toISOString()
  manifest.packageVersion = manifest.packageVersion || "1.0.0"
  manifest.songId = manifest.songId || safePackageAssetName(path.basename(packageDir)).toLowerCase().replace(/[^a-z0-9]+/g, "-") || "show0-song"
  manifest.title = manifest.title || songInfo.title
  manifest.artist = manifest.artist || songInfo.artist
  manifest.displayName = manifest.displayName || songInfo.displayName
  manifest.durationMs = Number(manifest.durationMs) || 0
  manifest.updatedAt = now
  manifest.tracks = manifest.tracks && typeof manifest.tracks === "object" ? manifest.tracks : {}
  manifest.lyrics = manifest.lyrics && typeof manifest.lyrics === "object" ? manifest.lyrics : {}
  manifest.lyrics = {
    ...manifest.lyrics,
    source: report.fallbackUsed ? "audio-transcription-lrc-fallback" : "kugou-krc-import",
    json: lyricsJsonName,
    lrc: lrcName,
    format: report.fallbackUsed ? "lrc" : "json+lrc",
    offsetMs: Number(manifest.lyrics.offsetMs) || 0,
    krcImport: selected ? {
      sourceKrcName: selected.name,
      importedAt: now,
      confidence: selected.confidence,
      matchReason: selected.matchReason,
    } : null,
  }
  writeJson(manifestPath, manifest)
  const reportPaths = writeLyricImportReport(packageDir, report)
  return { ok: true, report, manifestPath, lyricsJsonPath, lrcPath, reportPaths }
}

function songPackageTrashDir() {
  return path.join(app.getPath("temp"), "SHOW-0", "deleted-song-packages")
}

function clearSongPackageTrash() {
  const trashDir = songPackageTrashDir()
  try {
    fs.rmSync(trashDir, { recursive: true, force: true })
    fs.mkdirSync(trashDir, { recursive: true })
    log(`SHOW-0 cleared temporary deleted song packages: ${trashDir}`)
    return { ok: true, path: trashDir }
  } catch (error) {
    return { ok: false, path: trashDir, error: error.message }
  }
}

function ensureMovableSongPackageDir(packageDir) {
  const resolved = ensurePackageDir(packageDir)
  const parsed = path.parse(resolved)
  if (resolved === parsed.root) {
    throw new Error("Refuse to move a drive root.")
  }
  const hasKnownSongPackageFile = ["manifest.json", "show0_config.json"].some((fileName) => fs.existsSync(path.join(resolved, fileName)))
  if (!hasKnownSongPackageFile) {
    throw new Error("Directory does not look like a SHOW-0 song package.")
  }
  return resolved
}

function moveSongPackageToTempTrash(packageDir) {
  const sourceDir = ensureMovableSongPackageDir(packageDir)
  const trashDir = songPackageTrashDir()
  fs.mkdirSync(trashDir, { recursive: true })
  const safeName = `${Date.now()}-${path.basename(sourceDir).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")}`
  const targetDir = path.join(trashDir, safeName)
  try {
    fs.renameSync(sourceDir, targetDir)
  } catch (error) {
    if (error && error.code === "EXDEV") {
      fs.cpSync(sourceDir, targetDir, { recursive: true, force: false, errorOnExist: true })
      fs.rmSync(sourceDir, { recursive: true, force: true })
    } else {
      throw error
    }
  }
  return { ok: true, sourcePath: sourceDir, trashPath: targetDir, trashRoot: trashDir }
}

function packageDisplayName(packageDir, manifest) {
  const displayName = String(manifest?.displayName || "").trim()
  if (displayName) return displayName
  const artist = String(manifest?.artist || "").trim()
  const title = String(manifest?.title || "").trim()
  if (artist && title) return `${artist} - ${title}`
  return path.basename(packageDir)
}

function safePackageFileName(name) {
  return String(name || "SHOW-0")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "SHOW-0"
}

function show0SongDataDirFromConfig(sourceConfig = {}) {
  const configured = String(sourceConfig.show0SongDataDir || sourceConfig.show0SongLibraryDir || "").trim()
  if (configured) {
    const resolved = path.resolve(configured)
    ensureShow0SongDataFolders(resolved)
    return resolved
  }
  const root = String(sourceConfig.show0RootDir || "").trim()
  const resolved = root ? path.join(path.resolve(root), "SHOW-0\u6570\u636e") : chooseDefaultShow0SongDataDir()
  ensureShow0SongDataFolders(resolved)
  return resolved
  return path.join(path.resolve(root), "SHOW-0数据")
}

function driveRootAvailable(driveRoot) {
  try {
    return fs.existsSync(driveRoot) && fs.statSync(driveRoot).isDirectory()
  } catch (_error) {
    return false
  }
}

function chooseDefaultShow0SongDataDir() {
  for (const driveRoot of ["D:\\", "E:\\", "F:\\", "G:\\"]) {
    if (driveRootAvailable(driveRoot)) return path.join(driveRoot, "SHOW-0\u6570\u636e")
  }
  return path.join(app.getPath("documents"), "SHOW-0\u6570\u636e")
}

function ensureShow0SongDataFolders(songDataDir) {
  fs.mkdirSync(songDataDir, { recursive: true })
  for (const folderName of ["\u9ed8\u8ba4", "\u6211\u7684\u6536\u85cf", "_deleted", "_cloud_downloads"]) {
    fs.mkdirSync(path.join(songDataDir, folderName), { recursive: true })
  }
}

function uniqueDirectory(parentDir, baseName) {
  const clean = safePackageFileName(baseName)
  const base = clean.replace(/\(\d+\)$/u, "").trim() || clean
  let target = path.join(parentDir, base)
  let index = 1
  while (fs.existsSync(target)) {
    target = path.join(parentDir, `${base}(${index})`)
    index += 1
  }
  return target
}

function splitDisplayName(displayName) {
  const text = String(displayName || "").trim()
  if (text.includes(" - ")) {
    const [artist, ...rest] = text.split(" - ")
    return { artist: artist.trim() || "SHOW-0", title: rest.join(" - ").trim() || text }
  }
  return { artist: "SHOW-0", title: text || "Untitled Song" }
}

function roleAssetMarker(role) {
  return { instrumental: "伴奏", vocal: "人声", originalVocal: "原声", harmony: "和声" }[role] || "音频"
}

const coverImageExtensions = [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".avif"]

function isCoverImageFileName(name) {
  return coverImageExtensions.includes(path.extname(String(name || "")).toLowerCase())
}

function classifyCreateImportFile(file) {
  const role = String(file?.role || "")
  if (["instrumental", "vocal", "originalVocal", "harmony", "lyrics"].includes(role)) return role
  const name = String(file?.name || "").toLowerCase()
  if (name.includes("伴奏") || name.includes("instrumental")) return "instrumental"
  if (name.includes("原声") || name.includes("original")) return "originalVocal"
  if (name.includes("和声") || name.includes("harmony")) return "harmony"
  if (name.includes("人声") || name.includes("vocal")) return "vocal"
  if (/\.(lrc|txt|json)$/i.test(name)) return "lyrics"
  return "unclassified"
}

function writeCreateImportFile(targetPath, file) {
  if (file?.sourcePath) {
    fs.copyFileSync(String(file.sourcePath), targetPath)
    return
  }
  if (file?.bytes) {
    fs.writeFileSync(targetPath, Buffer.from(file.bytes))
    return
  }
  throw new Error(`No readable source for ${file?.name || "file"}.`)
}

function createDefaultShow0Config() {
  const now = new Date().toISOString()
  return {
    version: "1.0.0",
    parameters: { bgmVolume: 70, aiVocalVolume: 80, threshold: 50, gain: 50, reverb: 35 },
    automation: { smartSwitchEnabled: true, minSilenceMs: 1500 },
    lyrics: { offsetMs: 0 },
    midi: {},
    performance: {},
    createdAt: now,
    updatedAt: now,
  }
}

function createSongPackageFromImports(payload) {
  const files = Array.isArray(payload?.files) ? payload.files : []
  if (!files.length) throw new Error("No source files selected.")
  const displayName = safePackageFileName(payload?.displayName || files.find((file) => file?.name)?.name?.replace(/\.[^.]+$/g, "") || "Untitled Song")
  const songDataDir = show0SongDataDirFromConfig(payload?.config || {})
  const defaultDir = path.join(songDataDir, "默认")
  fs.mkdirSync(defaultDir, { recursive: true })
  const packageDir = uniqueDirectory(defaultDir, displayName)
  fs.mkdirSync(packageDir, { recursive: true })
  const nameInfo = splitDisplayName(path.basename(packageDir))
  const now = new Date().toISOString()
  const manifest = {
    packageVersion: "1.0.0",
    songId: safePackageAssetName(path.basename(packageDir)).toLowerCase().replace(/[^a-z0-9]+/g, "-") || `show0-${Date.now()}`,
    displayName: path.basename(packageDir),
    artist: nameInfo.artist,
    title: nameInfo.title,
    tracks: { instrumental: null, vocal: null, originalVocal: null, harmony: null, rewriteVocal: null },
    lyrics: { lrc: null, json: null, rewriteLrc: null, rewriteLyrics: null, offsetMs: 0 },
    createdAt: now,
    updatedAt: now,
  }
  const importedFiles = []
  const warnings = []
  for (const sourceFile of files) {
    const role = classifyCreateImportFile(sourceFile)
    const originalName = safePackageFileName(sourceFile?.name || `${role}`)
    const ext = path.extname(originalName) || (role === "lyrics" ? ".lrc" : ".wav")
    if (role === "lyrics") {
      const lyricName = `${path.basename(packageDir)}${ext.toLowerCase() === ".json" ? ".lyrics.json" : ".lrc"}`
      writeCreateImportFile(path.join(packageDir, lyricName), sourceFile)
      if (ext.toLowerCase() === ".json") manifest.lyrics.json = lyricName
      else manifest.lyrics.lrc = lyricName
      importedFiles.push({ role, path: lyricName })
    } else if (["instrumental", "vocal", "originalVocal", "harmony"].includes(role)) {
      const targetName = `${path.basename(packageDir)}(${roleAssetMarker(role)})${ext}`
      writeCreateImportFile(path.join(packageDir, targetName), sourceFile)
      manifest.tracks[role] = { path: targetName, role, label: roleAssetMarker(role) }
      importedFiles.push({ role, path: targetName })
    } else {
      warnings.push(`Unclassified file was not imported: ${originalName}`)
    }
  }
  const manifestPath = path.join(packageDir, "manifest.json")
  writeJson(manifestPath, manifest)
  const show0ConfigPath = path.join(packageDir, "show0_config.json")
  if (!fs.existsSync(show0ConfigPath)) writeJson(show0ConfigPath, createDefaultShow0Config())
  let krcImport = null
  try {
    krcImport = importKugouKrcLyrics({
      songPackageDir: packageDir,
      kugouLyricDir: payload?.kugouLyricDir,
      kugouMusicDir: payload?.kugouMusicDir,
      artist: manifest.artist,
      title: manifest.title,
      displayName: manifest.displayName,
      audioFileName: importedFiles.find((item) => item.role === "originalVocal" || item.role === "instrumental")?.path || "",
      force: false,
    })
  } catch (error) {
    warnings.push(`KRC import failed, song package was still created: ${error.message}`)
    krcImport = { ok: false, error: error.message }
  }
  let updateResult = null
  try {
    updateResult = updateSongPackageWithNativeWaveform({
      songPackageDir: packageDir,
      mode: "analysisOnly",
      force: true,
      targetLufs: payload?.targetLufs,
      maxGainDb: payload?.maxGainDb,
      recordInitialLoudnessSettings: true,
      triggeredBy: "create-song-save-collection",
    })
    if (Array.isArray(updateResult?.warnings)) warnings.push(...updateResult.warnings)
    if (Array.isArray(updateResult?.errors)) warnings.push(...updateResult.errors.map((item) => `Song package analysis warning: ${item}`))
  } catch (error) {
    warnings.push(`Song package analysis failed, song package was still created: ${error.message}`)
    updateResult = { ok: false, error: error.message }
  }
  return { ok: true, songPackageDir: packageDir, manifestPath, show0ConfigPath, importedFiles, warnings, krcImport, updateResult }
}

function readSongPackageManifest(packageDir) {
  try {
    const resolved = ensurePackageDir(packageDir)
    const manifestPath = path.join(resolved, "manifest.json")
    if (!fs.existsSync(manifestPath)) return { ok: false, exists: true, manifest: null, error: "manifest.json is missing." }
    return { ok: true, exists: true, manifest: safeJson(manifestPath), manifestPath }
  } catch (_error) {
    return { ok: false, exists: false, manifest: null, error: "\u6b4c\u66f2\u672a\u4e0b\u8f7d / \u6b4c\u66f2\u5305\u7f3a\u5931" }
  }
}

function resolvePackageImageFile(packageDir, relativeOrAbsolute) {
  const raw = String(relativeOrAbsolute || "").trim()
  if (!raw || /^https?:\/\//i.test(raw)) return null
  const resolvedPackageDir = ensurePackageDir(packageDir)
  let resolvedFile = raw
  if (/^file:\/\//i.test(raw)) {
    try {
      resolvedFile = fileURLToPath(raw)
    } catch (_error) {
      return null
    }
  }
  resolvedFile = path.isAbsolute(resolvedFile) ? path.resolve(resolvedFile) : path.resolve(resolvedPackageDir, resolvedFile)
  const relative = path.relative(resolvedPackageDir, resolvedFile)
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null
  if (!isCoverImageFileName(resolvedFile)) return null
  if (!fs.existsSync(resolvedFile) || !fs.statSync(resolvedFile).isFile()) return null
  return resolvedFile
}

function pushCoverCandidate(candidates, seen, packageDir, value, source) {
  if (!value) return
  if (typeof value === "string") {
    const imagePath = resolvePackageImageFile(packageDir, value)
    if (!imagePath || seen.has(imagePath)) return
    seen.add(imagePath)
    candidates.push({ imagePath, source })
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) pushCoverCandidate(candidates, seen, packageDir, item, source)
    return
  }
  if (typeof value === "object") {
    for (const key of ["path", "file", "src", "url", "cover", "artwork", "image"]) {
      pushCoverCandidate(candidates, seen, packageDir, value[key], `${source}.${key}`)
    }
  }
}

function coverNameScore(fileName, packageDir, manifest) {
  const lower = fileName.toLowerCase()
  const displayName = String(manifest?.displayName || path.basename(packageDir)).toLowerCase()
  let score = 0
  if (/(^|[\s._-])(cover|artwork|album|poster|thumbnail|front|image)([\s._-]|$)/i.test(fileName)) score += 80
  if (fileName.includes("封面") || fileName.includes("图片") || fileName.includes("海报")) score += 80
  if (lower.includes(displayName) && displayName.length > 1) score += 18
  if (["cover", "folder", "front", "artwork", "album"].includes(path.basename(lower, path.extname(lower)))) score += 30
  return score
}

function resolveSongCover(packageDir) {
  try {
    const resolved = ensurePackageDir(packageDir)
    const manifest = safeJson(path.join(resolved, "manifest.json")) || {}
    const candidates = []
    const seen = new Set()
    for (const [source, value] of [
      ["manifest.cover", manifest.cover],
      ["manifest.coverPath", manifest.coverPath],
      ["manifest.coverImage", manifest.coverImage],
      ["manifest.coverUrl", manifest.coverUrl],
      ["manifest.artwork", manifest.artwork],
      ["manifest.artworkPath", manifest.artworkPath],
      ["manifest.artworkUrl", manifest.artworkUrl],
      ["manifest.image", manifest.image],
      ["manifest.imagePath", manifest.imagePath],
      ["manifest.imageUrl", manifest.imageUrl],
      ["manifest.thumbnail", manifest.thumbnail],
      ["manifest.poster", manifest.poster],
      ["manifest.albumArt", manifest.albumArt],
      ["manifest.albumArtPath", manifest.albumArtPath],
      ["manifest.images", manifest.images],
      ["manifest.assets.cover", manifest.assets?.cover],
      ["manifest.assets.artwork", manifest.assets?.artwork],
      ["manifest.media.cover", manifest.media?.cover],
    ]) {
      pushCoverCandidate(candidates, seen, resolved, value, source)
    }
    const files = fs.readdirSync(resolved, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isCoverImageFileName(entry.name))
      .map((entry) => ({ name: entry.name, imagePath: path.join(resolved, entry.name), score: coverNameScore(entry.name, resolved, manifest) }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "zh-Hans-CN"))
    for (const file of files) {
      if (seen.has(file.imagePath)) continue
      seen.add(file.imagePath)
      candidates.push({ imagePath: file.imagePath, source: file.score > 0 ? "package-image-match" : "package-image" })
    }
    const selected = candidates[0]
    if (!selected) return { ok: true, exists: false, songPackageDir: resolved, coverPath: "", coverUrl: "", relativePath: "", fileName: "", source: "" }
    return {
      ok: true,
      exists: true,
      songPackageDir: resolved,
      coverPath: selected.imagePath,
      coverUrl: pathToFileURL(selected.imagePath).toString(),
      relativePath: path.relative(resolved, selected.imagePath),
      fileName: path.basename(selected.imagePath),
      source: selected.source,
    }
  } catch (error) {
    return { ok: false, exists: false, songPackageDir: String(packageDir || ""), coverPath: "", coverUrl: "", relativePath: "", fileName: "", source: "", error: error.message || "resolve song cover failed" }
  }
}

function songPackageFileExists(packageDir, relativePath) {
  try {
    const resolvedPackageDir = ensurePackageDir(packageDir)
    const raw = String(relativePath || "")
    if (!raw || path.isAbsolute(raw)) return { ok: false, exists: false }
    const resolvedFile = path.resolve(resolvedPackageDir, raw)
    const relative = path.relative(resolvedPackageDir, resolvedFile)
    if (relative.startsWith("..") || path.isAbsolute(relative)) return { ok: false, exists: false }
    return { ok: true, exists: fs.existsSync(resolvedFile) && fs.statSync(resolvedFile).isFile() }
  } catch (_error) {
    return { ok: false, exists: false }
  }
}

function readSongPackageJsonResource(packageDir, relativePath) {
  try {
    const resolvedPackageDir = ensurePackageDir(packageDir)
    const raw = String(relativePath || "")
    if (!raw || path.isAbsolute(raw)) return null
    const resolvedFile = path.resolve(resolvedPackageDir, raw)
    const relative = path.relative(resolvedPackageDir, resolvedFile)
    if (relative.startsWith("..") || path.isAbsolute(relative) || !fs.existsSync(resolvedFile)) return null
    return safeJson(resolvedFile)
  } catch (_error) {
    return null
  }
}

function trackRelativePath(track) {
  if (!track) return ""
  if (typeof track === "string") return track
  if (typeof track !== "object") return ""
  return String(track.path || track.file || track.audioPath || track.source || track.std_path || track.source_path || "")
}

function resolvePackageAudioFile(packageDir, relativeOrAbsolute) {
  const raw = String(relativeOrAbsolute || "").trim()
  if (!raw) return null
  const resolvedPackageDir = ensurePackageDir(packageDir)
  const resolvedFile = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(resolvedPackageDir, raw)
  const relative = path.relative(resolvedPackageDir, resolvedFile)
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null
  if (!fs.existsSync(resolvedFile) || !fs.statSync(resolvedFile).isFile()) return null
  if (!/\.(wav|mp3|flac|m4a|aac|ogg)$/i.test(resolvedFile)) return null
  return resolvedFile
}

function resolvePlaybackAudio(packageDir) {
  try {
    const resolvedPackageDir = ensurePackageDir(packageDir)
    const manifest = safeJson(path.join(resolvedPackageDir, "manifest.json")) || {}
    const show0Config = safeJson(path.join(resolvedPackageDir, "show0_config.json")) || {}
    const candidates = []
    const pushCandidate = (value, role, source) => {
      const audioPath = resolvePackageAudioFile(resolvedPackageDir, value)
      if (audioPath && !candidates.some((item) => item.audioPath === audioPath)) candidates.push({ audioPath, role, source })
    }
    const tracks = manifest.tracks && typeof manifest.tracks === "object" ? manifest.tracks : {}
    pushCandidate(manifest.audioPath || manifest.mainAudioPath || manifest.performanceAudioPath, "main", "manifest")
    pushCandidate(manifest.audio?.path || manifest.audio?.main || manifest.performance?.audioPath, "main", "manifest")
    pushCandidate(show0Config.audioPath || show0Config.mainAudioPath || show0Config.performance?.audioPath, "main", "show0_config")
    for (const role of ["originalVocal", "instrumental", "vocal", "harmony", "rewriteVocal"]) {
      pushCandidate(trackRelativePath(tracks[role]), role, "manifest.tracks")
    }
    if (!candidates.length) {
      const audioFiles = fs.readdirSync(resolvedPackageDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.(wav|mp3|flac|m4a|aac|ogg)$/i.test(entry.name))
        .map((entry) => entry.name)
        .sort((a, b) => {
          const score = (name) => name.includes("原声") || /original/i.test(name) ? 0 : name.includes("伴奏") || /instrumental/i.test(name) ? 1 : 2
          return score(a) - score(b) || a.localeCompare(b, "zh-Hans-CN")
        })
      for (const fileName of audioFiles) pushCandidate(fileName, "fallback", "package-scan")
    }
    const selected = candidates[0]
    if (!selected) return { ok: false, error: "当前歌曲包未找到可播放音频文件。", songPackageDir: resolvedPackageDir }
    return {
      ok: true,
      songPackageDir: resolvedPackageDir,
      audioPath: selected.audioPath,
      audioUrl: pathToFileURL(selected.audioPath).toString(),
      role: selected.role,
      source: selected.source,
      fileName: path.basename(selected.audioPath),
    }
  } catch (error) {
    return { ok: false, error: error.message || "解析播放音频失败。", songPackageDir: String(packageDir || "") }
  }
}

function roleNameScore(name, role) {
  const lower = String(name || "").toLowerCase()
  const has = (...patterns) => patterns.some((pattern) => lower.includes(pattern))
  if (role === "instrumental") return has("instrumental", "accompaniment", "backing", "伴奏", "浼村") ? 0 : 100
  if (role === "harmony") return has("harmony", "和声", "鍜屽") ? 0 : 100
  if (role === "vocal") return has("vocal", "voice", "人声", "浜哄") && !has("original", "rewrite", "ai") ? 0 : 100
  if (role === "aiVocal") return has("aivocal", "ai_vocal", "ai vocal", "generated", "ai人声") ? 0 : 100
  if (role === "rewriteVocal") return has("rewrite", "改词", "鏀硅瘝") ? 0 : 100
  if (role === "originalVocal") return has("original", "reference", "原声", "原唱", "鍘熷") ? 0 : 100
  if (role === "main") return has("main", "original", "reference", "原曲", "原声", "鍘熷") ? 0 : 100
  return 100
}

function scanPackageAudioForRole(packageDir, role) {
  try {
    const matches = fs.readdirSync(packageDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(wav|mp3|flac|m4a|aac|ogg)$/i.test(entry.name))
      .map((entry) => entry.name)
      .filter((name) => roleNameScore(name, role) < 100)
      .sort((a, b) => roleNameScore(a, role) - roleNameScore(b, role) || a.localeCompare(b, "zh-Hans-CN"))
    return matches[0] || ""
  } catch (_error) {
    return ""
  }
}

function firstTrackValue(...values) {
  for (const value of values) {
    const resolved = trackRelativePath(value)
    if (resolved) return resolved
  }
  return ""
}

function nativeAudioCoreExecutableName() {
  return process.platform === "win32" ? "show0-audio-core.exe" : "show0-audio-core"
}

function nativeAudioCoreExecutableCandidates() {
  const executableName = nativeAudioCoreExecutableName()
  return Array.from(new Set([
    path.resolve(__dirname, "..", "native", "show0-audio-core", "bin", executableName),
    path.resolve(__dirname, "..", "native", "show0-audio-core", "build", "bin", executableName),
    process.resourcesPath ? path.join(process.resourcesPath, "native", "show0-audio-core", executableName) : "",
    process.resourcesPath ? path.join(process.resourcesPath, "native", "show0-audio-core", "bin", executableName) : "",
    process.resourcesPath ? path.join(process.resourcesPath, "app.asar.unpacked", "native", "show0-audio-core", "bin", executableName) : "",
    path.join(app.getAppPath(), "native", "show0-audio-core", "bin", executableName),
  ].filter(Boolean)))
}

function findNativeAudioCoreExecutable() {
  for (const candidate of nativeAudioCoreExecutableCandidates()) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
    } catch (_error) {}
  }
  return ""
}

function runNativeAudioCore(args, timeoutMs = 12000) {
  const executablePath = findNativeAudioCoreExecutable()
  if (!executablePath) {
    return { ok: false, error: "show0-audio-core.exe was not found.", executablePath: "" }
  }

  try {
    const stdout = execFileSync(executablePath, args.map((value) => String(value)), {
      encoding: "utf8",
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    })
    const parsed = JSON.parse(String(stdout || "{}"))
    return { ...parsed, executablePath }
  } catch (error) {
    return { ok: false, error: error.message || String(error), executablePath }
  }
}

function readWaveformWithNativeAudioCore(filePath, resolution = 1200) {
  return runNativeAudioCore(["--waveform", "--input", filePath, "--resolution", String(resolution || 1200)], 30000)
}

function updateSongPackageWithNativeWaveform(payload) {
  return updateSongPackage({ ...(payload || {}), nativeWaveformReader: readWaveformWithNativeAudioCore })
}

let nativeAudioCoreProcess = null
let nativeAudioCoreLineBuffer = ""
let nativeAudioCoreRequestId = 0
const nativeAudioCorePending = new Map()

function rejectPendingNativeAudioCoreRequests(error) {
  for (const pending of nativeAudioCorePending.values()) {
    clearTimeout(pending.timer)
    pending.reject(error)
  }
  nativeAudioCorePending.clear()
}

function ensureNativeAudioCoreServer() {
  if (nativeAudioCoreProcess && !nativeAudioCoreProcess.killed) return nativeAudioCoreProcess
  const executablePath = findNativeAudioCoreExecutable()
  if (!executablePath) throw new Error("show0-audio-core.exe was not found.")

  nativeAudioCoreLineBuffer = ""
  nativeAudioCoreProcess = spawn(executablePath, ["--server"], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  })
  nativeAudioCoreProcess.stdout.setEncoding("utf8")
  nativeAudioCoreProcess.stderr.setEncoding("utf8")
  nativeAudioCoreProcess.stdout.on("data", (chunk) => {
    nativeAudioCoreLineBuffer += chunk
    const lines = nativeAudioCoreLineBuffer.split(/\r?\n/)
    nativeAudioCoreLineBuffer = lines.pop() || ""
    for (const line of lines) {
      if (!line.trim()) continue
      let response
      try {
        response = JSON.parse(line)
      } catch (error) {
        log("native audio core invalid JSON: " + error.message)
        continue
      }
      const id = String(response.id || "")
      const pending = nativeAudioCorePending.get(id)
      if (!pending) continue
      clearTimeout(pending.timer)
      nativeAudioCorePending.delete(id)
      pending.resolve(response)
    }
  })
  nativeAudioCoreProcess.stderr.on("data", (chunk) => {
    if (String(chunk || "").trim()) log("native audio core stderr: " + String(chunk).trim())
  })
  nativeAudioCoreProcess.on("exit", (code, signal) => {
    nativeAudioCoreProcess = null
    rejectPendingNativeAudioCoreRequests(new Error(`show0-audio-core exited: code=${code ?? ""} signal=${signal ?? ""}`))
  })
  nativeAudioCoreProcess.on("error", (error) => {
    nativeAudioCoreProcess = null
    rejectPendingNativeAudioCoreRequests(error)
  })
  return nativeAudioCoreProcess
}

function nativeAudioCoreRequest(command, payload = {}, timeoutMs = 15000) {
  const processRef = ensureNativeAudioCoreServer()
  const id = String(++nativeAudioCoreRequestId)
  const message = JSON.stringify({ id, command, payload }) + "\n"
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      nativeAudioCorePending.delete(id)
      reject(new Error(`native audio core request timed out: ${command}`))
    }, timeoutMs)
    nativeAudioCorePending.set(id, { resolve, reject, timer })
    processRef.stdin.write(message, "utf8", (error) => {
      if (!error) return
      clearTimeout(timer)
      nativeAudioCorePending.delete(id)
      reject(error)
    })
  })
}

function shutdownNativeAudioCoreServer() {
  if (!nativeAudioCoreProcess) return
  const processRef = nativeAudioCoreProcess
  try {
    processRef.stdin.write(JSON.stringify({ id: `shutdown-${Date.now()}`, command: "shutdown", payload: {} }) + "\n")
  } catch (_error) {}
  setTimeout(() => {
    try {
      if (!processRef.killed) processRef.kill()
    } catch (_error) {}
  }, 800)
}

async function getAudioCoreCapabilities() {
  let rendererOutputRoutingSupported = false
  const nativeResult = runNativeAudioCore(["--capabilities"])
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      rendererOutputRoutingSupported = Boolean(await mainWindow.webContents.executeJavaScript(`
        Boolean(typeof HTMLMediaElement !== "undefined" && HTMLMediaElement.prototype && HTMLMediaElement.prototype.setSinkId)
      `, true))
    }
  } catch (_error) {
    rendererOutputRoutingSupported = false
  }

  if (nativeResult?.ok && nativeResult.nativeAvailable) {
    const availableHostApis = Array.isArray(nativeResult.availableHostApis) ? nativeResult.availableHostApis : Array.isArray(nativeResult.hostApis) ? nativeResult.hostApis : []
    return {
      backendType: "native_audio_core",
      currentBackendLabel: nativeResult.currentBackendLabel || "JUCE native Audio Core",
      nativeAvailable: true,
      nativeReason: nativeResult.nativeReason || "",
      fallbackReason: "",
      activeHostApi: nativeResult.activeHostApi ?? null,
      availableHostApis,
      hostApiSupported: availableHostApis.length > 0,
      hostApis: availableHostApis,
      hostApiDetails: Array.isArray(nativeResult.hostApiDetails) ? nativeResult.hostApiDetails : [],
      deviceEnumerationSupported: Boolean(nativeResult.deviceEnumerationSupported),
      nativePlaybackSupported: Boolean(nativeResult.nativePlaybackSupported),
      playbackHostApis: Array.isArray(nativeResult.playbackHostApis) ? nativeResult.playbackHostApis : [],
      sampleRateSupported: Boolean(nativeResult.sampleRateSupported),
      sampleRates: Array.isArray(nativeResult.sampleRates) ? nativeResult.sampleRates : [],
      bufferSizeSupported: Boolean(nativeResult.bufferSizeSupported),
      bufferSizes: Array.isArray(nativeResult.bufferSizes) ? nativeResult.bufferSizes : [],
      multiBusSupported: Boolean(nativeResult.multiBusSupported),
      multiTrackSupported: Boolean(nativeResult.multiTrackSupported),
      inputDeviceSupported: Boolean(nativeResult.inputDeviceSupported),
      outputDeviceRoutingSupported: Boolean(nativeResult.outputDeviceRoutingSupported || rendererOutputRoutingSupported),
      outputDeviceRoutingMode: nativeResult.outputDeviceRoutingMode || (rendererOutputRoutingSupported ? "html_set_sink_id" : "system_default"),
      nativeExecutablePath: nativeResult.executablePath || "",
    }
  }

  const nativeError = nativeResult?.error ? String(nativeResult.error) : "show0-audio-core.exe 未构建或未找到。"
  const availableHostApis = []
  return {
    backendType: "html_audio",
    currentBackendLabel: "系统默认（HTMLAudioElement fallback）",
    nativeAvailable: false,
    nativeReason: `native Audio Core 未启用：${nativeError}`,
    fallbackReason: "当前保持 HTMLAudioElement fallback；Host API、采样率、buffer 只有原生 helper 构建成功后才会真实生效。",
    activeHostApi: null,
    availableHostApis,
    hostApiSupported: false,
    hostApis: availableHostApis,
    deviceEnumerationSupported: false,
    nativePlaybackSupported: false,
    playbackHostApis: [],
    sampleRateSupported: false,
    sampleRates: [],
    bufferSizeSupported: false,
    bufferSizes: [],
    multiBusSupported: false,
    multiTrackSupported: false,
    inputDeviceSupported: false,
    outputDeviceRoutingSupported: rendererOutputRoutingSupported,
    outputDeviceRoutingMode: rendererOutputRoutingSupported ? "html_set_sink_id" : "system_default",
  }
}

function audioCoreTrackInfo(packageDir, value, role, bus, required = false) {
  const audioPath = resolvePackageAudioFile(packageDir, value)
  return {
    role,
    bus,
    required: Boolean(required),
    available: Boolean(audioPath),
    path: audioPath || null,
    fileName: audioPath ? path.basename(audioPath) : "",
    url: audioPath ? pathToFileURL(audioPath).toString() : "",
  }
}

function resolveAudioCoreTracks(packageDir) {
  try {
    const resolvedPackageDir = ensurePackageDir(packageDir)
    const manifest = safeJson(path.join(resolvedPackageDir, "manifest.json")) || {}
    const show0Config = safeJson(path.join(resolvedPackageDir, "show0_config.json")) || {}
    const tracks = manifest.tracks && typeof manifest.tracks === "object" ? manifest.tracks : {}
    const configTracks = show0Config.tracks && typeof show0Config.tracks === "object" ? show0Config.tracks : {}
    const mainPath = manifest.audioPath || manifest.mainAudioPath || manifest.performanceAudioPath || manifest.audio?.path || manifest.audio?.main || manifest.performance?.audioPath || show0Config.audioPath || show0Config.mainAudioPath || show0Config.performance?.audioPath || scanPackageAudioForRole(resolvedPackageDir, "main")
    const rolePath = (role, aliases) => {
      const explicit = firstTrackValue(
        tracks[role],
        configTracks[role],
        ...aliases.flatMap((alias) => [tracks[alias], configTracks[alias]]),
      )
      return explicit || scanPackageAudioForRole(resolvedPackageDir, role)
    }
    const trackMap = {
      main: audioCoreTrackInfo(resolvedPackageDir, mainPath, "main", "reference", false),
      originalVocal: audioCoreTrackInfo(resolvedPackageDir, rolePath("originalVocal", ["original_vocal", "original", "reference"]), "originalVocal", "reference", false),
      instrumental: audioCoreTrackInfo(resolvedPackageDir, rolePath("instrumental", ["backing", "accompaniment", "伴奏"]), "instrumental", "accompaniment", false),
      harmony: audioCoreTrackInfo(resolvedPackageDir, rolePath("harmony", ["和声"]), "harmony", "accompaniment", false),
      vocal: audioCoreTrackInfo(resolvedPackageDir, rolePath("vocal", ["voice", "humanVocal", "人声"]), "vocal", "vocal", false),
      aiVocal: audioCoreTrackInfo(resolvedPackageDir, rolePath("aiVocal", ["ai_vocal", "generatedVocal", "generated_vocal"]), "aiVocal", "vocal", false),
      rewriteVocal: audioCoreTrackInfo(resolvedPackageDir, rolePath("rewriteVocal", ["rewrite_vocal", "rewriteAudio", "rewrite_audio"]), "rewriteVocal", "vocal", false),
    }
    const playbackFallback = resolvePlaybackAudio(resolvedPackageDir)
    return {
      ok: true,
      songPackageDir: resolvedPackageDir,
      backendType: "html_audio",
      tracks: trackMap,
      playbackFallback,
      warnings: [
        "native Audio Core track map prepared; current production playback uses synchronized HTMLAudioElement fallback.",
        "separate multi-bus device routing remains capability-gated until native backend is available.",
      ],
    }
  } catch (error) {
    return { ok: false, songPackageDir: String(packageDir || ""), error: error.message || "解析 Audio Core 轨道失败。" }
  }
}

function migrationConfigPath() {
  return path.join(app.getPath("userData"), "kugou-sync-config.json")
}

function readMigrationConfig() {
  try {
    const filePath = migrationConfigPath()
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) : {}
  } catch (_error) {
    return {}
  }
}

function writeMigrationConfig(nextConfig) {
  const filePath = migrationConfigPath()
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(nextConfig, null, 2), "utf8")
  return nextConfig
}

function isInsidePath(parentDir, childPath) {
  const relative = path.relative(path.resolve(parentDir), path.resolve(childPath))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function isDirectoryWritable(dirPath) {
  const probeDir = fs.existsSync(dirPath) ? dirPath : path.dirname(dirPath)
  const probePath = path.join(probeDir, `.show0-write-test-${Date.now()}.tmp`)
  try {
    fs.mkdirSync(probeDir, { recursive: true })
    fs.writeFileSync(probePath, "test", "utf8")
    fs.rmSync(probePath, { force: true })
    return true
  } catch (_error) {
    return false
  }
}

function scanMigrationDataDir(rootDir) {
  const result = {
    ok: true,
    rootDir,
    totalFiles: 0,
    totalFolders: 0,
    totalSizeBytes: 0,
    songPackageCount: 0,
    defaultCount: 0,
    favoritesCount: 0,
    deletedCount: 0,
    playlistFolderCount: 0,
    representativePackages: [],
    errors: [],
  }

  const systemRootDirs = new Set(["\u9ed8\u8ba4", "\u6211\u7684\u6536\u85cf", "_deleted", "_cloud_downloads"].map((name) => path.resolve(rootDir, name)))

  function isValidSongPackageDir(dirPath, entries) {
    if (fs.existsSync(path.join(dirPath, "manifest.json"))) return true
    if (fs.existsSync(path.join(dirPath, "show0_config.json"))) return true
    const fileNames = entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
    const audioFiles = fileNames.filter((name) => /\.(wav|mp3|flac|m4a|aac|ogg)$/i.test(name))
    if (audioFiles.length < 2) return false
    const markers = ["\u4f34\u594f", "\u4eba\u58f0", "\u539f\u58f0", "\u548c\u58f0"]
    return markers.filter((marker) => audioFiles.some((name) => name.includes(marker))).length >= 2
  }

  function walk(currentDir, insideSongPackage = false) {
    let entries = []
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true })
    } catch (error) {
      result.errors.push(error.message)
      return
    }
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name)
      try {
        const stat = fs.statSync(fullPath)
        if (entry.isDirectory()) {
          result.totalFolders += 1
          let childEntries = []
          try {
            childEntries = fs.readdirSync(fullPath, { withFileTypes: true })
          } catch (_error) {
            childEntries = []
          }
          const isSongPackage = isValidSongPackageDir(fullPath, childEntries)
          if (isSongPackage) {
            result.songPackageCount += 1
            if (result.representativePackages.length < 12) result.representativePackages.push(path.relative(rootDir, fullPath))
            if (isInsidePath(path.join(rootDir, "\u9ed8\u8ba4"), fullPath)) result.defaultCount += 1
            else if (isInsidePath(path.join(rootDir, "\u6211\u7684\u6536\u85cf"), fullPath)) result.favoritesCount += 1
            else if (isInsidePath(path.join(rootDir, "_deleted"), fullPath)) result.deletedCount += 1
          } else if (!insideSongPackage && !systemRootDirs.has(path.resolve(fullPath))) {
            result.playlistFolderCount += 1
          }
          walk(fullPath, insideSongPackage || isSongPackage)
        } else if (entry.isFile()) {
          result.totalFiles += 1
          result.totalSizeBytes += stat.size
        }
      } catch (error) {
        result.errors.push(error.message)
      }
    }
  }

  if (!rootDir || !fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    return { ...result, ok: false, errors: ["Current SHOW-0 data directory is missing."] }
  }
  walk(rootDir)
  return result
}

function validateDataMigrationTarget(payload) {
  const rawCurrentDir = String(payload?.currentDir || "").trim()
  const rawTargetDir = String(payload?.targetDir || "").trim()
  const currentDir = rawCurrentDir ? path.resolve(rawCurrentDir) : ""
  const targetDir = rawTargetDir ? path.resolve(rawTargetDir) : ""
  const errors = []
  const warnings = []
  if (!rawTargetDir || !targetDir || targetDir === path.parse(targetDir).root) errors.push("请选择新的数据目录。")
  if (!currentDir || !fs.existsSync(currentDir)) errors.push("当前 SHOW-0 数据目录不可用。")
  if (currentDir && targetDir && path.resolve(currentDir) === path.resolve(targetDir)) errors.push("新数据目录不能与当前数据目录相同。")
  if (currentDir && targetDir && isInsidePath(currentDir, targetDir)) errors.push("新数据目录不能位于当前 SHOW-0 数据目录内部。")
  if (currentDir && targetDir && isInsidePath(targetDir, currentDir)) errors.push("当前 SHOW-0 数据目录不能位于新数据目录内部。")
  if (/^[cC]:\\/.test(targetDir)) warnings.push("不建议选择 C 盘。如有其他磁盘，请选择其他磁盘。")
  if (targetDir.toLowerCase().includes("kugou")) errors.push("新数据目录不能位于酷狗目录中。")
  if (fs.existsSync(targetDir)) {
    const entries = fs.readdirSync(targetDir)
    if (entries.length) errors.push("新数据目录必须为空目录，以避免不安全的合并冲突。")
  }
  if (!isDirectoryWritable(targetDir)) errors.push("新数据目录或其上级目录不可写。")
  return { ok: errors.length === 0, currentDir, targetDir, errors, warnings, targetExists: fs.existsSync(targetDir) }
}

function sendMigrationProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("show0:data-migration-progress", payload)
  }
}

function copyDataDirWithProgress(sourceDir, targetDir, stats) {
  let copiedFiles = 0
  let copiedBytes = 0
  function copyRecursive(currentSource, currentTarget) {
    fs.mkdirSync(currentTarget, { recursive: true })
    for (const entry of fs.readdirSync(currentSource, { withFileTypes: true })) {
      const sourcePath = path.join(currentSource, entry.name)
      const targetPath = path.join(currentTarget, entry.name)
      if (entry.isDirectory()) {
        copyRecursive(sourcePath, targetPath)
      } else if (entry.isFile()) {
        fs.copyFileSync(sourcePath, targetPath)
        copiedFiles += 1
        copiedBytes += fs.statSync(sourcePath).size
        sendMigrationProgress({
          status: "migrating",
          currentPath: path.relative(sourceDir, sourcePath),
          migratedFiles: copiedFiles,
          totalFiles: stats.totalFiles,
          progress: stats.totalFiles ? Math.round((copiedFiles / stats.totalFiles) * 100) : 0,
        })
      }
    }
  }
  copyRecursive(sourceDir, targetDir)
  return { copiedFiles, copiedBytes }
}

function verifyMigratedData(sourceStats, targetDir) {
  ensureShow0SongDataFolders(targetDir)
  const targetStats = scanMigrationDataDir(targetDir)
  const errors = []
  if (!targetStats.ok) errors.push(...targetStats.errors)
  for (const folderName of ["\u9ed8\u8ba4", "\u6211\u7684\u6536\u85cf", "_deleted"]) {
    const folderPath = path.join(targetDir, folderName)
    if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) errors.push(`Required folder missing: ${folderName}`)
  }
  if (targetStats.totalFiles !== sourceStats.totalFiles) errors.push(`File count mismatch: source=${sourceStats.totalFiles}, target=${targetStats.totalFiles}`)
  if (targetStats.totalSizeBytes !== sourceStats.totalSizeBytes) errors.push(`Total size mismatch: source=${sourceStats.totalSizeBytes}, target=${targetStats.totalSizeBytes}`)
  for (const relativePackage of sourceStats.representativePackages || []) {
    const targetPackage = path.join(targetDir, relativePackage)
    if (!fs.existsSync(targetPackage)) errors.push(`Representative package missing: ${relativePackage}`)
    const manifestPath = path.join(targetPackage, "manifest.json")
    if (fs.existsSync(manifestPath) && !safeJson(manifestPath)) errors.push(`Unreadable manifest.json: ${relativePackage}`)
    const configPath = path.join(targetPackage, "show0_config.json")
    if (fs.existsSync(configPath) && !safeJson(configPath)) errors.push(`Unreadable show0_config.json: ${relativePackage}`)
  }
  return { ok: errors.length === 0, errors, targetStats }
}

function startDataMigration(payload) {
  const validation = validateDataMigrationTarget(payload)
  if (!validation.ok) return { ok: false, status: "failed", errors: validation.errors, warnings: validation.warnings }
  dataMigrationInProgress = true
  const sourceDir = validation.currentDir
  const targetDir = validation.targetDir
  const logs = []
  const sourceStats = scanMigrationDataDir(sourceDir)
  try {
    if (!sourceStats.ok) return { ok: false, status: "failed", errors: sourceStats.errors, warnings: validation.warnings }
    sendMigrationProgress({ status: "migrating", progress: 0, migratedFiles: 0, totalFiles: sourceStats.totalFiles, currentPath: "" })
    fs.mkdirSync(targetDir, { recursive: true })
    copyDataDirWithProgress(sourceDir, targetDir, sourceStats)
    sendMigrationProgress({ status: "verifying", progress: 96, migratedFiles: sourceStats.totalFiles, totalFiles: sourceStats.totalFiles, currentPath: "verifying target data" })
    const verification = verifyMigratedData(sourceStats, targetDir)
    if (!verification.ok) return { ok: false, status: "failed", errors: verification.errors, warnings: validation.warnings, sourceDir, targetDir }
    const config = readMigrationConfig()
    const nextConfig = { ...config, show0SongDataDir: targetDir, show0SongLibraryDir: targetDir, show0SongPackageDir: "" }
    writeMigrationConfig(nextConfig)
    fs.rmSync(sourceDir, { recursive: true, force: true })
    logs.push("Migration verified and old data directory removed.")
    sendMigrationProgress({ status: "completed", progress: 100, migratedFiles: sourceStats.totalFiles, totalFiles: sourceStats.totalFiles, currentPath: targetDir })
    return { ok: true, status: "completed", oldPath: sourceDir, newPath: targetDir, sourceStats, targetStats: verification.targetStats, config: nextConfig, logs, warnings: validation.warnings }
  } catch (error) {
    return { ok: false, status: "failed", error: error.message, errors: [error.message], warnings: validation.warnings, sourceDir, targetDir }
  } finally {
    dataMigrationInProgress = false
  }
}

function updateRewriteVocalManifest(packageDir, relativePath, ext) {
  const manifestPath = path.join(packageDir, "manifest.json")
  const manifest = safeJson(manifestPath) || {}
  const now = new Date().toISOString()
  manifest.packageVersion = manifest.packageVersion || "1.0.0"
  manifest.songId = manifest.songId || safePackageFileName(path.basename(packageDir)).toLowerCase().replace(/[^a-z0-9]+/g, "-") || "show0-song"
  manifest.title = manifest.title || path.basename(packageDir)
  manifest.artist = manifest.artist || ""
  manifest.displayName = manifest.displayName || packageDisplayName(packageDir, manifest)
  manifest.durationMs = Number(manifest.durationMs) || 0
  manifest.updatedAt = now
  manifest.tracks = manifest.tracks && typeof manifest.tracks === "object" ? manifest.tracks : {}
  manifest.lyrics = manifest.lyrics && typeof manifest.lyrics === "object" ? manifest.lyrics : {}
  manifest.tracks.rewriteVocal = {
    path: relativePath,
    role: "rewriteVocal",
    label: "改词版",
    meaning: "修改歌词后的客户人声 / 人声2",
    format: ext.replace(".", ""),
    durationMs: 0,
  }
  writeJson(manifestPath, manifest)
  return manifest
}

function normalizeLyricLineItem(item, index) {
  if (typeof item === "string") return { text: item.trim(), timeMs: 0, startTimeMs: 0, endTimeMs: 0, durationMs: 0, timingGranularity: "line" }
  if (!item || typeof item !== "object") return { text: "", timeMs: 0, startTimeMs: 0, endTimeMs: 0, durationMs: 0, timingGranularity: "line" }
  const text = String(item.text || item.line || item.lyric || item.content || "").trim()
  const timeMs = Number(item.timeMs ?? item.startTimeMs ?? item.startMs ?? item.time ?? 0)
  const startTimeMs = Number(item.startTimeMs ?? item.startMs ?? timeMs ?? 0)
  const endTimeMs = Number(item.endTimeMs ?? item.endMs ?? 0)
  const durationMs = Number(item.durationMs ?? item.duration ?? (endTimeMs > startTimeMs ? endTimeMs - startTimeMs : 0))
  const charTimings = Array.isArray(item.charTimings || item.wordTimings)
    ? (item.charTimings || item.wordTimings).map((timing) => ({
      text: String(timing.text || timing.char || timing.word || ""),
      startTimeMs: Math.max(0, Math.round(Number(timing.startTimeMs ?? timing.startMs ?? timing.timeMs ?? 0) || 0)),
      endTimeMs: Math.max(0, Math.round(Number(timing.endTimeMs ?? timing.endMs ?? 0) || 0)),
    }))
    : undefined
  return {
    text,
    timeMs: Number.isFinite(timeMs) ? Math.max(0, Math.round(timeMs)) : 0,
    startTimeMs: Number.isFinite(startTimeMs) ? Math.max(0, Math.round(startTimeMs)) : 0,
    endTimeMs: Number.isFinite(endTimeMs) ? Math.max(0, Math.round(endTimeMs)) : 0,
    durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0,
    source: item.source || item.mode || "normal",
    timingGranularity: item.timingGranularity || (charTimings?.length ? "char" : "line"),
    charTimings,
    id: item.id ?? index,
  }
}

function lockLyricLineBoundaries(lineItems) {
  return lineItems.map((item, index) => {
    const startTimeMs = Math.max(0, Math.round(Number(item.startTimeMs ?? item.timeMs ?? 0) || 0))
    const nextStartTimeMs = Math.max(0, Math.round(Number(lineItems[index + 1]?.startTimeMs ?? lineItems[index + 1]?.timeMs ?? 0) || 0))
    const explicitEndTimeMs = Math.max(0, Math.round(Number(item.endTimeMs ?? 0) || 0))
    const durationMs = Math.max(0, Math.round(Number(item.durationMs ?? 0) || 0))
    const endTimeMs = explicitEndTimeMs > startTimeMs ? explicitEndTimeMs : durationMs > 0 ? startTimeMs + durationMs : nextStartTimeMs > startTimeMs ? nextStartTimeMs : startTimeMs
    return {
      ...item,
      timeMs: startTimeMs,
      startTimeMs,
      endTimeMs,
      durationMs: Math.max(0, endTimeMs - startTimeMs),
      timingGranularity: item.timingGranularity || "line",
    }
  })
}

function parseLyricsText(raw, ext) {
  if (ext === ".json") {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return lockLyricLineBoundaries(parsed.map(normalizeLyricLineItem).filter((item) => item.text))
    if (Array.isArray(parsed.lines)) return lockLyricLineBoundaries(parsed.lines.map(normalizeLyricLineItem).filter((item) => item.text))
    if (typeof parsed.text === "string") return lockLyricLineBoundaries(parsed.text.split(/\r?\n/).map((line, index) => normalizeLyricLineItem(line, index)).filter((item) => item.text))
    return []
  }
  const lines = []
  for (const rawLine of String(raw || "").split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const match = line.match(/^\s*((?:\[[^\]]+\])+)\s*(.*)$/)
    if (match) {
      const stamps = [...match[1].matchAll(/\[([^\]]+)\]/g)]
      const text = match[2].replace(/<[^>]+>/g, "").trim()
      for (const stamp of stamps) {
        if (text) lines.push({ text, timeMs: parseTimestampMs(stamp[1]), startTimeMs: parseTimestampMs(stamp[1]), durationMs: 0, timingGranularity: "line" })
      }
      continue
    }
    lines.push({ text: line.replace(/<[^>]+>/g, "").trim(), timeMs: 0, startTimeMs: 0, durationMs: 0, timingGranularity: "line" })
  }
  return lockLyricLineBoundaries(lines.filter((item) => item.text).sort((a, b) => a.timeMs - b.timeMs))
}

function findPackageFile(packageDir, relativePath) {
  if (!relativePath || path.isAbsolute(relativePath)) return relativePath || ""
  return path.join(packageDir, relativePath)
}

function isRewriteLyricsFileName(name) {
  const lower = String(name || "").toLowerCase()
  return ["(改词版)", "（改词版）", "改词版", "(改词)", "（改词）", "rewrite lyrics", "rewritten lyrics"].some((marker) => name.includes(marker) || lower.includes(marker.toLowerCase()))
}

function findRewriteLyricsFile(packageDir) {
  const markers = ["(改词版)", "（改词版）", "改词版", "(改词)", "（改词）", "rewrite lyrics", "rewritten lyrics"]
  const supported = new Set([".lrc", ".txt", ".json"])
  const krcCandidates = []
  try {
    for (const name of fs.readdirSync(packageDir)) {
      const fullPath = path.join(packageDir, name)
      if (!fs.statSync(fullPath).isFile()) continue
      const matched = isRewriteLyricsFileName(name)
      if (!matched) continue
      const ext = path.extname(name).toLowerCase()
      if (supported.has(ext)) return fullPath
      if (ext === ".krc") krcCandidates.push(name)
    }
  } catch (_error) {}
  return ""
}

function findNormalLyricsFile(packageDir, manifest) {
  const lyrics = manifest?.lyrics || {}
  const manifestJson = findPackageFile(packageDir, lyrics.json || lyrics.lyricsJson || lyrics.path || "")
  if (manifestJson && fs.existsSync(manifestJson)) return manifestJson
  const manifestLrc = findPackageFile(packageDir, lyrics.lrc || "")
  if (manifestLrc && fs.existsSync(manifestLrc)) return manifestLrc
  try {
    const names = fs.readdirSync(packageDir)
    const firstShow0Lyric = names.find((name) => name.toLowerCase().endsWith(".lyrics.json") && !isRewriteLyricsFileName(name))
    if (firstShow0Lyric) return path.join(packageDir, firstShow0Lyric)
    const firstLrc = names.find((name) => path.extname(name).toLowerCase() === ".lrc" && !isRewriteLyricsFileName(name))
    if (firstLrc) return path.join(packageDir, firstLrc)
    const firstTextLyric = names.find((name) => path.extname(name).toLowerCase() === ".txt" && !isRewriteLyricsFileName(name))
    return firstTextLyric ? path.join(packageDir, firstTextLyric) : ""
  } catch (_error) {
    return ""
  }
}

function readShow0Lyrics(packageDir, rewriteMode) {
  const warnings = []
  const errors = []
  if (!packageDir || !fs.existsSync(packageDir)) {
    const message = "\u6b4c\u66f2\u672a\u4e0b\u8f7d / \u6b4c\u66f2\u5305\u7f3a\u5931"
    return { ok: false, rewriteMode, activeLyricSource: "normal", hasRewriteLyrics: false, usedRewriteLyrics: false, fallbackToNormalLyrics: false, lines: [], lyricPath: "", rewriteLyricPath: "", message, warnings, errors: [message] }
  }

  const manifest = safeJson(path.join(packageDir, "manifest.json"))
  const lyrics = manifest?.lyrics || {}
  const manifestRewritePath = lyrics.rewriteLyrics?.path || lyrics.rewriteLrc || ""
  const rewriteLyricPath = findPackageFile(packageDir, manifestRewritePath) || findRewriteLyricsFile(packageDir)
  const normalLyricPath = findNormalLyricsFile(packageDir, manifest)
  let targetPath = rewriteMode && rewriteLyricPath && fs.existsSync(rewriteLyricPath) ? rewriteLyricPath : normalLyricPath
  let usedRewriteLyrics = Boolean(rewriteMode && targetPath && rewriteLyricPath && path.resolve(targetPath) === path.resolve(rewriteLyricPath))
  const hasRewriteLyrics = Boolean(rewriteLyricPath)
  const activeLyricSource = usedRewriteLyrics ? "rewrite" : "normal"
  let fallbackToNormalLyrics = Boolean(rewriteMode && !usedRewriteLyrics)
  if (rewriteMode && !rewriteLyricPath) warnings.push("当前歌曲无改词版歌词")

  try {
    if (!targetPath || !fs.existsSync(targetPath)) throw new Error("No readable SHOW-0 lyric file found.")
    const lineItems = parseLyricsText(fs.readFileSync(targetPath, "utf8"), path.extname(targetPath).toLowerCase())
    if (!lineItems.length) throw new Error("SHOW-0 lyric file has no displayable lines.")
    const lines = lineItems.map((item) => item.text)
    return {
      ok: true,
      rewriteMode,
      activeLyricSource,
      hasRewriteLyrics,
      usedRewriteLyrics,
      fallbackToNormalLyrics,
      lines,
      lineItems,
      lyricPath: normalLyricPath || "",
      rewriteLyricPath: rewriteLyricPath || "",
      message: usedRewriteLyrics ? "Using rewrite lyrics." : fallbackToNormalLyrics ? "当前歌曲无改词版歌词，已显示普通歌词" : "Using normal lyrics.",
      warnings,
      errors,
    }
  } catch (error) {
    if (rewriteMode && targetPath === rewriteLyricPath && normalLyricPath && fs.existsSync(normalLyricPath)) {
      try {
        const lineItems = parseLyricsText(fs.readFileSync(normalLyricPath, "utf8"), path.extname(normalLyricPath).toLowerCase())
        const lines = lineItems.map((item) => item.text)
        return { ok: true, rewriteMode, activeLyricSource: "normal", hasRewriteLyrics, usedRewriteLyrics: false, fallbackToNormalLyrics: true, lines, lineItems, lyricPath: normalLyricPath, rewriteLyricPath: rewriteLyricPath || "", message: "改词版歌词读取失败，已显示普通歌词", warnings, errors: [error.message] }
      } catch (_fallbackError) {}
    }
    return { ok: false, rewriteMode, usedRewriteLyrics: false, fallbackToNormalLyrics, lines: [], lyricPath: normalLyricPath || "", rewriteLyricPath: rewriteLyricPath || "", message: error.message, warnings, errors: [error.message] }
  }
}

function createDesktopLyricsWindow() {
  if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) {
    desktopLyricsWindow.show()
    desktopLyricsWindow.focus()
    sendDesktopLyricsState(true)
    return desktopLyricsWindow
  }

  desktopLyricsWindow = new BrowserWindow({
    title: "SHOW-0 桌面歌词",
    width: DESKTOP_LYRICS_SIZE.width,
    height: DESKTOP_LYRICS_SIZE.height,
    minWidth: DESKTOP_LYRICS_MIN_SIZE.width,
    minHeight: DESKTOP_LYRICS_MIN_SIZE.height,
    transparent: true,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })

  desktopLyricsWindow.setAlwaysOnTop(true, "screen-saver")
  desktopLyricsWindow.on("closed", () => {
    desktopLyricsWindow = null
    sendDesktopLyricsState(false)
  })

  loadRoute(desktopLyricsWindow, "desktop-lyrics-window")
  desktopLyricsWindow.webContents.once("did-finish-load", sendDesktopLyricsPayload)
  sendDesktopLyricsState(true)
  return desktopLyricsWindow
}

function closeDesktopLyricsWindow() {
  if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) {
    desktopLyricsWindow.close()
  } else {
    desktopLyricsWindow = null
    sendDesktopLyricsState(false)
  }
  return { open: false }
}

app.whenReady().then(() => {
  startupLog("app.whenReady-entered")
  clearSongPackageTrash()
  setupKugouIpc(ipcMain, log)
  setupShow0ConfigIpc(ipcMain, log)
  setupLibraryIpc(ipcMain, log)

  ipcMain.handle("show0:minimize-window", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false
    mainWindow.minimize()
    return true
  })

  ipcMain.handle("show0:close-window", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false
    mainWindow.close()
    return true
  })

  ipcMain.handle("show0:set-window-resizable", (_event, resizable) => {
    if (!mainWindow) return false
    mainWindow.setResizable(Boolean(resizable))
    mainWindow.setMaximizable(Boolean(resizable))
    if (resizable) {
      mainWindow.setMinimumSize(PLAY_MIN_SIZE.width, PLAY_MIN_SIZE.height)
    } else {
      const [width, height] = mainWindow.getSize()
      mainWindow.setMinimumSize(width, height)
      mainWindow.setMaximumSize(width, height)
    }
    if (resizable) {
      mainWindow.setMaximumSize(10000, 10000)
    }
    return true
  })

  ipcMain.handle("show0:set-window-size", (_event, width, height) => {
    if (!mainWindow) return false
    const nextWidth = Number(width) || CREATE_SIZE.width
    const nextHeight = Number(height) || CREATE_SIZE.height
    mainWindow.setMinimumSize(Math.min(PLAY_MIN_SIZE.width, nextWidth), Math.min(PLAY_MIN_SIZE.height, nextHeight))
    mainWindow.setSize(nextWidth, nextHeight, true)
    return true
  })

  ipcMain.handle("show0:get-audio-devices", async (_event, payload = {}) => {
    const requestedHostApi = String(payload?.hostApi || "").trim()
    if (requestedHostApi) {
      const nativeDevices = runNativeAudioCore(["--devices", "--host-api", requestedHostApi])
      if (nativeDevices?.ok) {
        return {
          outputs: Array.isArray(nativeDevices.outputs) ? nativeDevices.outputs : [],
          inputs: Array.isArray(nativeDevices.inputs) ? nativeDevices.inputs : [],
          all: Array.isArray(nativeDevices.all) ? nativeDevices.all : [],
          backendType: "native_audio_core",
          hostApi: nativeDevices.hostApi || requestedHostApi,
          nativeExecutablePath: nativeDevices.executablePath || "",
        }
      }
      log("native audio devices failed: " + (nativeDevices?.error || "unknown error"))
    }
    if (!mainWindow) return { outputs: [], inputs: [], all: [] }
    try {
      return await mainWindow.webContents.executeJavaScript(`
        (async () => {
          if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
            return { outputs: [], inputs: [], all: [] }
          }
          const devices = await navigator.mediaDevices.enumerateDevices()
          const normalize = (device, index) => device.label || (device.kind === "audiooutput" ? "音频输出设备 " : "音频输入设备 ") + (index + 1)
          const outputs = devices.filter((device) => device.kind === "audiooutput").map(normalize)
          const inputs = devices.filter((device) => device.kind === "audioinput").map(normalize)
          return { outputs, inputs, all: Array.from(new Set([...outputs, ...inputs])) }
        })()
      `, true)
    } catch (error) {
      log("get-audio-devices failed: " + error.message)
      return { outputs: [], inputs: [], all: [] }
    }
  })

  ipcMain.handle("show0:open-desktop-lyrics", () => {
    createDesktopLyricsWindow()
    return { open: true }
  })

  ipcMain.handle("show0:close-desktop-lyrics", () => closeDesktopLyricsWindow())

  ipcMain.handle("show0:toggle-desktop-lyrics", () => {
    if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) {
      return closeDesktopLyricsWindow()
    }
    createDesktopLyricsWindow()
    return { open: true }
  })

  ipcMain.handle("show0:get-desktop-lyrics-state", () => ({
    open: Boolean(desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()),
  }))

  ipcMain.handle("show0:set-desktop-lyrics-locked", (_event, locked) => {
    if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return false
    desktopLyricsWindow.setResizable(!Boolean(locked))
    return true
  })

  ipcMain.handle("show0:set-desktop-lyrics-payload", (_event, payload) => {
    desktopLyricsPayload = {
      rewriteMode: Boolean(payload && payload.rewriteMode),
      usedRewriteLyrics: Boolean(payload && payload.usedRewriteLyrics),
      lines: Array.isArray(payload?.lines) ? payload.lines.map((line) => String(line)).filter(Boolean).slice(0, 200) : [],
      currentLineIndex: Math.max(0, Math.round(Number(payload?.currentLineIndex) || 0)),
      message: String(payload?.message || ""),
      modifiedLineIndexes: Array.isArray(payload?.modifiedLineIndexes) ? payload.modifiedLineIndexes.map((value) => Math.max(0, Math.round(Number(value) || 0))).slice(0, 200) : [],
    }
    sendDesktopLyricsPayload()
    return true
  })

  ipcMain.handle("show0:get-desktop-lyrics-payload", () => desktopLyricsPayload)
  ipcMain.handle("show0:read-song-package-manifest", (_event, songPackageDir) => readSongPackageManifest(String(songPackageDir || "")))
  ipcMain.handle("show0:resolve-song-cover", (_event, songPackageDir) => resolveSongCover(String(songPackageDir || "")))
  ipcMain.handle("show0:get-gate-control-state", () => ({ ok: true, state: readGateControlState(), status: readGatePluginStatus() }))
  ipcMain.handle("show0:set-gate-control-state", (_event, payload) => {
    const result = writeGateControlState(payload || {})
    return { ...result, status: readGatePluginStatus() }
  })
  ipcMain.handle("show0:get-gate-plugin-status", () => readGatePluginStatus())
  ipcMain.handle("show0:song-package-file-exists", (_event, songPackageDir, relativePath) => songPackageFileExists(String(songPackageDir || ""), String(relativePath || "")))
  ipcMain.handle("show0:read-song-package-json-resource", (_event, songPackageDir, relativePath) => readSongPackageJsonResource(String(songPackageDir || ""), String(relativePath || "")))
  ipcMain.handle("show0:resolve-playback-audio", (_event, songPackageDir) => resolvePlaybackAudio(String(songPackageDir || "")))
  ipcMain.handle("show0:get-audio-core-capabilities", () => getAudioCoreCapabilities())
  ipcMain.handle("show0:resolve-audio-core-tracks", (_event, songPackageDir) => resolveAudioCoreTracks(String(songPackageDir || "")))
  ipcMain.handle("show0:native-audio-core", async (_event, command, payload) => {
    try {
      const allowed = new Set(["load", "route", "play", "pause", "seek", "stop", "state", "unload"])
      const normalizedCommand = String(command || "")
      if (!allowed.has(normalizedCommand)) return { ok: false, error: "native audio command is not allowed" }
      return await nativeAudioCoreRequest(normalizedCommand, payload || {})
    } catch (error) {
      return { ok: false, error: error.message || String(error) }
    }
  })
  ipcMain.handle("show0:read-show0-lyrics", (_event, songPackageDir, rewriteMode) => readShow0Lyrics(String(songPackageDir || ""), Boolean(rewriteMode)))
  ipcMain.handle("show0:import-kugou-krc-lyrics", (_event, payload) => {
    try {
      return importKugouKrcLyrics(payload || {})
    } catch (error) {
      return { ok: false, error: error.message }
    }
  })
  ipcMain.handle("show0:update-song-package", (_event, payload) => {
    try {
      return updateSongPackageWithNativeWaveform(payload || {})
    } catch (error) {
      return { ok: false, error: error.message }
    }
  })
  ipcMain.handle("show0:create-song-package-from-imports", (_event, payload) => {
    try {
      return createSongPackageFromImports(payload || {})
    } catch (error) {
      return { ok: false, error: error.message }
    }
  })
  ipcMain.handle("show0:get-app-runtime-info", () => ({
    ok: true,
    installDir: app.isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, ".."),
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath || "",
    userDataDir: app.getPath("userData"),
  }))
  ipcMain.handle("show0:scan-data-migration-current", (_event, payload) => {
    try {
      return scanMigrationDataDir(String(payload?.currentDir || ""))
    } catch (error) {
      return { ok: false, errors: [error.message] }
    }
  })
  ipcMain.handle("show0:validate-data-migration-target", (_event, payload) => {
    try {
      return validateDataMigrationTarget(payload || {})
    } catch (error) {
      return { ok: false, errors: [error.message], warnings: [] }
    }
  })
  ipcMain.handle("show0:start-data-migration", (_event, payload) => startDataMigration(payload || {}))
  ipcMain.handle("show0:open-directory-if-exists", async (_event, dirPath) => {
    try {
      const target = path.resolve(String(dirPath || ""))
      if (!target || !fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
        return { ok: false, error: "目录不存在" }
      }
      const error = await shell.openPath(target)
      return error ? { ok: false, error } : { ok: true, path: target }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  })
  ipcMain.handle("show0:read-song-waveforms", (_event, songPackageDir) => {
    try {
      return readSongWaveforms(String(songPackageDir || ""))
    } catch (error) {
      return { ok: false, vocal: null, rewriteVocal: null, warnings: [error.message], error: error.message }
    }
  })
  ipcMain.handle("show0:move-song-package-to-temp-trash", (_event, songPackageDir) => {
    try {
      return moveSongPackageToTempTrash(String(songPackageDir || ""))
    } catch (error) {
      return { ok: false, error: error.message, sourcePath: String(songPackageDir || ""), trashRoot: songPackageTrashDir() }
    }
  })
  ipcMain.handle("show0:clear-temp-song-package-trash", () => clearSongPackageTrash())

  ipcMain.handle("show0:save-rewrite-edit", (_event, songPackageDir, edit) => {
    try {
      const packageDir = ensurePackageDir(songPackageDir)
      const filePath = path.join(packageDir, "rewrite_edits.json")
      const current = safeJson(filePath)
      const now = new Date().toISOString()
      const nextEdit = {
        id: String(edit?.id || `rewrite-${Date.now()}`),
        selectedText: String(edit?.selectedText || ""),
        rewrittenText: String(edit?.rewrittenText || ""),
        startLineIndex: Number.isFinite(Number(edit?.startLineIndex)) ? Number(edit.startLineIndex) : 0,
        endLineIndex: Number.isFinite(Number(edit?.endLineIndex)) ? Number(edit.endLineIndex) : 0,
        startCharIndex: edit?.startCharIndex ?? null,
        endCharIndex: edit?.endCharIndex ?? null,
        lyricIds: Array.isArray(edit?.lyricIds) ? edit.lyricIds : [],
        timeRange: edit?.timeRange || null,
        timingGranularity: edit?.timingGranularity === "char" ? "char" : "segment",
        charTimingAvailable: Boolean(edit?.charTimingAvailable),
        createdAt: String(edit?.createdAt || now),
        updatedAt: now,
      }
      const data = {
        version: "1.0.0",
        edits: Array.isArray(current?.edits) ? [...current.edits, nextEdit] : [nextEdit],
      }
      writeJson(filePath, data)
      return { ok: true, path: filePath }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  })

  ipcMain.handle("show0:select-rewrite-vocal-file", async () => {
    const result = await dialog.showOpenDialog(mainWindow || undefined, {
      title: "上传改词版人声",
      properties: ["openFile"],
      filters: [{ name: "Audio", extensions: ["wav", "mp3", "flac", "m4a", "aac", "ogg"] }],
    })
    if (result.canceled || !result.filePaths.length) return { canceled: true }
    const filePath = result.filePaths[0]
    const stat = fs.statSync(filePath)
    return { canceled: false, file: { path: filePath, name: path.basename(filePath), sizeBytes: stat.size, ext: path.extname(filePath).toLowerCase() } }
  })

  ipcMain.handle("show0:upload-rewrite-vocal-file", (_event, payload) => {
    try {
      const packageDir = ensurePackageDir(payload?.songPackageDir)
      const supported = new Set([".wav", ".mp3", ".flac", ".m4a", ".aac", ".ogg"])
      const sourceName = String(payload?.name || (payload?.sourcePath ? path.basename(String(payload.sourcePath)) : "rewrite-vocal.wav"))
      const ext = path.extname(sourceName).toLowerCase()
      if (!supported.has(ext)) throw new Error("Unsupported rewrite vocal audio format.")
      const manifest = safeJson(path.join(packageDir, "manifest.json")) || {}
      const normalizedFileName = `${safePackageFileName(packageDisplayName(packageDir, manifest))}(改词版)${ext}`
      const targetPath = path.join(packageDir, normalizedFileName)
      const exists = fs.existsSync(targetPath)
      if (exists && !payload?.replace) return { ok: false, error: "rewriteVocalExists", path: targetPath, fileName: normalizedFileName }
      if (payload?.sourcePath) {
        fs.copyFileSync(String(payload.sourcePath), targetPath)
      } else if (payload?.bytes) {
        fs.writeFileSync(targetPath, Buffer.from(payload.bytes))
      } else {
        throw new Error("No upload source was provided.")
      }
      const updatedManifest = updateRewriteVocalManifest(packageDir, normalizedFileName, ext)
      const waveformResult = generateSongWaveforms(packageDir, updatedManifest, { resolution: 1200, nativeWaveformReader: readWaveformWithNativeAudioCore })
      const latestManifest = safeJson(path.join(packageDir, "manifest.json")) || updatedManifest
      latestManifest.waveforms = {
        ...(latestManifest.waveforms && typeof latestManifest.waveforms === "object" ? latestManifest.waveforms : {}),
        ...waveformResult.waveforms,
      }
      latestManifest.analysis = {
        ...(latestManifest.analysis && typeof latestManifest.analysis === "object" ? latestManifest.analysis : {}),
        waveforms: latestManifest.waveforms,
        updatedAt: new Date().toISOString(),
      }
      writeJson(path.join(packageDir, "manifest.json"), latestManifest)
      return { ok: true, path: targetPath, fileName: path.basename(targetPath), normalizedFileName, manifestUpdated: true, replaced: exists, waveforms: latestManifest.waveforms, waveformWarnings: waveformResult.warnings, waveformErrors: waveformResult.errors }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  })

  createWindow()

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on("window-all-closed", () => {
  startupLog("window-all-closed", { platform: process.platform })
  if (process.platform !== "darwin") {
    app.quit()
  }
})

app.on("before-quit", () => {
  startupLog("before-quit")
  shutdownNativeAudioCoreServer()
  if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) {
    desktopLyricsWindow.destroy()
    desktopLyricsWindow = null
  }
})

app.on("will-quit", () => {
  startupLog("will-quit")
})

app.on("quit", (_event, exitCode) => {
  startupLog("quit", { exitCode })
})
