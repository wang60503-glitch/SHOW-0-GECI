"use client"

import {
  Heart,
  Play,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import type { CSSProperties, PointerEvent, ReactNode } from "react"

import { createShow0DesktopLyricsBridge } from "./show0-bridge"
import { createDesktopLyricsViewModel, DESKTOP_LYRICS_EMPTY_PAYLOAD, type DesktopLyricsRow } from "./types"

const FRAME_WIDTH = 506
const FRAME_HEIGHT = 327
const WINDOW_PADDING_X = 4
const WINDOW_PADDING_TOP = 0
const WINDOW_PADDING_BOTTOM = 4
const SIDE_MASK_WIDTH = 8
const TOOLBAR_WIDTH = 494
const TOOLBAR_FRAME_WIDTH = FRAME_WIDTH
const TOOLBAR_FRAME_CENTER_OFFSET_X = 0
const TOOLBAR_HEIGHT = 30
const TOOLBAR_TOP_EXTENSION = 0
const TOOLBAR_TRANSPARENT_FRAME_TOP = 0
const TOOLBAR_ICON_ROW_OFFSET_Y = 3
const TOOLBAR_ICON_BOX_WIDTH = 22
const TOOLBAR_ICON_BOX_HEIGHT = 24
const TOOLBAR_ICON_VISUAL_SIZE = 16
const ICON_GROUP_ONE_SIDE_GAP = 16
const ICON_GROUP_ONE_OFFSET_X = -18
const TOOLBAR_ICON_GAP = 12
const ICON_TWO_TO_THREE_EXTRA_GAP = 4
const ICON_SIX_TO_SEVEN_EXTRA_GAP = 0
const ICON_GROUP_TWO_ICON_SEVEN_SHIFT_X = 5
const ICON_GROUP_TWO_ICON_EIGHT_SHIFT_X = 5
const ICON_GROUP_TWO_ICON_NINE_SHIFT_X = 1.5
const ICON_GROUP_THREE_ICON_TEN_SHIFT_X = 20.5
const ICON_GROUP_THREE_ICON_ELEVEN_SHIFT_X = 21
const ICON_GROUP_THREE_ICON_TWELVE_SHIFT_X = 18
const ICON_GROUP_THREE_ICON_THIRTEEN_SHIFT_X = 16.5
const TOOLBAR_ICON_ROW_WIDTH = 446
const SECOND_ICON_ROW_HEIGHT = 26
const TOP_CONTENT_SHIFT = 3
const LYRIC_DISPLAY_TOP = 35
const LYRIC_DISPLAY_BOTTOM_Y = 307
const LYRIC_DISPLAY_BOTTOM_GAP = FRAME_HEIGHT - LYRIC_DISPLAY_BOTTOM_Y
const LYRICS_TOP = TOOLBAR_HEIGHT + SECOND_ICON_ROW_HEIGHT - 3 - TOP_CONTENT_SHIFT
const LYRIC_MAX_FONT_SIZE = 96
const LYRIC_TEXT_HEIGHT = LYRIC_MAX_FONT_SIZE
const LYRIC_MIN_FONT_SIZE = 22
const LYRIC_ROW_MIN_FRAME_HEIGHT = LYRIC_TEXT_HEIGHT
const LYRIC_FRAME_VERTICAL_EXPAND = 0
const LYRIC_LINE_HEIGHT = LYRIC_TEXT_HEIGHT
const LYRIC_ROW_FRAME_HEIGHT = Math.max(LYRIC_TEXT_HEIGHT + LYRIC_FRAME_VERTICAL_EXPAND * 2, LYRIC_ROW_MIN_FRAME_HEIGHT)
const FIRST_LYRIC_ROW_LEFT = 14
const FIRST_LYRIC_ROW_RIGHT = 14
const SECOND_LYRIC_ROW_LEFT = FIRST_LYRIC_ROW_LEFT
const SECOND_LYRIC_ROW_RIGHT = FIRST_LYRIC_ROW_RIGHT
const FIRST_LYRIC_TOP_GAP = 0
const LYRIC_ROW_GAP = 56
const FIRST_LYRIC_ROW_OFFSET_Y = -5
const SECOND_LYRIC_ROW_OFFSET_Y = -5
const LYRIC_BOTTOM_GAP = TOOLBAR_HEIGHT + TOP_CONTENT_SHIFT - 4
const LYRIC_MIN_ROW_GAP = 11
const LYRIC_MIN_BOTTOM_GAP = 10
const LYRIC_RESIZE_HANDLE_HEIGHT = 8

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function getLyricSizeRatio(fontSize: number) {
  const clampedFontSize = clampNumber(fontSize, LYRIC_MIN_FONT_SIZE, LYRIC_MAX_FONT_SIZE)
  return (clampedFontSize - LYRIC_MIN_FONT_SIZE) / (LYRIC_MAX_FONT_SIZE - LYRIC_MIN_FONT_SIZE)
}

function getLyricMetrics(fontSize: number) {
  const clampedFontSize = clampNumber(Math.round(fontSize), LYRIC_MIN_FONT_SIZE, LYRIC_MAX_FONT_SIZE)
  const lyricSizeRatio = getLyricSizeRatio(clampedFontSize)
  const rowGap = Math.round(LYRIC_MIN_ROW_GAP + (LYRIC_ROW_GAP - LYRIC_MIN_ROW_GAP) * lyricSizeRatio)
  const bottomGap = Math.round(LYRIC_MIN_BOTTOM_GAP + (LYRIC_BOTTOM_GAP - LYRIC_MIN_BOTTOM_GAP) * lyricSizeRatio)
  const frameHeight = LYRICS_TOP + FIRST_LYRIC_TOP_GAP + clampedFontSize * 2 + rowGap + bottomGap

  return {
    fontSize: clampedFontSize,
    rowGap,
    bottomGap,
    frameHeight,
  }
}

function getLyricFontSizeForWindowHeight(windowHeight: number) {
  const targetFrameHeight = windowHeight - WINDOW_PADDING_TOP - WINDOW_PADDING_BOTTOM
  let bestFontSize = LYRIC_MIN_FONT_SIZE

  for (let fontSize = LYRIC_MIN_FONT_SIZE; fontSize <= LYRIC_MAX_FONT_SIZE; fontSize += 1) {
    if (getLyricMetrics(fontSize).frameHeight <= targetFrameHeight) {
      bestFontSize = fontSize
    }
  }

  return bestFontSize
}

type ToolbarButtonProps = {
  label: string
  active?: boolean
  icon: ReactNode
  onClick?: () => void
}

function ToolbarButton({ label, active = false, icon, onClick }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-active={active ? "true" : "false"}
      onClick={(event) => {
        event.stopPropagation()
        onClick?.()
      }}
    >
      {icon}
    </button>
  )
}

