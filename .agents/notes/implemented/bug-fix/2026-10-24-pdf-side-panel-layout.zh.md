# PDF 侧边面板高度与适配缩放

Status: implemented
Translation: current

[English](2026-10-24-pdf-side-panel-layout.md)

## 摘要

会话侧边面板中的 PDF 滚动容器高度为零，直到缩略图在正常文档流中撑开高度才显示页面。PDF 现在使用已有的、自带滚动查看器的定高分支。容器 resize observer 同时重新应用预设适配模式，并保留用户明确选择的百分比缩放。

## 决策与证据

本次延续 [PDF 预览决策](../feature/2026-09-29-session-pdf-preview.zh.md)，解决 [#1731](https://github.com/LodyAI/Lody/issues/1731)。Base UI ScrollArea 迁移仍未给内容包装层提供确定高度。PDF 与 Office 预览一样由自身负责滚动，而不改变共享 ScrollArea 对其他内容的固有尺寸行为。

PDF.js 会缓存预设缩放。观察其滚动容器，等待宽高均非零后进行适配，并在尺寸变化时重新应用当前适配模式。明确的百分比缩放只调用 `update()`，不改变比例。随查看器清理断开 observer；保留打包 Worker 和已有的 abort/document 清理逻辑。

## 验证

在上游 `725f843fb` 的隔离 Linux Electron/Xvfb 中，PDF 滚动容器为 598×0 px，没有页面 canvas；打开缩略图后变为 426×760 px，第一页正常渲染。新打开和保留在折叠面板内的文件这两种真实布局 story 均在高度断言失败（应大于 400，实际为 0）。桌面夹具使用合成 PDF、离线 ACP provider 和隔离数据，并补入当前本地文件 IPC 所需的合成旧格式机器身份。

修复后，同一桌面的滚动容器为 598×809 px，第一页宽 558 px；拖至 468×809 px 后，页面随之适配为 428 px。两条布局用例及全部 14 条 PDF 验收用例通过，相关单测 75 项通过。本次不覆盖 macOS 和 Windows 桌面行为。
