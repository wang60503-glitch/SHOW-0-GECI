# SHOW-0 Desktop Lyrics UI

请直接根据这个包重建 SHOW-0 桌面歌词 UI。

只做桌面歌词界面，不要扩展到酷狗同步、音频播放、VST、歌词解析或其他业务逻辑。

## Main File

优先看这个文件：

`show0-new-ui/desktop-lyrics-project/desktop-lyrics-app.tsx`

它包含：

- 桌面歌词主界面
- 图标行
- 歌词显示框
- 两行歌词位置
- 歌词颜色
- 图标颜色
- 字体最大/最小限制
- 窗口高度缩放规则

## Core Size Rules

- 可见桌面歌词框：`506 x 327 px`
- Electron 外层窗口默认：`514 x 331 px`
- Electron 外层窗口最小：`508 x 107 px`
- 图标框长度：`506 px`
- 图标框保持居中
- 图标框不跟随歌词框宽高变化

## Lyric Frame Rules

- 歌词显示框不显示任何线。
- 不要显示绿色线、红色线、黄色线、蓝色线。
- 最大状态下：
  - 顶边距窗口顶部：`35 px`
  - 底边约在窗口顶部：`307 px`
  - 高度约：`272 px`
- 窗口高度缩小时，歌词显示框跟着缩小。
- 第一排歌词固定靠左上。
- 第二排歌词固定靠右下。
- 每行只保留自己的文字字框，不保留旧的整行大框。

## Font Rules

- 歌词最大字体：`96 px`
- 歌词最小字体：`22 px`
- 高度缩小时字体跟着变小。
- 宽度变短时，不靠缩小字体解决，后续应做横向滚动。

## Color Rules

- 图标默认颜色：`#d8dddd`
- 图标悬停颜色：`#f7ffff`
- 激活蓝色：`#1aa9ff`
- 没唱歌词：`#076ca4 -> #0871aa -> #0978b2`
- 唱完歌词：`#4ffbff -> #ffffff -> #00ffff`
- 歌词笔画外有很细黑边，用于阴影和立体感。

## More Detailed Docs

看这些说明：

- `v0.app使用说明.md`
- `desktop-lyrics-frame-only-20260518_164919/歌词框规则说明.md`
- `desktop-lyrics-frame-only-20260518_164919/歌词框相关代码位置.md`
- `desktop-lyrics-frame-only-20260518_164919/字体颜色和图标颜色.md`
- `desktop-lyrics-resize-rules-20260518_164609/桌面歌词缩放规则说明.md`

## Do Not Change

- 不要改音频播放。
- 不要改酷狗同步。
- 不要改核心状态机。
- 不要做 KRC/LRC 解析。
- 不要做 VST。
- 不要把辅助线显示出来。
