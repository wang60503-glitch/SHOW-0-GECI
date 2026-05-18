export type DesktopLyricsPayload = {
  rewriteMode: boolean
  usedRewriteLyrics: boolean
  lines: string[]
  currentLineIndex: number
  message: string
  modifiedLineIndexes: number[]
}
