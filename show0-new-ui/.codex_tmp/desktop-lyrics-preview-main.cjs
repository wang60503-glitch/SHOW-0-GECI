const { app, BrowserWindow, ipcMain } = require("electron")
const path = require("path")

let previewWindow = null

function createPreviewWindow() {
  previewWindow = new BrowserWindow({
    title: "SHOW-0 Desktop Lyrics Preview",
    width: 514,
    height: 331,
    minWidth: 508,
    minHeight: 107,
    transparent: true,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "desktop-lyrics-preview-preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  })

  previewWindow.setAlwaysOnTop(true, "screen-saver")
  previewWindow.loadURL("http://localhost:3010/desktop-lyrics-window")
  previewWindow.on("closed", () => {
    previewWindow = null
  })
}

app.whenReady().then(() => {
  ipcMain.handle("preview:set-locked", (_event, locked) => {
    if (!previewWindow || previewWindow.isDestroyed()) return false
    previewWindow.setResizable(!Boolean(locked))
    return true
  })

  ipcMain.handle("preview:close", () => {
    if (previewWindow && !previewWindow.isDestroyed()) previewWindow.close()
    return { open: false }
  })

  createPreviewWindow()
})

app.on("window-all-closed", () => {
  app.quit()
})
