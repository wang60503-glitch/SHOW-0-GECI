# SHOW-0-GECI

This repository is a handoff package for rebuilding the SHOW-0 desktop lyrics UI in Bolt or v0.

Open the app from the repository root. The main preview entry is:

`app/page.tsx`

The main desktop lyrics component is:

`show0-new-ui/desktop-lyrics-project/desktop-lyrics-app.tsx`

## Scope

Only rebuild or continue the desktop lyrics UI.

Do not implement:

- KuGou sync
- real audio playback
- VST
- KRC or LRC parsing
- SHOW-0 core state machine changes

## Final Size Rules

- visible desktop lyrics frame: `506 x 327 px`
- icon frame width: `506 px`
- icon frame stays centered
- icon frame does not resize with the lyric display area
- minimum outer window height target: about `107 px`
- lyric font maximum: `96 px`
- lyric font minimum: `22 px`
- lyric area top starts around `35 px`
- lyric area bottom is around `307 px` at max height

## Layout Rules

- no visible guide lines
- no green, red, yellow, or blue helper lines
- first lyric line anchors to top-left
- second lyric line anchors to bottom-right
- when height shrinks, the lyric display area and lyric font shrink
- when width shrinks, do not shrink the font; later use horizontal scrolling

## Color Rules

- default icon color: `#d8dddd`
- hover icon color: `#f7ffff`
- active blue icon color: `#1aa9ff`
- unsung lyric gradient: `#076ca4 -> #0871aa -> #0978b2`
- sung lyric gradient: `#4ffbff -> #ffffff -> #00ffff`
- lyric strokes should have a very thin black outline for depth

## Notes For Bolt

Use the current UI as the source of truth. Keep the toolbar/icon row stable, and only allow the lyric display area and lyric font to resize with height changes.
