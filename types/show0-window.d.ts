import type { DesktopLyricsNormalizedPayload } from "../show0-new-ui/desktop-lyrics-project/types"

declare global {
  interface Window {
    show0?: {
      getDesktopLyricsPayload?: () => Promise<Partial<DesktopLyricsNormalizedPayload> | null>
      onDesktopLyricsPayload?: (
        callback: (payload: Partial<DesktopLyricsNormalizedPayload>) => void,
      ) => (() => void) | undefined
      setDesktopLyricsLocked?: (locked: boolean) => Promise<void>
      closeDesktopLyrics?: () => Promise<void>
    }
  }
}

export {}
