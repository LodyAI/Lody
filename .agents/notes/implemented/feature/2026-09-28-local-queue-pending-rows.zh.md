# 走队列的上传消息以本地行显示在队列面板

Status: implemented
Translation: current

[English](2026-09-28-local-queue-pending-rows.md)

结论（2026-09-29）：已在 [#1095](https://github.com/LodyAI/Lody/pull/1095) 中实现，从 `proposed/` 移出。已被[移除会话发送日志](../simplification/2026-09-29-remove-session-send-journal.zh.md)部分替代：队列面板的本地行仍然保留，但数据来自内存中暂存的发送，而不是发送日志记录，操作只剩重试和取消。纯文本投影覆盖层已删除，因为就绪的发送现在会立即写入本地。

## 摘要

向正在工作的会话发送带附件的消息时，消息先以“等待发送”出现在会话流里，上传完成后又从那里消失、重新出现在队列面板中。用户看到同一条消息在两个地方之间跳动。现在走队列的消息从一开始就显示在队列面板里，作为真实队列项下方的本地行。这些行只存在于渲染进程的发送日志中；附件就绪前不向同步文档写入任何内容，符合 [Session files](../../../../specs/session-files.zh.md#63-direct--queue--guide) 的要求。空闲会话和 steer 发送不会跳动，保持原有的会话内待发送行。

## 原因

`pushMessageQueue` 把消息收进发送日志，设置 `record.queue` 和 `delivery.kind: 'queue'`。提交前，日志记录是唯一的表示，由 `SessionPendingMessages` 渲染在会话流里。提交时把队列项写入 `mq`，再由队列面板渲染。两处各自都没错，跳动来自两者之间的交接。

## 决策

- **是否走队列看 `Boolean(record.queue)`。** 只有 queue 路由会设置它。direct dispatch（空闲会话）和 guide（steer）不设置，渲染不变。`SessionPendingMessages` 排除走队列的记录，`MessageQueueDisplay` 显示它们。
- **只做展示，绝不提前写入。** 本地行不是队列项：它在可排序列表之外，不能拖动、编辑或 steer。它只提供日志本身的恢复操作：`saved` 时取消，`prepared` 时放弃，失败或中断时继续发送。每个操作之后都会继续推进该会话的 FIFO，与会话内待发送行一致。向 `mq` 写占位会让它在附件就绪前变得可执行，Spec 禁止这样做。
- **位置与交接一致。** 本地行按日志顺序排在真实队列项之后。提交会把真实队列项追加到 `mq` 末尾，所以接替的是同一个位置。标题计数包含本地行。
- **按 turn ID 去重，而不是按阶段。** workspace 的提交端口先写 `mq`，再把记录推进到 `committed`。有一瞬间，队列项和 `prepared` 记录同时存在。`selectPendingQueueRecords` 隐藏 ID 与某个队列项 `userTurnId` 相同的记录，因此每次渲染都只显示一行。
- **视觉连续。** 本地行沿用队列行的布局（序号、缩略图、两行文本），文字变灰，与侧边栏未发送标题一致。它显示上传进度环和“正在上传 · N%”，缩略图来自本地 Blob。交接时这一行以真实队列行重新挂载，缩略图改为加载已上传的图片。
- **渲染成本。** 上传进度是高频更新。`session-chat-interface` 只需要知道面板是否有内容（有面板时信息栏布局不同），所以读取 `useHasPendingQueueRecords`：一个布尔值的 `useSyncExternalStore` 快照，只在本地行出现或离开时变化。进度只在 `MessageQueueDisplay` 内订阅。
- **纯文本消息从不显示为待发送。** 没有附件的消息经过几次本地写入就会进入 history 或队列，但这些写入、资格检查读取和 flush 的耗时，仍足以让“等待发送”行闪一下。`isInstantSendRecord` 覆盖尚未失败或中断的纯文本记录：
  - dispatch 和 guide 路由通过 `acceptedSessionHistoryProjectionsAtom` 把记录叠加进对话。这是现有的叠加机制，history 中出现同一 ID 后自动去掉叠加条目。`SessionSendRecovery` 在按成员集合触发的 layout effect 中写入它，所以它和待发送行的移除在同一次绘制中完成，也不会随上传进度频繁更新。
  - 队列面板里的本地行和真实队列行一样，不显示状态。
  - 侧边栏不显示发送中标记。
  - 只叠加一个会话最前面连续的这类消息。排在更早上传之后的文本消息保持待发送行，否则会显示在它所等待的上传消息上方。
  - 失败或中断后，记录变回带恢复操作的待发送行。
- **上传 shimmer。** 大文件上传时，确定进度环可能长时间停在同一个百分比，看起来像卡住了。现在每 1.8 秒有一道短高光沿已填充的弧线移动（SVG mask 加 `stroke-dashoffset` 动画），`prefers-reduced-motion` 下隐藏。不确定进度环保持旋转。

## 备选方案

- 向 `mq` 写一个不可执行的占位：否决。队列是同步状态，每个消费者（daemon 提升、其他窗口、移动端）都得学会跳过它。
- 上传完成前什么都不显示：上传期间消息会从输入框悄无声息地消失。
- 保留会话内行，再用动画把它移进面板：仍然是两个位置，而且动画要跨越两个各自滚动的容器。

## 验证

- `tests/session-send-recovery.test.tsx` 使用真实的发送日志和队列面板。消息只以面板中的本地行出现，从不出现在会话流里：先是上传 40%，然后失败并显示“继续发送”。提交在写入 `mq` 后暂停时，面板恰好只有一行，就是真实队列项。投递完成后没有本地行。
- `tests/session-send-recovery.test.tsx` 也覆盖纯文本发送：提交被挡住时，纯文本消息已叠加进对话，没有待发送行，也没有侧边栏标记；排在上传消息之后时按顺序保持为待发送行；提交失败时显示“未发送”，侧边栏出现失败标记。
- Storybook：`Sessions/MessageQueueDisplay` 的 `LocalUploadRows` 和 `LocalUploadOnly`。

## 限制

- 交接是在同一位置重新挂载，而不是复用 DOM。真实队列行的缩略图从已上传的图片加载，可能短暂显示占位。
- 只有通过 queue 路由收进日志时才会设置 `record.queue`。guide 回退为后续队列项的发送，在提交前仍显示会话内的待发送行。

相关：[侧边栏发送状态](2026-09-28-sidebar-send-status.zh.md)、[daemon 接手的 guide 结果](../bug-fix/2026-09-28-daemon-owned-guide-outcome.zh.md)、[延迟附件发送](../architecture/2026-09-14-deferred-attachment-send.zh.md)。
