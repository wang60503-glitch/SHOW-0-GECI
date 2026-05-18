/// <reference types="vite/client" />

import type { DesktopLyricsIncomingPayload } from "./desktop-lyrics/types"

declare global {
  interface Window {
    show0?: {
      getDesktopLyricsPayload?: () => Promise<DesktopLyricsIncomingPayload | null>
      onDesktopLyricsPayload?: (
        callback: (payload: DesktopLyricsIncomingPayload) => void,
      ) => (() => void) | undefined
      setDesktopLyricsLocked?: (locked: boolean) => Promise<void>
      closeDesktopLyrics?: () => Promise<void>
    }
  }
}

export {}
