# 配额耗尽时，PR 轮询把每一个外部事件都变成了一次完整唤醒

Status: implemented
Translation: current

[English](2026-09-16-pr-poller-gated-wake-amplification.md)

## 摘要

六个仓库共用一份 GitHub 凭据、桶按 4 点/分钟回填时，空桶是 reconciler 的稳态而非边缘
情况。在该状态下轮询器每分钟唤醒约 14.6 次，而设计值是 ≤2 次——证据取自
`~/.lody/logs/2026-09-16.log.1`：按 400 ms 间隔把 2239 条 `Bucket empty` 归并成唤醒
轮次，在包含这些日志的 70 分钟内统计得出。每次唤醒都会重建 target 集合、逐个仓库解析
凭据，然后才发现 scope 已被 gate 住，并为每个仓库写一条日志。多出来的唤醒来自两条外部
触发路径——presence 心跳，以及与 PR 无关的 session 元数据写入——它们都直接调用
`runWake`。修复把 `scheduleWake` 变成唯一的唤醒入口（只能把唤醒提前，绝不能越过 gate），
在解析凭据之前就用上一轮观测到的 `仓库 → 凭据 scope` 丢弃被 gate 住的批次，并把 scope
级跳过日志限制为每个 gate 窗口一条。scope 映射刻意在十分钟后过期：按记住的 scope 做
gate 只是一个快速否定判断，若不过期，一次长时间冻结会把一份新可用、且属于另一个健康
scope 的凭据永远挡在外面。

## 被否定的诊断，与成立的诊断

有人提出这是 `scheduleWake()` 中 `anyDue ? nowMs : …` 造成的 livelock，该结论不成立。
`scheduleWake()` 原本只有两个调用点：`start()` 和 workspace ready 路径；`runWake()`
结尾调用 `computeNextWakeAtMs`，它只会被 `dueAtMs > nowMs` 的 target 拉低，所以被跳过
但仍然 due 的 target 不会把下一次唤醒拉回 now；而且 `preflightScope` 早已把
`scopeQuotaAvailableAtMs(...)` 推入 `deferredHints`。"跳过即进入 deferred wake" 本就是
现状，未作改动。

日志真正显示的是唤醒循环之外的放大。两条外部路径完全绕过 `scheduleWake`，直接排入
`runWake`：

- `onSessionMetadataChanged` → `scheduleMetadataUpdate`（2 s 防抖）→
  `applyPendingSessionMetadata`：只要成功读到本机 session 的 meta 就无条件置
  `changed = true`，不比较内容。于是 title、`lastReadAt`、status、用量这类写入——也就是
  session 元数据流量的主体——都会买到一次完整重投影加一次唤醒。
- `onPresenceChanged`（1 s 防抖）→ `runWake`，于是查看心跳（包括卡住 session 每 10 秒
  一次的心跳）每次都会拉起唤醒。

`runWake` 随后直接进入批次循环，不先判断 scope 是否已被 gate 住，因此每次唤醒的代价是
每个仓库一次 `resolveCredential` 加一条 `Bucket empty` 日志。

这个代价是结构性的而非偶发：`pr-poller-config.ts` 默认
`bucketRefillPointsPerMinute: 4`、`bucketCapacityPoints: 20`，对六个仓库而言桶空的时间
远多于非空。

## 改动内容

三个机制，各自职责独立：

1. **只有影响投影的元数据才算变更。** `computePrPollMetaSignature`（位于纯模块
   `pr-poll-targets.ts`）精确列出 target 投影与 lane 规则从单个 session meta 读取的内容：
   `machineId`、`parentSessionId`、`isArchived`、`lastMessageAt`、discovery 分支、解析出
   的 GitHub 仓库，以及包含顺序的 `pullRequests`（当前 PR 是最后一项）。副本仍然接收每一
   份新 meta；只有签名发生变化才算 `changed`、才重投影、才安排唤醒。
2. **先过 gate，再解析凭据。** `evaluateScopeGate` 移入纯模块 `pr-poll-quota.ts`，按仓库
   冷却、冻结、空桶的顺序回答"这个 scope 现在能否为该仓库花费，不能的话何时能"。
   `runWake` 现在在批次循环之前丢弃被 gate 住的批次，而 `preflightScope` 是同一个决策在
   已知凭据之后的应用——一条规则，两个调用点。循环前 gate 需要在不解析凭据的情况下知道
   scope，这正是 `knownRepoScopes` 提供的。