function LyricsModeIcon() {
  return (
    <svg className="desktopLyricsCustomIcon lyricsModeIcon" viewBox="0 0 42 40" aria-hidden="true">
      <path
        d="M11.2 32.2C4.7 24.2 5.75 12.65 14.45 6.4"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="5.2"
      />
      <path
        d="M18.6 0.05 3.2 5.8 11.9 14.15 18.6 0.05Z"
        fill="currentColor"
      />
      <rect x="22.4" y="10.8" width="15.9" height="22.2" rx="4" fill="none" stroke="currentColor" strokeWidth="4.6" />
    </svg>
  )
}

function FilledPreviousIcon() {
  return (
    <svg className="desktopLyricsCustomIcon filledPreviousIcon" viewBox="0 0 22 24" aria-hidden="true">
      <rect x="1" y="3" width="3.4" height="18" rx="1.5" fill="currentColor" />
      <path d="M18 2.75 Q19.35 2.35 19.35 3.85 L19.35 20.15 Q19.35 21.65 18 21.25 L5.75 13.25 Q4.45 12 5.75 10.75Z" fill="currentColor" />
    </svg>
  )
}

function FilledNextIcon() {
  return (
    <svg className="desktopLyricsCustomIcon filledNextIcon" viewBox="0 0 22 24" aria-hidden="true">
      <path d="M4 2.75 Q2.65 2.35 2.65 3.85 L2.65 20.15 Q2.65 21.65 4 21.25 L16.25 13.25 Q17.55 12 16.25 10.75Z" fill="currentColor" />
      <rect x="17.6" y="3" width="3.4" height="18" rx="1.5" fill="currentColor" />
    </svg>
  )
}

function FilledPauseIcon() {
  return (
    <svg className="desktopLyricsCustomIcon filledPauseIcon" viewBox="0 0 22 24" aria-hidden="true">
      <rect x="3.2" y="3" width="3.8" height="18" rx="1.6" fill="currentColor" />
      <rect x="13" y="3" width="3.8" height="18" rx="1.6" fill="currentColor" />
    </svg>
  )
}

function LyricsStepBackIcon() {
  return (
    <svg className="desktopLyricsCustomIcon stepBackIcon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2.3 12 13.2 1.25v5.55h5.5v10.4h-5.5v5.55L2.3 12Z" fill="currentColor" />
      <rect x="19.8" y="6.8" width="3.2" height="10.4" rx="0.1" fill="currentColor" />
    </svg>
  )
}

function LyricsStepForwardIcon() {
  return (
    <svg className="desktopLyricsCustomIcon stepForwardIcon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="1" y="6.8" width="3.2" height="10.4" rx="0.1" fill="currentColor" />
      <path d="M21.7 12 10.8 1.25v5.55H5.3v10.4h5.5v5.55L21.7 12Z" fill="currentColor" />
    </svg>
  )
}

