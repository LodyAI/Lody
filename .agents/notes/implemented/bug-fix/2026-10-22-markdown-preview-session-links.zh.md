# Markdown 文件预览中的会话链接

Status: implemented
Translation: current

[English](2026-10-22-markdown-preview-session-links.md)

## 摘要

Markdown 预览缺少 SessionLinkProvider，导致会话链接不可点击。查看器现在复用聊天的深链机制，导航默认关闭。作者在本地构建的桌面应用中，点击右侧 Markdown 预览里的 `lody://session/...` 链接，目标会话成功打开。

## 决定与范围

SessionFileContentView 在两个 Markdown 渲染分支外包住 SessionLinkProvider，SessionDetail 从聊天使用的同一导航回调启用它。选择由查看器持有 Provider，而非只在 SessionDetail 外层包住查看器，是为了从查看器入口测试两个分支，并保持独立查看器默认禁用。精确目标派发沿用既有[深链决定](../architecture/2026-09-29-lody-deep-links.zh.md)。

MarkdownRenderer、URI 解析、Electron 协议策略、文件链接回调和标题锚点均不变。相对路径仍复制，HTTP(S) 链接仍打开外部目标，图片仍按文档路径与 provider 解析。

## 证据

`NODE_ENV=test pnpm --filter @lody/components exec vitest run tests/session-file-content-view.test.tsx`

新用例在未修改的基线上失败，修复后全部 41 项测试通过。覆盖精确 URI 派发、历史链接、禁用导航、相对路径、外部链接和图片。
