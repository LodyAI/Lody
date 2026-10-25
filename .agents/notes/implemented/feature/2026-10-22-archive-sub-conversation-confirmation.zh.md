# 归档前确认是否一并归档子对话

Status: implemented
Translation: current

[English](2026-10-22-archive-sub-conversation-confirmation.md)

## 摘要

自 #1772 起，归档对话只归档其包含的 Tab，它开启的 Session 仍保持活跃，常常在已归档的开启者下无人察觉。
现在归档一个有未归档子对话的对话前，客户端会弹窗询问：显示子对话数量及其中仍在工作的数量，
并提供“全部归档”“仅归档此对话”和取消。递归归档因此成为用户的显式选择，而不是任一方向的默认。
CLI 与 MCP 归档仍只按包含关系。

## 决策

`readSessionOperationTargets` 新增 `archive-tree` 操作：`collectSessionTreeTargets` 沿包含关系和精确
opened-by 关系向下遍历，与停止协作使用相同的去重和防循环，但不会向上走到祖先。
`archiveSession(id, { includeOpenedSessions })` 选择该操作，默认的 `archive` 操作不变。

`useArchiveSessionWithConfirmation` 先读取一份 `archive-tree` 快照。弹窗只统计一等 Session
（无 `parentSessionId`）且未归档的后代；子对话自身或其 Tab 有实时 presence 即计为工作中。presence
在请求开始时读取一次，布局组件不订阅 presence 时钟。无需询问时（包括尚无元数据的待创建对话）直接归档。
弹窗宿主只有一个，挂在 `AuthenticatedWorkspaceContent`；未回答时的新请求会把旧请求按取消处理。
侧边栏行、移动端对话列表、会话头部和移动端当前 Tab 菜单均使用该 hook；按项目批量归档传入明确的 id
列表，保持直接归档。

原本在自己的弹窗里询问“归档对话？”的键盘快捷键，现在向同一个 hook 传入 `confirm: true`：没有子对话时，
共享弹窗询问这个普通问题（回车确认）；有子对话时，子对话选择是唯一的弹窗。任何归档流程都不会连续弹出两个弹窗。

用户选择后，`archiveSession` 与所有归档一样重新读取目标，因此弹窗期间新开启的 Session 也遵循用户的选择。
写入仍幂等且非事务，见[关系 Spec](../../../../specs/session-relations.zh.md)。

## 备选方案

- 恢复递归归档为默认（[后代归档决策](../bug-fix/2026-09-13-session-archive-descendants.zh.md)）会再次
  静默停止独立工作，这正是 #1772 移除的行为。
- 在已有的通用确认框中加复选框，覆盖不到不经过该确认的侧边栏和头部归档。

## 验证

`use-session-actions.test.ts` 通过 Repo 快照驱动真实的 hook 与弹窗：数量与工作中文案、“全部归档”
归档开启的 Session 及其 Tab、“仅归档此对话”与取消、无弹窗路径，以及始终确认路径只出现一个弹窗。
`session-operation-targets.test.ts` 覆盖 `archive-tree` 目标，并确认不包含开启者。
components 与 shared 类型检查、type-aware lint 通过；CLI 类型检查仅报告未构建的 ACP adapter 模块。
