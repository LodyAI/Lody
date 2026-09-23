# 对话加载状态

Status: implemented
Translation: current

[English](2026-09-23-conversation-loading-states.md)

## 摘要

打开一个历史尚未同步到本设备的对话时，界面一片空白：本地没有任何 turn 的副本被当成空对话处理，
空状态什么都不渲染，信息栏的 Syncing 指示器也对空对话关闭。看起来像卡住而不是在加载。现在打开对话
时区分三种情况：本地没有缓存（内容区显示消息骨架屏）、已有保存的副本但仍在追平（信息栏显示
"Updating"）、已是最新。有单元测试覆盖，但尚未在真实的未缓存打开
中检查桌面端的视觉效果。

## 决策

- `lib/session-content-sync-state.ts` 是纯函数判定。"是否有消息"来自 `SessionMeta.lastMessageAt`，
  而不是不得驱动 UI 的 CLI 派发指针（`latestUserMsgId`）。"已追平"在一次打开内是粘性的：一旦房间
  达到 `synced`，之后的 `syncing` 抖动属于当前副本上的实时输出，不再提示。
- 骨架屏参照 Discord，只有形状没有文字，并立即显示，因为另一种选择是空白。"Updating"只在状态持续 400ms 后显示，出现后至少停留 500ms（`hooks/use-displayed-content-sync-state.ts`），
  正常打开什么都不显示。
- 曾尝试在对话末尾加一行"正在加载最新消息"，已移除：对话流里的转圈显得突兀。追平状态只由信息栏
  表达。
- 降级连接（reconnecting、disconnected、error）刻意不显示。此前的产品决定移除了"可能不是最新"状态，
  因为重连循环负责恢复（见 `.agents/docs/sessions-auto-review.md`）。浏览器离线仍由信息栏状态项提示。
  因此提议中的"保存副本"警告在该决定被复议前没有实现。

## 限制

首次追平信号无法判断保存的副本是否真的落后；如果追平超过 400ms，已经是最新的副本也会显示
"Updating"。移动端保留原有的顶部指示器。相关：[对话滚动 Spec](../../../../specs/conversation-scroll.md)。
