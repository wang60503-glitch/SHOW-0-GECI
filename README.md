# SHOW-0-GECI Bolt Clean

This is a clean Bolt.new handoff for the SHOW-0 desktop lyrics UI.

Main file:

`src/desktop-lyrics/desktop-lyrics-app.tsx`

Preview entry:

`src/App.tsx`

## Scope

Only rebuild or continue the desktop lyrics UI. Do not build KuGou sync, audio playback, VST, KRC/LRC parsing, or SHOW-0 core logic.

## Final UI Rules

- visible frame max/base size: `506 x 327 px`
- minimum height target: about `107 px`
- toolbar/icon frame width: `506 px`
- toolbar/icon frame stays centered
- toolbar/icon frame does not resize with lyrics
- lyric display area starts around `35 px` from the top
- lyric display bottom is around `307 px` at full height
- lyric max font size: `96 px`
- lyric min font size: `22 px`
- first lyric line anchors top-left
- second lyric line anchors bottom-right
- no visible helper lines

## Color Rules

- default icon color: `#d8dddd`
- icon hover color: `#f7ffff`
- active icon blue: `#1aa9ff`
- unsung lyric gradient: `#076ca4 -> #0871aa -> #0978b2`
- sung lyric gradient: `#4ffbff -> #ffffff -> #00ffff`
- lyrics use a very thin black stroke for depth