function FilledStarIcon() {
  return (
    <svg className="desktopLyricsCustomIcon starIcon" viewBox="0 0 24 24" aria-hidden="true">
      <g transform="rotate(-20 12 12)">
        <path
          d="M12 1.35 15.05 8.25 22.15 9.15 16.8 13.95 18.3 21.15 12 17.4 5.7 21.15 7.2 13.95 1.85 9.15 8.95 8.25 12 1.35Z"
          fill="currentColor"
        />
        <path d="M3.25 3.05 6.45 4.35 9.15 1.95 8.85 5.35 11.2 5.95 8.2 7.45 8.45 10.15 6.15 8.1 3.25 9.25 4.95 6.45 2.65 4.45Z" fill="currentColor" opacity="0.82" />
      </g>
    </svg>
  )
}

function FishEffectIcon() {
  return (
    <svg className="desktopLyricsCustomIcon fishIcon" viewBox="0 0 34 24" aria-hidden="true">
      <path
        d="M1.6 5.1 7.4 9.45C8.95 6.05 13.3 4.3 18.2 5.55L13.9 0.35 28.35 9.05C30.85 9.45 32.45 10.42 32.95 11.55c.18.36.18.54 0 .9-.5 1.13-2.1 2.1-4.6 2.5L13.9 23.65l4.3-5.2C13.3 19.7 8.95 17.95 7.4 14.55L1.6 18.9V5.1Z"
        fill="currentColor"
      />
      <circle cx="27.05" cy="12" r="2.05" fill="#4f4f4f" />
    </svg>
  )
}

function SolidGearIcon() {
  return (
    <svg className="desktopLyricsCustomIcon gearIcon" viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <mask id="desktopLyricsGearHole">
          <rect width="24" height="24" fill="#ffffff" />
          <circle cx="12" cy="12" r="4.75" fill="#000000" />
        </mask>
      </defs>
      <g fill="currentColor" mask="url(#desktopLyricsGearHole)">
        <rect x="16.6" y="9.75" width="6.35" height="4.5" rx="0.95" />
        <rect x="16.6" y="9.75" width="6.35" height="4.5" rx="0.95" transform="rotate(60 12 12)" />
        <rect x="16.6" y="9.75" width="6.35" height="4.5" rx="0.95" transform="rotate(120 12 12)" />
        <rect x="16.6" y="9.75" width="6.35" height="4.5" rx="0.95" transform="rotate(180 12 12)" />
        <rect x="16.6" y="9.75" width="6.35" height="4.5" rx="0.95" transform="rotate(240 12 12)" />
        <rect x="16.6" y="9.75" width="6.35" height="4.5" rx="0.95" transform="rotate(300 12 12)" />
        <circle cx="12" cy="12" r="8.15" />
      </g>
    </svg>
  )
}

function FilledLockIcon({ locked }: { locked: boolean }) {
  return (
    <svg className="desktopLyricsCustomIcon filledLockIcon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d={
          locked
            ? "M7.2 11.25V7.35C7.2 4.45 9.25 2.65 12 2.65s4.8 1.8 4.8 4.7v3.9"
            : "M7.2 11.25V7.35C7.2 4.45 9.25 2.65 12 2.65c2.05 0 3.72 1.02 4.45 2.8"
        }
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.45"
      />
      <path
        d="M5.05 10.35H18.95C20.12 10.35 20.75 10.98 20.75 12.15V20.2C20.75 21.38 20.12 22 18.95 22H5.05C3.88 22 3.25 21.38 3.25 20.2V12.15C3.25 10.98 3.88 10.35 5.05 10.35ZM10.95 14.1H13.05V19.15H10.95V14.1Z"
        fill="currentColor"
        fillRule="evenodd"
      />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg className="desktopLyricsCustomIcon desktopLyricsCloseIcon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4.8 4.8 19.2 19.2" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3.1" />
      <path d="M19.2 4.8 4.8 19.2" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3.1" />
    </svg>
  )
}

function LyricsRow({ row }: { row: DesktopLyricsRow }) {
  const progressPercent = `${Math.round(row.progress * 1000) / 10}%`
  const style = { "--lyric-progress": progressPercent } as CSSProperties

  return (
    <div className={`desktopLyricsRow ${row.align}`} data-active={row.active ? "true" : "false"}>
      <span className="desktopLyricsText" style={style}>
        <span className="desktopLyricsTextBase">{row.text}</span>
        {row.active ? (
          <span className="desktopLyricsTextFill" aria-hidden="true">
            {row.text}
          </span>
        ) : null}
      </span>
    </div>
  )
}

