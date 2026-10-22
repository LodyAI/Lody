# Markdown 文件预览中的会话链接

Status: implemented
Translation: current

[English](2026-10-22-markdown-preview-session-links.md)

## 摘要

Markdown 文件预览缺少聊天中启用会话链接的上下文，因此把会话链接渲染为不可点击的文字。文件查看器现在用默认关闭的显式开关启用已有的会话链接 Provider。SessionDetail 从聊天使用的同一导航回调推导开关。有、无文件 provider 的两条路径都通过既有深链机制派发精确目标。组件测试覆盖导航和禁用行为；隔离桌面拒绝读取合成文件，桌面导航仍未验证。

## 决定与范围

SessionFileContentView 在两个 Markdown 渲染分支外持有 Provider。最强替代是在 SessionDetail 外层包住查看器。显式开关使独立查看器默认禁用导航，也能从真实文件预览入口做行为测试。Provider 继续负责精确目标派发，遵守[深链决定](../architecture/2026-09-29-lody-deep-links.zh.md)。开关不修改持久状态，无需数据修复。

MarkdownRenderer、URI 解析、Electron 协议策略、文件链接回调和标题锚点均保持原状。相对文件链接仍复制路径，HTTP(S) 链接仍打开外部目标，相对图片仍按文档路径与 provider 解析。

## 证据与限制

`NODE_ENV=test pnpm --filter @lody/components exec vitest run tests/session-file-content-view.test.tsx` 覆盖真实查看器。新用例在未修改的基线上失败，因为两个会话链接仍是 span；修复后通过，覆盖带工作区的规范 URI、历史链接，以及渲染后移除导航能力。既有相对图片用例也通过。

原测试覆盖预览渲染和图片，但没有点击会话链接。新增测试观察深链事件，不能证明桌面路由完成了目标会话切换。
桌面构建完成，也进入了真实右侧查看器，但查看器对合成本地项目文件显示 Access denied。
