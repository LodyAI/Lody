# 嵌套弹窗遮罩顺序

Status: implemented
Translation: current

[English](2026-09-21-nested-dialog-overlays.md)

## 摘要

嵌套弹窗的两层遮罩都落在父面板下面，因为遮罩统一使用 z-index 70，面板统一使用 80。
共享 Dialog 遮罩现在与内容使用同一层级，与 AlertDialog 一致。Portal 的 DOM 顺序
让新打开的遮罩位于前一个面板和自己的面板之间。浏览器验证覆盖了 CSS 层叠；由于缺少
依赖，尚未验证应用交互。

## 决策与证据

[DialogOverlay](../../../../packages/components/src/ui/dialog.tsx) 为两种内容组件
统一修复。共用 `--z-dialog` 避免引入独立的嵌套计数器，并保留调用方覆盖、动画及
Radix 焦点和关闭处理。现有 popover portal 也采用同层级加 DOM 顺序的方式。
本次修复实现缺陷，没有改变产品意图。

独立 Chromium 示例在 70 时复现原有错误，在 80 时验证了两层和三层面板、顶层面板
位于其遮罩之上，以及移除子层后父面板恢复。该示例未运行 React 或 Radix。
当前检出没有 node_modules，Storybook 无法启动，未运行组件测试或类型检查。
`git diff --check` 通过。文档检查报告了已有的、指向缺失 ACP 子模块的失效链接。
