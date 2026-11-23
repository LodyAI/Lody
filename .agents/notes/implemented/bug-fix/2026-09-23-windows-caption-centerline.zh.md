# 让窗口顶行对齐 Windows 标题按钮中线

Status: implemented
Translation: current

[English](2026-09-23-windows-caption-centerline.md)

## 摘要

在 Windows 上，所有 h-11 窗口顶行的控件中线在 y=22，而 OS 绘制的标题按钮
位于 36px 的 `titleBarOverlay` 条带中、中线在 y=18，导致头部图标比
— ▢ ✕ 按钮组低 4px。macOS 早已用 `useMacTrafficLightRowPadClass` 把各行
对齐到红绿灯中线；Windows 只有水平方向的 `pr-[144px]` 避让。新增的
`useWindowsCaptionRowPadClass`（`pb-2`，带下边框时 `pb-[7px]`）把行的
内容盒压到 36px，使控件中线落在 y=18，并应用到所有 macOS pad 已有的
调用点。Playwright 实测几何确认按钮中心从低于中线 4px 变为恰好落在
标题按钮中线上。验收在 macOS 上模拟了覆盖层——真实按钮并未渲染——但
36px 高度由我们主进程常量设定，并非猜测。

## 原因与归属

Windows 标题按钮不是网页内容：`window.ts` 设置 `titleBarStyle: 'hidden'`
加按主题着色的 `titleBarOverlay`，`window-theme.ts` 固定
`MAIN_WINDOW_TITLE_BAR_OVERLAY_HEIGHT = 36`。Electron 用三个约 46px 的
按钮填满该条带（因此有 `pr-[144px]`），字形中线在 y=18。此前的拖拽嵌入
模型把 Windows 当作"只预留水平空间"：`useWindowsCaptionPadClass` 让控件
避开按钮，却没有任何东西匹配其垂直中线——不像 macOS，
`useMacTrafficLightRowPadClass`（`pt-[2px]`/`pt-[3px]`）把每个 h-11 行
对齐到 y=23 的红绿灯。

`ui/window-drag-region.tsx` 现在导出对应的 Windows 版本：
`useWindowsCaptionRowPadClass({ bottomBorder })` 返回 `pb-2`（border-box
含 1px 下边框时返回 `pb-[7px]`），与其他嵌入一样以
`isWindowsElectronRenderer() && !useElectronFullscreen()` 为门槛。它应用
在每个已有的红绿灯行 pad 调用点：会话标签栏与右侧面板标签栏
（`session-detail.tsx`）、侧栏头部（`loro-sidebar.tsx`）、归档页头部
（`web-archive-screen.tsx`）。现在 Windows 顶部整条与 macOS 一样共享
一条中线。

## 证据与限制

- Playwright（伪造 `__LODY_PLATFORM__.os = 'win32'`）在模拟 36px WCO
  条带下渲染了生产版 `SessionTabBar` 组合：工具按钮中心实测在改动前
  低于标题按钮中线 4px，改动后恰好落在线上（评审时截图见
  `test-results/windows-caption-before-after.png`）。
- `@lody/components` 的 `tsgo --noEmit`、`window-drag-region` vitest
  套件、oxfmt 与 oxlint 均通过。
- 条带模拟是忠实的，因为其高度是我们自己的常量；真实 OS 按钮未在
  macOS 上渲染。分数缩放比例下 DIP 关系不变。`ZoomableImageViewer`
  的 56px 灯箱顶栏图标仍居中于 y=28——刻意不在本次范围内。
