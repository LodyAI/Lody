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
- 骨架屏参照 Discord，只有形状没有文字。它只在本地副本（IndexedDB，`openPersistedDoc`）读取完成后才
  决定：每次打开时 store 都先处于未就绪状态，在此之前就决定会让已有缓存的对话闪一下骨架屏。读取结果
  表明本地没有缓存时立即显示骨架屏，因为另一种选择是空白；读取超过 400ms 仍未完成时也会显示。修改后
  在 8 个已缓存对话间来回切换两轮，没有出现骨架屏，消息行在 130-380ms 内出现。
- "Updating"只在状态持续 400ms 后显示，出现后至少停留 500ms（`hooks/use-displayed-content-sync-state.ts`），
  正常打开什么都不显示。
- 曾尝试在对话末尾加一行"正在加载最新消息"，已移除：对话流里的转圈显得突兀。追平状态只由信息栏
  表达。
- 降级连接（reconnecting、disconnected、error）刻意不显示。此前的产品决定移除了"可能不是最新"状态，
  因为重连循环负责恢复（见 `.agents/docs/sessions-auto-review.md`）。浏览器离线仍由信息栏状态项提示。
  因此提议中的"保存副本"警告在该决定被复议前没有实现。

## 切换时不出现空白帧

对已在内存中打开的会话之间的切换做逐帧录屏，每次都有三帧空白（约 125ms）：store 即使已缓存也要经
promise 获取；初始尾部水合完成后还要再等一个 promise tick 才算就绪；显示是在 ResizeObserver 回调中
更新 state，React 会在之后的任务里提交，浏览器先画出了隐藏的对话。另外 Virtua 只能从下一帧的 scroll
事件得知我们恢复写入的 `scrollTop`，因此先渲染了旧区间（`offset-mismatch`、`target-unmounted`）。

- `ManagedStoreCache.peek` / `WorkspaceRuntime.peekSessionStore` 同步返回已打开的 store；
  `useSessionDoc` 在首次提交就渲染它，仍在 effect 中 acquire。
- `useTurnRange` 在整个区间已水合时于渲染阶段即为就绪。
- 显示时直接在视口上写 `visibility: visible`（React 随后提交同一个值）；显示前我们自己的滚动写入会派发
  `scroll` 事件，让 Virtua 在同一帧读到新的 offset。

在生产预览上对六个会话做第二轮切换：五个打开后画出的第一帧就是渲染好的对话。第六个仍有一帧空白：它的
缓存行高已过期，且挂载后才出现的 "Goal blocked" 横幅缩小了视口，两处修正都在下一帧的 ResizeObserver
中送达。不在内存中的会话（10 分钟后释放或刷新后）仍需从 IndexedDB 打开（`openPersistedDoc` 加上最长
1.5s 的 eager-sync 快照读取），做不到一帧内。

## 限制

首次追平信号无法判断保存的副本是否真的落后；如果追平超过 400ms，已经是最新的副本也会显示
"Updating"。移动端保留原有的顶部指示器。相关：[对话滚动 Spec](../../../../specs/conversation-scroll.md)。
