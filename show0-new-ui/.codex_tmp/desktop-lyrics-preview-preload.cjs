const { contextBridge, ipcRenderer } = require("electron")

const samplePayload = {
  rewriteMode: false,
  usedRewriteLyrics: false,
  lines: ["哪会怕有一天只你共我", "背弃了理想谁人都可以"],
  currentLineIndex: 0,
  currentLineProgress: 0,
  topLine: "我们等着说",
  bottomLine: "走到了晚风",
  message: "preview",
  modifiedLineIndexes: [],
}

contextBridge.exposeInMainWorld("show0", {
  version: "desktop-lyrics-preview",
  getDesktopLyricsPayload: async () => samplePayload,
  onDesktopLyricsPayload: (callback) => {
    let progress = 0
    let activeIndex = 0
    const timer = setInterval(() => {
      progress += 0.035
      if (progress >= 1) {
        progress = 0
        activeIndex = activeIndex === 0 ? 1 : 0
      }
      callback({
        ...samplePayload,
        currentLineIndex: activeIndex,
        currentLineProgress: progress,
      })
    }, 160)

    return () => clearInterval(timer)
  },
  setDesktopLyricsLocked: (locked) => ipcRenderer.invoke("preview:set-locked", Boolean(locked)),
  closeDesktopLyrics: () => ipcRenderer.invoke("preview:close"),
})
