# 侧边栏发送状态取代待发送面板

Status: proposed
Translation: current

[English](2026-09-28-sidebar-send-status.md)

## 摘要

工作区待发送面板（「待发送消息（1）」）浮在右下角，短上传时突然出现又消失，并与会话内的待发送行争夺注意力。加入动效（浮入、百分比进度条、打勾退出）后，它仍是一个独立且显眼的界面。现在删除该面板，未发出的消息改为显示在会话本来所在的位置：桌面侧边栏行。新会话的标题在首条消息进入历史前保持灰色；该行唯一的状态标记显示按已发送字节填充的圆环，发送停止时显示红色警示。恢复操作（继续发送、取消、丢弃）仍在会话内的待发送行上。以上全部是渲染进程本地状态，从不同步。

## 决策

- `deriveSessionSendStatuses`（`lib/session-send-status.ts`）按会话投影发送日志记录。只计入 `saved` 与 `prepared` 记录，即会话待发送行显示的集合；`committed` 记录已进入历史，按普通轮次显示。带 `error` 或 `activity: 'interrupted'` 的记录使该会话为 `failed`，否则为 `sending`。字节数取自附件源（或就绪大小）与各附件进度；没有可计量字节时圆环为不确定状态。
- `SessionSendRecovery` 只保留工作区职责：待发送占位元数据、日志刷新、退出保护与退出对话框。它写入 `sessionSendStatusesAtom`；日志读取失败改为 toast。
- 行优先级为 `failed > waiting > working > sending > unread`。发送失败优先于一切，因为没有别的机制会重试它；上传让位于 Agent 自身的活动。每行一个标记，位于 `SidebarRowEndSlot`。
- 上传进度是高频数据。只有行尾槽这个叶子组件订阅单会话状态（`sessionSendStatusAtomFamily`），因此 memo 化的行不会重渲染。标题读取布尔值 `sessionUnsentNewConversationAtomFamily`。折叠分组与布局组件读取不含进度的 `sessionSendStatesAtom`，它只在开始、失败和完成时变化。
- 折叠分组把 `failed` 与 `sending` 与其他状态一起计数，并画同一个标记；悬停描述新增「N 个发送失败」和「N 个正在发送」。
- 已有会话的后续消息只显示标记，标题不变灰。
- 发送日志把刚准入的记录发布为 `active`：准入调用方总会紧接着启动它的工作；若发布为中断，侧边栏会在准入与提交之间闪一下失败标记。刷新和工作结束会恢复实际观测值。
- 字节文案（「正在发送 · 12.4 MB / 38.0 MB」）是标记的 `aria-label`，不是 tooltip。行的覆盖链接与桌面悬停卡片拥有指针悬停；在行尾槽再加一个悬停界面会与它们同时打开。

## 备选方案

- 面板延迟约 10 秒出现：闪烁更少，但用户离开会话后会有很长一段无反馈。
- 保留带动效和隐藏按钮的面板：已实现并评审，仍是与行竞争的第二个界面。
- 发送时整行或所有标题变灰：后续消息属于普通会话；只有尚未存在于历史中的会话才应显示为临时状态。

## 验证

- `tests/session-send-recovery.test.tsx`：真实发送日志驱动新会话行从发送中（aria 字节数、灰色标题）到失败再到已发送（无标记、常规标题）。
- `tests/session-list-pr-badge.test.ts`：含发送状态的行优先级与折叠分组汇总。
- `tests/session-send-journal.test.ts`：准入即发布为活动工作。
- Storybook：`Components/Sidebar/Send Status`（`States`、`Live`）。

## 限制

- 移动端会话列表不显示发送状态；会话内的待发送行仍然显示。
- 面板中针对等待送达的 `committed` 记录的丢弃入口已移除；这些记录仍受退出保护，并通过会话重试。
- 指针悬停时看不到字节数。

相关：[走队列的上传消息以本地行显示在队列面板](2026-09-28-local-queue-pending-rows.zh.md)，其中也记录了进度环的上传 shimmer。
