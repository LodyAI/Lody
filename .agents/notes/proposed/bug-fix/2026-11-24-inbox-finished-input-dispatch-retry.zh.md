# 中断后 Dispatcher 重复重试已结束的 Inbox 输入（#2994）

Status: proposed
Translation: current
Issue: [#2994](https://github.com/LodyAI/Lody/issues/2994)

[English](2026-11-24-inbox-finished-input-dispatch-retry.md)

## 摘要

进程中断后，`InboxSqlite.activate()` 把在途输入退役为 `finished=1`（`sqlite.ts:393`），但 Session 元数据里的 `processingUserMsgId` claim 仍然存活。调度选择器 `findNextDispatchableUserTurn` 每轮都通过 Path 3（`session-dispatch-logic.ts:366`）重新选中该 turn——这条路径没有 `finished`/`inputEnded` 检查。每次选中都在 `execution-owner.ts:31` 以 `InboxExecutionRejected` 告终；本应一次性结算的代码（`session-execution-service.ts:5150-5183`）只能经由 `upsertSessionMeta` 清除 claim，而这个函数在 `repo.upsertDocMeta` 缺失时静默返回（`session-execution-service.ts:6249-6254`），其写入也可能在退出前的 Loro flush 中丢失。claim 清除一旦没有落盘，同一个已结束输入就在每个调度周期被无限重试。

## 复现

`locate-2994.repro.test.ts`（提交在
`.agents/notes/proposed/bug-fix/assets/locate-2994/locate-2994.repro.test.ts`；
复制到 `apps/cli/tests/` 即可运行——它断言的是*当前*缺陷行为，不能随套件提交）
直接调用真实的 `InboxSqlite` 与 `findNextDispatchableUserTurn`：接受并
begin 一个输入后，以新 owner 重开存储（`activate` → `finished=1`），
证明 (a) 输入已终结但 `processingUserMsgId` 仍在时 Path 3 仍返回它，
(b) 在 claim 未清除的连续 5 个调度周期中，同一已结束输入被选中 5 次、
5 次 `begin` 全部拒绝——即报告中的重试循环。
运行：`cp .agents/notes/proposed/bug-fix/assets/locate-2994/locate-2994.repro.test.ts apps/cli/tests/ && cd apps/cli && vitest run tests/locate-2994.repro.test.ts`，3/3 通过。

## 根因

循环位于三个各自信任不同事实来源的状态机交界处：

1. **中断 → finished。** `InboxSqlite.activate`
   （`apps/cli/src/orchestration/inbox/sqlite.ts:351-421`）清扫过期的
   `active_execution`/`active_input` 并把被中断输入写成 `finished=1`
   （393 行）。此后 `begin` 永久拒绝它（`inputEnded`，554 行）。

2. **选择不检查 finished。** `findNextDispatchableUserTurn`
   （`apps/cli/src/session/session-dispatch-logic.ts:306-377`）只依据
   history status 和 meta 指针挑选 turn：Path 3（366-368 行）返回所有
   `id === meta.processingUserMsgId` 的 turn；Path 4（370-373 行）返回
   `latestUserMsgId !== lastHandledUserMsgId` 的 turn。两者都不查询
   `inbox_inputs.finished` 或 `inputEnded`。watcher 中唯一的持久态守卫
   是 `isInboxInputCanceled`（`session-dispatch-watcher.ts:3378, 3492`）——
   没有对应的 finished-input 检查。

3. **结束循环的结算依赖 meta 写入。** `continueSession` → `openExecution`
   → `makeExecutionOwner` → `inbox.begin(input, id)` 返回 `false` →
   `InboxExecutionRejected`（`execution-owner.ts:31`）。5126-5184 行的
   catch 分支检查到 `inputEnded` 后调用 `continueInterruptedTurn`
   （同机器 + claim → `markDispatchCancelled`，6762-6779 行）或
   `retireEndedInboxInputTurn`（claim 已消失 → `markTurnFailed`，
   6842-6853 行）。**两条路径最终都汇聚到**
   `upsertSessionMeta(sessionId, { processingUserMsgId: undefined, … })`
   （6245-6256 行）。该函数在 `workspaceDocument.repo.upsertDocMeta` 为
   undefined——一个可选依赖——时静默返回，其写入又依赖 Loro 文档 flush，
   随后的中断可以丢弃它。没有任何代码验证这次写入是否落盘。

当一次结算没能清除 claim（`upsertDocMeta` 缺失、flush 丢失、或对端只读
拥有该文档），下一轮调度又回到第 2 步——而本该给 turn 盖终止章的
`maybeRepairAlreadyHandledTurn` **对仍持有 `processingUserMsgId` 的 turn
显式拒绝修复**（`session-dispatch-watcher.ts:3481-3483`），循环闭环而不
是断开。

第二个更窄的变体：`retireEndedInboxInputTurn` → `markTurnFailed` 经
`setUserTurnStatus` 写 `status='failed'`；若此时 history 条目尚未同步
（RPC 快路径执行后条目迟到），该状态只落在内存 Map
`terminalTurnStatusWithoutEntry`（`session-execution-service.ts:6285-6304`）
中，重启即丢失。而 `session-dispatch-watcher.ts:3506` 的修复兜底要求
`meta.lastHandledUserMsgId === turn.id`——又是一次 meta 写入——所以 meta
写入丢失时状态和 claim 都没有结算。

## 最小修复方向

缺陷是**选择/准入不对称**：`finished` 在准入侧（`begin`、`prepare`）
被检查，在选择侧没有。最小正确修复是让选择知道准入所知的同一组持久
终态——即把 `inputEnded`（finished **或** canceled）的 Inbox 输入对应
turn 视为不可调度——而不是再加一层事后修补：

- 在 watcher 的候选扫描（`session-dispatch-watcher.ts:3355-3391`）中，
  把现有 `isInboxInputCanceled` 修复扩展到
  `executionService.inputEnded` 等价检查（finished 但未 canceled）：给
  user turn 写终止态（沿用现有 ended-input 通知文本的 `'failed'`，而非
  `'canceled'`），并在 `processingUserMsgId` 指向该 turn 时清除——
  同样的分支在 `settleTerminalActivation`
  （`session-dispatch-watcher.ts:2873-2887`）已存在。

- 另一/附加做法：在 `maybeRepairAlreadyHandledTurn`
  （`session-dispatch-watcher.ts:3474`）加 `inputEnded` 检查——但注意
  3481 行的 `processingUserMsgId === turn.id` 提前返回恰好跳过了需要
  修复的 turn；该检查必须放在提前返回**之前**，或者在那里直接清 claim。

- **不要**通过加强 `upsertSessionMeta` 重试来修：写入本身就是机制，
  重试覆盖不了方法缺失的静默返回。让 `upsertSessionMeta` 报告失败
  （抛错或记日志）仍然值得做——正是 claim 清除路径上的静默 no-op 把一次
  性恢复变成无限重试——但那属于诊断修复，不是语义修复。

## 证据与边界

- 复现：`vitest run tests/locate-2994.repro.test.ts`（`apps/cli` 内 3/3 通过，真实
  `InboxSqlite` + 真实 `findNextDispatchableUserTurn`，被测路径无 mock）。
- 无限变体由构造性论证成立：选择侧没有 finished 守卫，所以任何让
  `processingUserMsgId` 保持的机制都会重复该周期。
  `session-execution-service.ts:6249-6254` 的 `upsertDocMeta ===
  undefined` 静默返回是一个具体机制；退出前 Loro flush 丢失是第二个。
- 未在此证明：#2994 报告背后的具体现场条件（`upsertDocMeta` 缺失 /
  flush 丢失 / 对端只读）。三者落在同一分支，上述修复对三者都有效。
- 范围：human 输入（`kind='human'`、`'task'`、`'automation'`）。
  `kind='automatic'` 输入完全不走 `inbox_inputs`，不在本 issue 范围内。