export function DesktopLyricsProjectApp() {
  const bridge = useMemo(() => createShow0DesktopLyricsBridge(), [])
  const [payload, setPayload] = useState(DESKTOP_LYRICS_EMPTY_PAYLOAD)
  const [hovered, setHovered] = useState(false)
  const [locked, setLocked] = useState(false)
  const [playing, setPlaying] = useState(true)
  const [liked, setLiked] = useState(false)
  const [heartPulseKey, setHeartPulseKey] = useState(0)
  const [starred, setStarred] = useState(false)
  const [enhanced, setEnhanced] = useState(false)
  const [lyricFontSize, setLyricFontSize] = useState(LYRIC_MAX_FONT_SIZE)

  useEffect(() => {
    const originalBodyBackground = document.body.style.background
    const originalHtmlBackground = document.documentElement.style.background
    document.body.style.background = "transparent"
    document.documentElement.style.background = "transparent"

    return () => {
      document.body.style.background = originalBodyBackground
      document.documentElement.style.background = originalHtmlBackground
    }
  }, [])

  useEffect(() => {
    let alive = true

    void bridge.readPayload().then((nextPayload) => {
      if (alive && nextPayload) setPayload(nextPayload)
    })

    const unsubscribe = bridge.subscribePayload((nextPayload) => {
      setPayload(nextPayload)
    })

    return () => {
      alive = false
      unsubscribe()
    }
  }, [bridge])

  useEffect(() => {
    void bridge.setLocked(locked)
  }, [bridge, locked])

  const viewModel = useMemo(() => createDesktopLyricsViewModel(payload), [payload])
  const lyricMetrics = getLyricMetrics(lyricFontSize)
  const lyricLayoutStyle = {
    "--desktop-lyrics-font-size": `${lyricMetrics.fontSize}px`,
    "--desktop-lyrics-line-height": `${lyricMetrics.fontSize}px`,
    "--desktop-lyrics-row-gap": `${lyricMetrics.rowGap}px`,
    "--desktop-lyrics-frame-height": `${lyricMetrics.frameHeight}px`,
    "--desktop-lyrics-window-height": `${lyricMetrics.frameHeight + WINDOW_PADDING_TOP + WINDOW_PADDING_BOTTOM}px`,
  } as CSSProperties

  useEffect(() => {
    const syncLyricFontSizeToWindowHeight = () => {
      const nextFontSize = getLyricFontSizeForWindowHeight(window.innerHeight)
      setLyricFontSize((currentFontSize) => (currentFontSize === nextFontSize ? currentFontSize : nextFontSize))
    }

    window.addEventListener("resize", syncLyricFontSizeToWindowHeight)
    return () => {
      window.removeEventListener("resize", syncLyricFontSizeToWindowHeight)
    }
  }, [])

  function startLyricFontResize(edge: "top" | "bottom", event: PointerEvent<HTMLDivElement>) {
    event.preventDefault()
    event.stopPropagation()

    const startY = event.clientY
    const startFontSize = lyricFontSize
    const direction = edge === "bottom" ? 1 : -1

    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
      const deltaY = (moveEvent.clientY - startY) * direction
      setLyricFontSize(clampNumber(Math.round(startFontSize + deltaY), LYRIC_MIN_FONT_SIZE, LYRIC_MAX_FONT_SIZE))
    }

    const handlePointerUp = () => {
      document.body.style.cursor = ""
      window.removeEventListener("pointermove", handlePointerMove)
      window.removeEventListener("pointerup", handlePointerUp)
    }

    document.body.style.cursor = "ns-resize"
    window.addEventListener("pointermove", handlePointerMove)
    window.addEventListener("pointerup", handlePointerUp)
  }

  return (
    <main
      className="desktopLyricsProject"
      data-hovered={hovered ? "true" : "false"}
      data-locked={locked ? "true" : "false"}
      data-rewrite={viewModel.rewriteMode ? "true" : "false"}
      style={lyricLayoutStyle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <section className="desktopLyricsFrame" aria-label="SHOW-0 桌面歌词">
        <div className="desktopLyricsToolbar" role="toolbar" aria-label="桌面歌词图标区">
          <div className="desktopLyricsIconRow">
            <div className="desktopLyricsIconGroup desktopLyricsIconGroupOne">
              <ToolbarButton label="隐藏SHOW-0" icon={<span className="brandMark">S</span>} />
            </div>
            <ToolbarButton label="竖屏" icon={<LyricsModeIcon />} />
            <ToolbarButton label="上一首" icon={<FilledPreviousIcon />} />
            <ToolbarButton
              label={playing ? "暂停" : "播放"}
              icon={
                playing ? (
                  <FilledPauseIcon />
                ) : (
                  <Play className="desktopLyricsPlayIcon" size={TOOLBAR_ICON_VISUAL_SIZE + 2} strokeWidth={2.5} />
                )
              }
              onClick={() => setPlaying((value) => !value)}
            />
            <ToolbarButton label="下一首" icon={<FilledNextIcon />} />
            <ToolbarButton
              label="喜欢"
              active={liked}
              icon={
                <Heart
                  key={heartPulseKey}
                  className={heartPulseKey === 0 ? "desktopLyricsHeartIcon" : "desktopLyricsHeartIcon heartPulse"}
                  size={TOOLBAR_ICON_VISUAL_SIZE}
                  strokeWidth={2.7}
                />
              }
              onClick={() => {
                setLiked((value) => !value)
                setHeartPulseKey((value) => value + 1)
              }}
            />
            <ToolbarButton label="歌词后退0.5秒" icon={<LyricsStepBackIcon />} />
            <ToolbarButton label="歌词前进0.5秒" icon={<LyricsStepForwardIcon />} />
            <ToolbarButton
              label="打开滚动星图"
              active={starred}
              icon={<FilledStarIcon />}
              onClick={() => setStarred((value) => !value)}
            />
            <ToolbarButton
              label="效果"
              active={enhanced}
              icon={<FishEffectIcon />}
              onClick={() => setEnhanced((value) => !value)}
            />
            <ToolbarButton label="设置" icon={<SolidGearIcon />} />
            <ToolbarButton
              label={locked ? "解锁" : "锁定"}
              active={locked}
              icon={<FilledLockIcon locked={locked} />}
              onClick={() => setLocked((value) => !value)}
            />
            <ToolbarButton label="关闭" icon={<CloseIcon />} onClick={() => void bridge.closeWindow()} />
          </div>
        </div>

        <div className="desktopLyricsSecondIconRow" aria-hidden="true" />

        <div className="desktopLyricsArea" aria-live="polite">
          <div
            className="desktopLyricsResizeHandle desktopLyricsResizeHandleTop"
            aria-hidden="true"
            onPointerDown={(event) => startLyricFontResize("top", event)}
          />
          <div
            className="desktopLyricsResizeHandle desktopLyricsResizeHandleBottom"
            aria-hidden="true"
            onPointerDown={(event) => startLyricFontResize("bottom", event)}
          />
          <div className="desktopLyricsRows">
            <LyricsRow row={viewModel.rows[0]} />
            <LyricsRow row={viewModel.rows[1]} />
          </div>
        </div>
      </section>

      <style>{`
        .desktopLyricsProject {
          box-sizing: border-box;
          width: 100vw;
          height: 100vh;
          min-width: ${FRAME_WIDTH + WINDOW_PADDING_X * 2}px;
          min-height: 0;
          display: grid;
          justify-items: center;
          align-items: start;
          padding: ${WINDOW_PADDING_TOP}px ${WINDOW_PADDING_X}px ${WINDOW_PADDING_BOTTOM}px;
          overflow: hidden;
          background: transparent;
          color: #0aa8db;
          font-family: "Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", Arial, sans-serif;
          user-select: none;
        }

        .desktopLyricsProject *,
        .desktopLyricsProject *::before,
        .desktopLyricsProject *::after {
          box-sizing: border-box;
        }

        .desktopLyricsFrame {
          position: relative;
          width: ${FRAME_WIDTH}px;
          height: min(var(--desktop-lyrics-frame-height, ${FRAME_HEIGHT}px), calc(100vh - ${WINDOW_PADDING_TOP + WINDOW_PADDING_BOTTOM}px));
          max-width: calc(100vw - ${WINDOW_PADDING_X * 2}px);
          max-height: calc(100vh - ${WINDOW_PADDING_TOP + WINDOW_PADDING_BOTTOM}px);
          overflow: hidden;
          border: 3px solid transparent;
          border-radius: 0;
          background: rgba(160, 160, 160, 0.18);
          box-shadow: none;
          -webkit-app-region: drag;
        }

        .desktopLyricsFrame::before,
        .desktopLyricsFrame::after {
          content: "";
          position: absolute;
          top: ${TOOLBAR_HEIGHT}px;
          bottom: 0;
          z-index: 5;
          width: ${SIDE_MASK_WIDTH}px;
          background: transparent;
          pointer-events: none;
        }

        .desktopLyricsFrame::before {
          left: 0;
        }

        .desktopLyricsFrame::after {
          right: 0;
        }

        .desktopLyricsToolbar {
          position: absolute;
          top: -${3 + TOP_CONTENT_SHIFT + TOOLBAR_TOP_EXTENSION}px;
          left: 50%;
          z-index: 4;
          width: ${TOOLBAR_WIDTH}px;
          height: ${TOOLBAR_HEIGHT + TOOLBAR_TOP_EXTENSION}px;
          display: grid;
          place-items: center;
          padding-top: ${TOOLBAR_TOP_EXTENSION}px;
          border: 3px solid transparent;
          background: transparent;
          color: #d8dddd;
          transform: translateX(-50%);
          -webkit-app-region: drag;
        }

        .desktopLyricsToolbar::before {
          content: "";
          position: fixed;
          top: ${TOOLBAR_TRANSPARENT_FRAME_TOP}px;
          left: calc(50% + ${TOOLBAR_FRAME_CENTER_OFFSET_X}px);
          width: ${TOOLBAR_FRAME_WIDTH}px;
          height: ${TOOLBAR_HEIGHT}px;
          border: 0;
          background: transparent;
          transform: translateX(-50%);
          pointer-events: none;
        }

        .desktopLyricsIconRow {
          width: ${TOOLBAR_ICON_ROW_WIDTH}px;
          height: ${TOOLBAR_ICON_BOX_HEIGHT}px;
          display: flex;
          align-items: center;
          justify-content: flex-start;
          gap: ${TOOLBAR_ICON_GAP}px;
          transform: translateY(${TOOLBAR_ICON_ROW_OFFSET_Y}px);
        }

        .desktopLyricsToolbar button {
          width: ${TOOLBAR_ICON_BOX_WIDTH}px;
          height: ${TOOLBAR_ICON_BOX_HEIGHT}px;
          display: grid;
          place-items: center;
          padding: 0;
          border: 0;
          border-radius: 0;
          background: transparent;
          color: inherit;
          cursor: pointer;
          line-height: 1;
          -webkit-app-region: no-drag;
        }

        .desktopLyricsToolbar button:hover {
          color: #ffffff;
        }

        .desktopLyricsToolbar button:active {
          transform: translate(var(--toolbar-button-shift-x, 0), 1px);
        }

        .desktopLyricsToolbar button[aria-label="星标"] {
          color: #d8dddd;
        }

        .desktopLyricsToolbar button[data-active="true"] {
          color: #d8dddd;
        }

        .desktopLyricsIconGroup {
          height: ${TOOLBAR_ICON_BOX_HEIGHT}px;
          display: flex;
          align-items: center;
          justify-content: center;
          flex: 0 0 auto;
        }

        .desktopLyricsIconGroupOne {
          position: relative;
          width: ${TOOLBAR_ICON_VISUAL_SIZE + ICON_GROUP_ONE_SIDE_GAP * 2}px;
          margin-left: ${ICON_GROUP_ONE_OFFSET_X}px;
        }

        .desktopLyricsIconGroupOne::after {
          content: "";
          position: absolute;
          top: 6px;
          right: -4px;
          width: 1px;
          height: 12px;
          background: transparent;
          transform: scaleX(0.42);
          transform-origin: center;
          pointer-events: none;
        }

        .desktopLyricsIconRow > button:nth-of-type(2) {
          margin-left: ${ICON_TWO_TO_THREE_EXTRA_GAP}px;
        }

        .desktopLyricsIconRow > button:nth-of-type(3) {
          --toolbar-button-shift-x: -5px;
          transform: translateX(var(--toolbar-button-shift-x));
        }

        .desktopLyricsIconRow > button:nth-of-type(3) > svg {
          width: ${TOOLBAR_ICON_VISUAL_SIZE + 2}px;
          height: ${TOOLBAR_ICON_VISUAL_SIZE + 2}px;
        }

        .desktopLyricsIconRow > button:nth-of-type(4) {
          --toolbar-button-shift-x: -11px;
          transform: translateX(var(--toolbar-button-shift-x));
        }

        .desktopLyricsIconRow > button:nth-of-type(5) {
          position: relative;
          --toolbar-button-shift-x: -13px;
          transform: translateX(var(--toolbar-button-shift-x));
        }

        .desktopLyricsIconRow > button:nth-of-type(6) {
          margin-left: ${ICON_SIX_TO_SEVEN_EXTRA_GAP}px;
          --toolbar-button-shift-x: ${ICON_GROUP_TWO_ICON_SEVEN_SHIFT_X}px;
          transform: translateX(var(--toolbar-button-shift-x));
        }

        .desktopLyricsIconRow > button:nth-of-type(7) {
          --toolbar-button-shift-x: ${ICON_GROUP_TWO_ICON_EIGHT_SHIFT_X}px;
          transform: translateX(var(--toolbar-button-shift-x));
        }

        .desktopLyricsIconRow > button:nth-of-type(8) {
          position: relative;
          --toolbar-button-shift-x: ${ICON_GROUP_TWO_ICON_NINE_SHIFT_X}px;
          transform: translateX(var(--toolbar-button-shift-x));
        }

        .desktopLyricsIconRow > button:nth-of-type(9) {
          --toolbar-button-shift-x: ${ICON_GROUP_THREE_ICON_TEN_SHIFT_X}px;
          transform: translateX(var(--toolbar-button-shift-x));
        }

        .desktopLyricsIconRow > button:nth-of-type(8)[data-active="true"],
        .desktopLyricsIconRow > button:nth-of-type(9)[data-active="true"] {
          color: #1aa9ff;
        }

        .desktopLyricsToolbar button:hover {
          color: #f7ffff;
        }

        .desktopLyricsIconRow > button:nth-of-type(10) {
          --toolbar-button-shift-x: ${ICON_GROUP_THREE_ICON_ELEVEN_SHIFT_X}px;
          transform: translateX(var(--toolbar-button-shift-x));
        }

        .desktopLyricsIconRow > button:nth-of-type(11) {
          --toolbar-button-shift-x: ${ICON_GROUP_THREE_ICON_TWELVE_SHIFT_X}px;
          transform: translateX(var(--toolbar-button-shift-x));
        }

        .desktopLyricsIconRow > button:nth-of-type(12) {
          --toolbar-button-shift-x: ${ICON_GROUP_THREE_ICON_THIRTEEN_SHIFT_X}px;
          transform: translateX(var(--toolbar-button-shift-x));
        }

        .desktopLyricsToolbar button > svg,
        .desktopLyricsToolbar button > .desktopLyricsCustomIcon,
        .desktopLyricsToolbar button > .brandMark {
          align-self: center;
          justify-self: center;
          margin: auto;
        }

        .desktopLyricsCustomIcon {
          width: ${TOOLBAR_ICON_VISUAL_SIZE}px;
          height: ${TOOLBAR_ICON_VISUAL_SIZE}px;
          display: block;
          overflow: visible;
        }

        .desktopLyricsCustomIcon.lyricsModeIcon {
          width: ${TOOLBAR_ICON_VISUAL_SIZE + 1}px;
          height: ${TOOLBAR_ICON_VISUAL_SIZE + 2}px;
          transform: translateX(7px);
        }

        .desktopLyricsCustomIcon.stepBackIcon,
        .desktopLyricsCustomIcon.stepForwardIcon {
          width: 20px;
          height: 16px;
        }

        .desktopLyricsCustomIcon.fishIcon {
          width: 21px;
          height: 18px;
        }

        .desktopLyricsCustomIcon.gearIcon {
          width: 18px;
          height: 18px;
        }

        .desktopLyricsCustomIcon.filledLockIcon {
          width: ${TOOLBAR_ICON_VISUAL_SIZE}px;
          height: ${TOOLBAR_ICON_VISUAL_SIZE}px;
          transform: translateX(-1px);
        }

        .desktopLyricsCloseIcon {
          transform: translateX(-4.5px);
        }

        .desktopLyricsCustomIcon.starIcon {
          width: 19px;
          height: 19px;
        }

        .desktopLyricsHeartIcon {
          transform-origin: center;
          transform: translateX(-1px);
        }

        .desktopLyricsHeartIcon.heartPulse {
          color: #ff4f2e;
          fill: #ff4f2e;
          stroke: #ff4f2e;
          animation: desktopLyricsHeartPop 420ms ease-out both;
        }

        @keyframes desktopLyricsHeartPop {
          0% {
            transform: translateX(-1px) scale(1);
          }
          28% {
            transform: translateX(-1px) scale(0.78);
          }
          66% {
            transform: translateX(-1px) scale(1.28);
          }
          100% {
            transform: translateX(-1px) scale(1);
          }
        }

        .desktopLyricsToolbar button[aria-label="喜欢"][data-active="true"] {
          color: #ff7d9e;
        }

        .desktopLyricsSecondIconRow {
          position: absolute;
          top: ${TOOLBAR_HEIGHT - 3 - TOP_CONTENT_SHIFT}px;
          right: 0;
          left: 0;
          z-index: 1;
          height: ${SECOND_ICON_ROW_HEIGHT}px;
          background: transparent;
          -webkit-app-region: drag;
        }

        .brandMark {
          width: ${TOOLBAR_ICON_VISUAL_SIZE}px;
          height: ${TOOLBAR_ICON_VISUAL_SIZE}px;
          display: grid;
          place-items: center;
          border: 2px solid currentColor;
          border-radius: 50%;
          font-size: 10px;
          font-weight: 700;
          line-height: 1;
          transform: translateX(1px);
        }

        .desktopLyricsArea {
          position: absolute;
          top: ${LYRIC_DISPLAY_TOP}px;
          right: 0;
          bottom: ${LYRIC_DISPLAY_BOTTOM_GAP}px;
          left: 0;
          z-index: 2;
          overflow: hidden;
          border: 2px solid transparent;
          background: transparent;
          -webkit-app-region: drag;
        }

        .desktopLyricsResizeHandle {
          position: absolute;
          right: 0;
          left: 0;
          z-index: 8;
          height: ${LYRIC_RESIZE_HANDLE_HEIGHT}px;
          border: 0;
          background: transparent;
          cursor: ns-resize;
          -webkit-app-region: no-drag;
        }

        .desktopLyricsResizeHandleTop {
          top: 0;
        }

        .desktopLyricsResizeHandleBottom {
          bottom: 0;
        }

        .desktopLyricsRows {
          position: absolute;
          top: ${FIRST_LYRIC_TOP_GAP}px;
          right: 16px;
          bottom: 0;
          left: 16px;
          display: grid;
          grid-template-rows: var(--desktop-lyrics-line-height, ${LYRIC_LINE_HEIGHT}px) 1fr var(--desktop-lyrics-line-height, ${LYRIC_LINE_HEIGHT}px);
          align-content: stretch;
          row-gap: 0;
        }

        .desktopLyricsRow {
          min-width: 0;
          height: var(--desktop-lyrics-line-height, ${LYRIC_ROW_FRAME_HEIGHT}px);
          margin-top: -${LYRIC_FRAME_VERTICAL_EXPAND}px;
          display: flex;
          align-items: center;
          border: 0;
        }

        .desktopLyricsRow.left {
          justify-content: center;
          text-align: center;
        }

        .desktopLyricsRow.right {
          justify-content: center;
          text-align: center;
        }

        .desktopLyricsRows > .desktopLyricsRow:first-child {
          grid-row: 1;
          align-self: start;
          width: calc(100% - ${FIRST_LYRIC_ROW_LEFT + FIRST_LYRIC_ROW_RIGHT - 32}px);
          margin-left: ${FIRST_LYRIC_ROW_LEFT - 16}px;
          justify-content: flex-start;
          text-align: left;
          transform: translateY(${FIRST_LYRIC_ROW_OFFSET_Y}px);
        }

        .desktopLyricsRows > .desktopLyricsRow:last-child {
          grid-row: 3;
          align-self: end;
          width: calc(100% - ${SECOND_LYRIC_ROW_LEFT + SECOND_LYRIC_ROW_RIGHT - 32}px);
          margin-left: ${SECOND_LYRIC_ROW_LEFT - 16}px;
          justify-content: flex-end;
          text-align: right;
          transform: translateY(${SECOND_LYRIC_ROW_OFFSET_Y}px);
        }

        .desktopLyricsText {
          --lyric-progress: 100%;
          position: relative;
          width: max-content;
          max-width: 100%;
          height: var(--desktop-lyrics-line-height, ${LYRIC_ROW_FRAME_HEIGHT}px);
          display: inline-block;
          padding-top: ${LYRIC_FRAME_VERTICAL_EXPAND}px;
          overflow: hidden;
          white-space: nowrap;
          font-size: var(--desktop-lyrics-font-size, 96px);
          line-height: var(--desktop-lyrics-line-height, ${LYRIC_TEXT_HEIGHT}px);
          font-weight: 400;
          letter-spacing: 0;
          font-family: "Microsoft YaHei", "Microsoft YaHei UI", sans-serif;
        }

        .desktopLyricsTextBase,
        .desktopLyricsTextFill {
          display: block;
          height: var(--desktop-lyrics-line-height, ${LYRIC_TEXT_HEIGHT}px);
          overflow: hidden;
          white-space: nowrap;
          -webkit-text-stroke: 0.5px rgba(0, 0, 0, 0.96);
          paint-order: stroke fill;
          text-shadow:
            0 1px 0 rgba(190, 255, 255, 0.14),
            0 2px 4px rgba(0, 0, 0, 0.22);
        }

        .desktopLyricsTextBase {
          color: #0871aa;
          background: linear-gradient(
            to bottom,
            #076ca4 0%,
            #0871aa 25%,
            #0871aa 75%,
            #0978b2 100%
          );
          background-clip: text;
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
        }

        .desktopLyricsTextFill {
          position: absolute;
          top: ${LYRIC_FRAME_VERTICAL_EXPAND}px;
          left: 0;
          width: var(--lyric-progress);
          color: transparent;
          background: linear-gradient(
            to bottom,
            #4ffbff 0%,
            #4ffbff 25%,
            #ffffff 50%,
            #00ffff 100%
          );
          background-clip: text;
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          -webkit-text-stroke: 0.55px rgba(0, 0, 0, 0.98);
          paint-order: stroke fill;
          filter: brightness(1.14) saturate(1.08);
          text-shadow:
            0 0 1px rgba(255, 255, 255, 0.48),
            0 1px 0 rgba(235, 255, 255, 0.28),
            0 2px 4px rgba(0, 0, 0, 0.16);
        }

        .desktopLyricsProject[data-rewrite="true"] .desktopLyricsRow[data-active="true"] .desktopLyricsTextFill {
          color: transparent;
        }

        @media (max-width: 1200px) {
          .desktopLyricsProject {
            min-width: 920px;
          }
        }
      `}</style>
    </main>
  )
}