3. **每个 gate 窗口一条跳过日志。** scope 级跳过（`frozen`、`bucket-empty`）按
   `(scope, reason)` 每个窗口只记一条，直到 gate 可能再次打开；仓库冷却保持静默，因为它
   在进入冷却时已经带退避时间记过日志。

外部触发的唤醒现在都走 `scheduleWake`：它计算是否真有可派发的 due 批次，否则安排在最早的
gate 开启时刻。由于 `scheduleWakeAt` 只会把唤醒提前，外部触发在 scope 开放时仍能立即提升
被查看的 session，但永远无法越过 gate。

## 按记住的 scope 做 gate 的取舍

scope 由凭据决定，因此"不解析凭据就跳过某个 scope"必然使用上一次观测到的 scope。若不加
界限，这是一个正确性隐患：ambient `gh` scope 上一小时的限流冻结，会在一份属于另一个健康
scope 的托管凭据可用之后仍然抑制轮询。`SCOPE_MAPPING_TTL_MS`（10 分钟）为其设界——过期的
映射会落到真正的 `resolveCredential`，后者重新打戳。剩余暴露是一份新凭据可能在长冻结后
最多等待十分钟，这是可接受的：另一种选择——每次唤醒逐仓库解析凭据——正是本次修复的缺陷。

曾考虑并否决的替代方案是把 `仓库 → scope` 持久化到 state store，使守护进程重启后无需一次
未被 gate 的唤醒来学习它。每次启动多一次唤醒，不值得让一个契约明确为"可丢弃调度记忆"的
存储继续膨胀。

## 验证

在 `apps/cli` 下执行 `npx vitest run src/lib/pr-poller`（183 个测试）。行为覆盖位于
`pr-poll-scheduler.test.ts`，采用扩充而非新建文件：共用一个已耗尽 scope 的三个仓库，在
50 秒的 presence 心跳与无关元数据写入下，只产生三次凭据解析、一条 `Bucket empty`、以及
有界的 skip 计数，随后在回填时刻完成轮询；冻结期间持续心跳的被查看 session 在解冻前无法
派发；旧 scope 一小时冻结中的第十分钟，属于健康 scope 的替换凭据成功轮询。

每个机制都做了消融以确认测试确实会失败：移除循环前 gate、日志节流、`scheduleWake` 的
gate、presence/metadata 改走 `scheduleWake` 的路由、以及映射 TTL，都会让一个或多个新测试
失败；收窄签名则会让 `computePrPollMetaSignature` 的契约测试失败。

一个诚实的限制：仅消融调度器中的签名判断（把每次元数据写入都当作变更）时，所有测试仍然
通过。唤醒被 gate 之后，多一次唤醒本身很廉价，无关写入的剩余代价是对全部 session 执行
`enumeratePrPollTargets`——在大 workspace 上是真实 CPU 开销，但无法通过 workspace handle
观测。因此该机制固定在其纯函数契约上，而不是用 mock 调用次数来断言。

## 发现的文档缺口

`specs/pr-status-reconciler.md` 被 `apps/cli/AGENTS.md`、`.agents/docs/cli-overview.md`、
`apps/cli/src/lib/pr-poller/AGENTS.md` 引为规范，各纯模块也按章节名引用它，但它从未存在于
本仓库——`git log --all` 找不到任何添加它的提交。因此本次改动涉及的唤醒语义无法以 `draft`
形式修订 Spec。这些语义改为记录在本笔记，以及
`apps/cli/src/lib/pr-poller/AGENTS.md` 的 invariant 中；若该文档存在于公开边界之外，仍欠
一次 Spec 修订。

## 证据

- `~/.lody/logs/2026-09-16.log.1`——2239 条 `Bucket empty`，单一凭据 scope，六个仓库；
  按 400 ms 归并得 1022 轮唤醒；在包含它们的 70 分钟内平均 14.64 轮/分钟。
- `apps/cli/src/lib/pr-poller/pr-poll-scheduler.ts`、`pr-poll-quota.ts`、
  `pr-poll-targets.ts`——实现。
- `apps/cli/src/lib/pr-poller/pr-poll-scheduler.test.ts`、`pr-poll-quota.test.ts`、
  `pr-poll-targets.test.ts`——测试与消融。
