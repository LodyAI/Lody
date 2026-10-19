# 对话中的 Turn 计时与活跃度

Status: implemented
Translation: current
Date: 2026-10-15
Language: Chinese
Other language: [English](2026-10-15-turn-timing-liveness.md)

## 摘要

运行中的 assistant turn 只显示已工作多久，看不出是否还在收到内容，用户分不清是在跑耗时命令还是已经卡住。现在 Turn configuration 弹窗会显示这一轮的开始时间、已运行或总用时。对 presence 显示正在运行的 turn，还会显示本设备上次收到实时输出距今多久，超过 60 秒后以弱警告样式标出。运行状态行在两分钟无输出后追加「N 分钟无输出」。这个时间是渲染端的内存记录，history、其 schema、同步协议和 `endedAt` 规则都没有变。只有本设备一直处于实时同步期间收到的输出才会显示时间；其余情况会说明原因：正在同步、已断开，或在等待用户确认。

## 需求

PR：[#1589](https://github.com/LodyAI/Lody/pull/1589)。

一位社区用户（Discord 帖子「More Detailed Turn Information」）想排查一个看上去正在跑 `local_bash` lint 检查的 turn。要判断它是在忙还是卡住，需要知道它的开始时间和最后一次历史更新的时间。

## 决定

- **开始、结束和时长都来自已有字段。** 开始时间优先用 `startedAt`，没有记录时用 `timestamp`；老条目只有 `timestamp`。进行中的时长和已结束的时长分别复用 `resolveLiveSessionHistoryDurationMs` 和 `resolveSessionHistoryDurationMs`。两者都是「Worked for」的口径，弹窗和状态行不会出现两个数。时间按用户本地时区显示：当天只显示带秒的时间，其他日期加上日期，跨年再加年份。悬停显示包含时区的完整日期时间。
- **更新时间是渲染端记录，不是存储数据。** `endedAt` 只在 finalize 时写一次，进行中的 turn 正是靠「没有 `endedAt`」来识别（#260）：流式过程中移动它会改变已结束 turn 的语义。单独持久化一个时间，则每个流式 delta 都要多写一次；而且 Roost history 只有 revision，没有时间。因此改为由 `ConversationView.lastUpdateAt` 记录后端报告历史变更的时间。Loro 和 Roost 共用这条 reader 路径。Roost 的实时通知由同一个 session 房间里的 `roostHistoryCursor` 驱动，不需要额外订阅。打开、hydration 和分页都不会改变这个时间。它也不会递增 `version`，因为使用方会在自己的时钟刷新时读取。
- **是否在运行由 presence 决定。** 只有最新的未结束 turn 所在 session 有 presence（与 Working 标签同一个信号）时，才显示运行时长和活跃度。daemon 在收尾前就退出的 turn 会在 history 里永远保持未结束，它只显示开始时间，不会显示「running 3d」或看似刚更新的时间。
- **只统计实时窗口内收到的输出。** session 页面把房间同步状态和浏览器联网状态合成为 `live`、`syncing` 或 `offline`。`useHistoryLiveWindow` 在每次进入 `live` 时开启一个新窗口：打开对话、切回对话、重连都会触发。早于窗口开始时间加 `LIVE_SYNC_SETTLE_MS`（一秒）的记录被视为追赶同步，显示为 `—`。因此，卡住很久之后才打开的对话永远不会看起来像刚有更新。
- **没有时间就说明原因。** 本设备离线时显示「已断开」，使用警告色；agent 等待权限决定时显示「等待你的确认」，不警告；正在同步或尚未收到实时输出时显示 `—`。只有真正收到的更新才显示距今时长。
- **阈值是常量。** `TURN_LAST_UPDATE_STALE_MS`（60 秒）让距今时长使用警告色，悬停提示 agent 可能在跑耗时命令，也可能卡住了。`TURN_SILENCE_NOTICE_MS`（2 分钟）在状态行追加「N 分钟无输出」，按整分钟显示，避免每秒变化。等待用户、离线或尚未收到实时输出时不会追加。状态行只陈述沉默时长，不加警告色，因为耗时命令本来就可能长时间没有输出。

## 考虑过的方案

- **流式过程中刷新 `endedAt`。** 否决：这会破坏只写一次的规则，也会改变 `canAppendAssistantDeltas` 和「Worked for」依赖的语义。
- **把 `lastUpdateAt` 写进 history。** 否决：每个 delta 都要多一次写入，还要改 schema。它衡量的也只是写入方的活动，而不是这个客户端实际收到了什么。
- **使用 Loro change 时间戳。** 暂不采用：Roost 没有对应的数据，而且写入方的时间戳会带来跨机器时钟偏差。渲染端记录比较的是同一台机器的本地时钟。
- **用 history 的 `finished` 判断是否在运行。** 评审后否决：没有收尾的 turn 会一直显示为正在运行。

## 局限

- 本地写入，例如回应权限请求或发送 steer 消息，也会更新这个时间。后端变更通知不携带来源信息。影响是警告最多晚一分钟出现。
- 刚进入实时同步的设备，在收到下一条输出前会显示 `—`，即使这一轮确实正在流式输出。
- 等待过权限的 turn 在结束前显示的时长仍会偏大。这个问题属于实时时长标签，见[桌面端实时 turn 时长](2026-09-17-desktop-live-turn-duration.zh.md)。

## 验证

`packages/components/tests/assistant-turn-timing.test.ts` 覆盖：

- 运行中、已结束、未收尾和缺字段四种 turn 的 row 数据，以及 `startedAt` 回退；
- 每种活跃度状态，包括追赶同步永远不算更新；
- 实时同步状态的映射和无输出阈值；
- 用固定时区验证跨本地午夜和跨年的时间格式。

`tests/conversation-view-from-reader.test.ts` 在真实 Loro 存储上验证：打开和区间 hydration 期间这个时间保持为 `null`，只有历史写入才会更新它。

`tests/agent-activity-row.test.tsx` 用模拟的时钟和 interval 定时器渲染真实的 stream，覆盖：

- 「no output for 4m」状态，以及等待用户时不出现；
- 超过警告阈值前后的运行中弹窗；
- 进入实时同步前后的追赶同步；
- 等待确认和已断开两种状态；
- 没有 presence 的未收尾 turn，以及已结束弹窗；
- `useHistoryLiveWindow` 在重连时重新开启窗口。

`AssistantTurnAlignment.stories.tsx` 提供 `DesktopTurnTimingLive` 和 `DesktopTurnTimingFinished` 用于视觉检查。没有复现真实的 daemon 卡住、真实断网，也没有在真实的 Roost 会话中验证。
