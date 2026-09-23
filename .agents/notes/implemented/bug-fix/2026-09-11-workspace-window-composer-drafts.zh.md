# 工作区窗口 Composer 草稿隔离

Status: implemented
Translation: current

[English](2026-09-11-workspace-window-composer-drafts.md)

## 摘要

新建对话的附件已按工作区隔离，但持久化的文本、粘贴内容和 mention ranges 仍使用用户级 localStorage 键，导致不同工作区窗口互相显示和覆盖草稿。本次将整个 landing draft 统一按用户/表面与 workspace slug 分键。工作区窗口是平级的，都使用 durable localStorage，不按打开来源改变草稿生命周期。旧的全局草稿无法可靠判断所属工作区，因此不自动迁移。

## 问题

`buildChatLandingDraftKey` 已为附件和预留 session id 组合 workspace slug，但 `chatLandingSessionStateAtomFamily` 只接收用户键。Electron 的 BrowserWindow 共享 localStorage，所以在两个工作区窗口中输入时，prompt、pasted text 和 mention ranges 实际写入同一项。

## 决策

- 所有 landing draft 状态使用同一个 `buildChatLandingDraftKey`，在 workspace id 尚未解析时以稳定的路由 slug 隔离。
- 所有工作区窗口使用 localStorage 持久化 Composer 草稿。`windowStorage` 的逐窗口存储适用于导航和布局，不适用于工作区归属的草稿。
- 不读取或复制旧的用户级草稿键。该数据没有 workspace 归属，自动迁移到当前窗口会在错误工作区泄露内容。

此修复落实[桌面多窗口 Spec](../../../../specs/desktop-windows.zh.md)中工作区草稿隔离的要求，并补足[多窗口实现提案](../../proposed/feature/2026-09-10-desktop-windows.zh.md)未覆盖的 landing composer 状态。

## 验证

组件测试覆盖同一用户在两个 workspace 中分别持久化和恢复 prompt，以及工作区窗口不因打开来源改变持久化行为。附件、预留 session id、路由卸载恢复和清空行为继续由同一套件覆盖。

- `pnpm --filter @lody/components exec vitest run tests/chat-landing-draft-persistence.test.tsx`
- `pnpm check`
- `pnpm run docs check`
