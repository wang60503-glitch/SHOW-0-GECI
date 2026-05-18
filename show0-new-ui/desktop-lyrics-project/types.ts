import type { DesktopLyricsPayload } from "@/lib/show0-config/types"

export type DesktopLyricsIncomingPayload = Partial<DesktopLyricsPayload> & {
  currentLineProgress?: number
  lineProgress?: number
  progress?: number
  topLine?: string
  bottomLine?: string
  nextLine?: string
}

export type DesktopLyricsNormalizedPayload = DesktopLyricsPayload & {
  currentLineProgress: number
  topLine?: string
  bottomLine?: string
  nextLine?: string
}

export type DesktopLyricsRow = {
  key: "top" | "bottom"
  text: string
  align: "left" | "right"
  active: boolean
  progress: number
}

export type DesktopLyricsViewModel = {
  activeIndex: number
  activeLine: string
  rows: [DesktopLyricsRow, DesktopLyricsRow]
  rewriteMode: boolean
  usedRewriteLyrics: boolean
  modifiedLineIndexes: number[]
  message: string
}

export type DesktopLyricsBridge = {
  readPayload: () => Promise<DesktopLyricsNormalizedPayload | null>
  subscribePayload: (callback: (payload: DesktopLyricsNormalizedPayload) => void) => () => void
  setLocked: (locked: boolean) => Promise<void>
  closeWindow: () => Promise<void>
}

export const DESKTOP_LYRICS_FALLBACK_LINES = ["哪会怕有一天只你共我", "背弃了理想谁人都可以"]

export const DESKTOP_LYRICS_EMPTY_PAYLOAD: DesktopLyricsNormalizedPayload = {
  rewriteMode: false,
  usedRewriteLyrics: false,
  lines: DESKTOP_LYRICS_FALLBACK_LINES,
  currentLineIndex: 0,
  currentLineProgress: 1,
  message: "",
  modifiedLineIndexes: [],
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function toFiniteIndex(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0
}

function toLineProgress(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1
  const ratio = value > 1 ? value / 100 : value
  return clamp(ratio, 0, 1)
}

function optionalText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export function normalizeDesktopLyricsPayload(
  payload: DesktopLyricsIncomingPayload | null | undefined,
): DesktopLyricsNormalizedPayload {
  const lines = Array.isArray(payload?.lines)
    ? payload.lines.map((line) => String(line ?? "").trim()).filter(Boolean)
    : []

  return {
    rewriteMode: Boolean(payload?.rewriteMode),
    usedRewriteLyrics: Boolean(payload?.usedRewriteLyrics),
    lines: lines.length ? lines : DESKTOP_LYRICS_FALLBACK_LINES,
    currentLineIndex: toFiniteIndex(payload?.currentLineIndex),
    currentLineProgress: toLineProgress(payload?.currentLineProgress ?? payload?.lineProgress ?? payload?.progress),
    message: typeof payload?.message === "string" ? payload.message : "",
    modifiedLineIndexes: Array.isArray(payload?.modifiedLineIndexes)
      ? payload.modifiedLineIndexes.filter((index) => typeof index === "number" && Number.isFinite(index))
      : [],
    topLine: optionalText(payload?.topLine),
    bottomLine: optionalText(payload?.bottomLine),
    nextLine: optionalText(payload?.nextLine),
  }
}

export function createDesktopLyricsViewModel(payload: DesktopLyricsIncomingPayload): DesktopLyricsViewModel {
  const normalizedPayload = normalizeDesktopLyricsPayload(payload)
  const activeIndex = clamp(normalizedPayload.currentLineIndex, 0, normalizedPayload.lines.length - 1)
  const topIndex = activeIndex % 2 === 0 ? activeIndex : activeIndex - 1
  const bottomIndex = topIndex + 1
  const topLine = normalizedPayload.topLine || normalizedPayload.lines[topIndex] || DESKTOP_LYRICS_FALLBACK_LINES[0]
  const bottomLine =
    normalizedPayload.bottomLine ||
    normalizedPayload.nextLine ||
    normalizedPayload.lines[bottomIndex] ||
    DESKTOP_LYRICS_FALLBACK_LINES[1]
  const activeRow = activeIndex % 2 === 0 ? "top" : "bottom"

  return {
    activeIndex,
    activeLine: activeRow === "top" ? topLine : bottomLine,
    rows: [
      {
        key: "top",
        text: topLine,
        align: "left",
        active: activeRow === "top",
        progress: activeRow === "top" ? normalizedPayload.currentLineProgress : 0,
      },
      {
        key: "bottom",
        text: bottomLine,
        align: "right",
        active: activeRow === "bottom",
        progress: activeRow === "bottom" ? normalizedPayload.currentLineProgress : 0,
      },
    ],
    rewriteMode: normalizedPayload.rewriteMode,
    usedRewriteLyrics: normalizedPayload.usedRewriteLyrics,
    modifiedLineIndexes: normalizedPayload.modifiedLineIndexes || [],
    message: normalizedPayload.message || "",
  }
}
