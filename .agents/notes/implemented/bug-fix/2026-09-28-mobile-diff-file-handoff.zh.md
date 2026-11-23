# 从移动端 diff 打开源文件时关闭 diff 弹层

Status: implemented
Date: 2026-09-28
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1076
[English](2026-09-28-mobile-diff-file-handoff.md)

## 摘要

从移动端 diff 标题打开源文件时，diff 弹层仍覆盖在文件查看器上方，使操作看起来没有反应。会话页面现在先关闭移动端 diff 弹层，再调用现有文件打开流程。该修复保留规范文件路径及查看器标签复用，同时让目标页面可见。关闭文件查看器后返回对话，不恢复已关闭的 diff 弹层。

## 决策与证据

`handleOpenFileFromDiff` 原先仅调用 `handleOpenFile`。后者经由 `upsertViewerTab` 在移动端打开 `MobileFileViewerDrawer`，却不清除 `mobileDiffState`。diff 使用 UI drawer 的模态层级 80，文件抽屉仍使用旧 Vaul 层级 50。

现在 diff 操作会在移动端先调用 `handleCloseMobileDiff`，然后开始解析文件，与现有移动端 Files 浏览器的切换方式一致。提高全局抽屉层级会影响无关浮层，并留下两个同时激活的模态组件。桌面端继续使用原有文件打开回调。

当前实现背景：[会话文件界面](../../../docs/sessions-file-surfaces.md)。

## 验证

本次是局部事件处理修正，未添加源码字符串断言或仅检查 mock 调用的测试。检查历史 diff 和 All Changes 移动端弹层的回调接线。仍需设备验证：打开任一种 diff 弹层，点击文件打开按钮，确认文件查看器可见且可操作，然后关闭并回到对话。自动检查结果记录于 PR。

现有 diff 标题及移动端文件抽屉测试通过，共 5 项。组件包类型检查、改动文件 Oxlint、格式化及空白检查通过。全量 `pnpm check` 因缺少 Claude、Codex、Grok 子模块而停在 CLI 类型检查。文档检查仍报告无关的失效链接。
