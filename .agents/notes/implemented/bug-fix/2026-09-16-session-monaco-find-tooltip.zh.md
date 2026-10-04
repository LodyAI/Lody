# 让窄版 Session Monaco 的查找提示避开按钮

Status: implemented
Translation: current

[English](2026-09-16-session-monaco-find-tooltip.md)

## 摘要

Monaco 0.55 会给查找操作的文字提示设置行内换行，因此较长的提示在 Lody 的 320px
Session 编辑器中会折回并盖住触发它的按钮。提示跨过按钮边界后，Monaco 会反复移除并重建
它，造成闪烁，也让按钮难以可靠点击。现在只有 Session Monaco 的查找框可见时，这些标签
才保持单行；普通编辑器 hover 仍沿用 Monaco 的换行行为。现有窄版 Storybook 场景会验证
提示的几何位置和按钮点击行为。

## 决策

这个规避逻辑归 `SessionMonacoTextViewer` 所有，不做全局 Monaco 覆盖。Viewer 增加一个
稳定的作用域 class，相邻样式表只在该作用域包含可见 `.find-widget` 时，覆盖提示上的行内
`white-space: pre-wrap`。这样保留 `fixedOverflowWidgets: true`，让 Monaco 的其他溢出组件
仍可越过编辑器内容的裁剪边界，也不需要禁用 tooltip，或改变代码、诊断和 Markdown hover
的换行。

选择器刻意用可见的查找框作为状态信号。Monaco 把操作提示挂载在编辑器内容旁，而不是按钮
之下，所以普通后代选择器无法把提示限定到该按钮。桌面 renderer 和受支持的 Storybook
浏览器都提供 `:has()`，因此可以用声明式规则解决，无需增加 MutationObserver，在应用代码
中复制 Monaco 的生命周期状态。

## 证据与限制

`code-collab-stories-smoke.spec.ts` 驱动真实的 `RealtimeStatusBarNarrow` story：聚焦
Monaco、打开查找、悬停关闭操作，确认提示计算得到 `white-space: nowrap`、提示矩形不与
操作矩形相交，并点击该操作关闭查找。它在既有 harness 内覆盖可稳定复现的 320px 回归，
没有增加第二套测试设施。

该规避依赖 Monaco 当前的 `.find-widget.visible`、`.workbench-hover-container` 和
`.hover-contents` DOM class。它刻意保持局部；上游修复查找提示定位缺陷且去掉本规则后回归
仍能通过时，应删除它。它不改变其他 Monaco 使用方的窄版提示。
