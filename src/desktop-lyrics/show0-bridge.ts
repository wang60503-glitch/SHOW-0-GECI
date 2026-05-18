"use client"

import type { DesktopLyricsBridge, DesktopLyricsNormalizedPayload } from "./types"
import { normalizeDesktopLyricsPayload } from "./types"

function getShow0Api() {
  if (typeof window === "undefined") return undefined
  return window.show0
}

export function createShow0DesktopLyricsBridge(): DesktopLyricsBridge {
  return {
    async readPayload() {
      const payload = await getShow0Api()?.getDesktopLyricsPayload?.()
      return payload ? normalizeDesktopLyricsPayload(payload) : null
    },

    subscribePayload(callback: (payload: DesktopLyricsNormalizedPayload) => void) {
      const unsubscribe = getShow0Api()?.onDesktopLyricsPayload?.((payload) => {
        callback(normalizeDesktopLyricsPayload(payload))
      })

      return typeof unsubscribe === "function" ? unsubscribe : () => undefined
    },

    async setLocked(locked: boolean) {
      await getShow0Api()?.setDesktopLyricsLocked?.(locked)
    },

    async closeWindow() {
      await getShow0Api()?.closeDesktopLyrics?.()
    },
  }
}
