# Roost/Lody 历史 backend 接入时序审查

Status: proposed
Translation: current

[English](2026-10-02-roost-lody-transition-timing-review.md)

## 摘要

Roost 接入会把 Lody 现有的会话生命周期接到异步历史 backend 后面。这份文档是两者边界的
持续审查记录：只有能构造出明确交错、能得到错误持久化结果或用户可见错误的时序问题，才会
进入结论列表。本轮确认了六个 P1 风险，分别涉及 worktree fork 的 backend 选择、权限截止时间、
Turn 收尾身份、metadata ledger、steer 提交和冷启动 backend 身份。F5 已在当前工作树加入提交前栅栏，
并通过确定性回归测试；其余开放问题仍需各自的栅栏和验证才能关闭。

## 用途与审查标准

以后每轮 Roost/Lody 审查都从这份文档开始，不从聊天记录重新恢复。候选问题只有同时满足以下条件，
才进入“已确认问题”：

1. 写清楚所有参与操作以及它们的 `await`、timer 或 callback 边界。
2. 给出通过延迟某个边界即可成立的合法交错顺序。
3. 写出这个交错导致的错误持久化状态或用户可见结果。
4. 说明当前改动是引入、扩大、保持不变还是修复了该竞态。
5. 指出能阻止该结果的最小所有权或身份栅栏。

性能、代码味道、泛化性的 adapter 担忧，以及无法连到错误结果的风险，不进入已确认列表。CI 变绿
不会关闭问题；只有代码和确定性测试（或等价执行轨迹）共同证明栅栏成立后，问题才可关闭。

## 审查范围与基线

本轮审查的分支是 `lody-roost-local-merge`，提交为
`47ff40c76edaa2bb9e654b19cfde3be2b78e0c53`（`test: stabilize CLI backend boundary fixtures`），
基线为 `origin/main`。实现代码没有未提交改动，分支与 `origin/lody-roost-local-merge` 一致；本次审查
新增的两份 review 文档仍是未跟踪文件。

目标 rollout 是新建会话选择 Roost 管理历史，旧会话继续由 Loro 管理。因此 session metadata 中的
backend discriminator 属于会话身份。Loro control document 可以继续承载控制面状态，但打开的会话
文档在其生命周期内，历史读写必须始终跟随选定的 backend。

本审查覆盖 transition 以及相邻的 queue、steer、permission、fork 和 Turn finalizer 路径。这里不
以本分支没有包含 Roost adapter 实现为理由断言 adapter 不完整；adapter 注册后的实现仍须按同一
backend port 单独核查。

## 已确认问题

### F1 — Worktree fork 在发布 backend 身份之前就返回 accepted

**状态：** 未修复；由 transition 改动引入；注册 Roost factory 后用户可感知。

**代码路径：**

- `apps/cli/src/session/session-fork-service.ts` 中构造 `targetMeta`、`marker` 和调用
  `setImmediate` 的 worktree 路径；
- `packages/components/src/providers/create-workspace-runtime.ts` 的 `createSessionStore`；
- `packages/components/src/components/sessions/session-detail.tsx` 的
  `PendingWorktreeForkObserver`。

**交错顺序：**

1. daemon 决定 `targetMeta.historyBackend = 'roost'`，并按这个选项打开 target document。
2. worktree 路径记录 recovery marker 和 fork operation，然后用 `setImmediate` 调度
   `executeWorktreeFork`，在 target catalog metadata 写入之前就返回 accepted fork response。
3. renderer 收到 response，挂载 `PendingWorktreeForkObserver`。其中的
   `useSessionDoc(targetSessionId)` 在 target metadata 可见之前打开 cold store。
4. `resolveSessionHistoryBackendKind(undefined)` 选择 legacy Loro。store 的 backend 生命周期已
   固定；后续 metadata 更新不会替换已经创建的 history view。
5. daemon 随后使用 Roost backend 导入 snapshot，并发布带 `historyBackend: 'roost'` 的完成 metadata。
6. observer 仍然绑定 Loro history，看不到 Roost 中的 `session_fork_origin` notice，于是可能一直
   等待完成，或展示空的/错误的历史。

**为什么属于本次 transition：** 异步 worktree fork 是本次 backend-aware fork 改动新增的路径，
其中 target metadata 直到 commit 阶段才写入；普通 fork 路径会在打开 target document 前写 metadata。
问题不是旧文档默认使用 Loro，而是 daemon 已经选择 Roost 时 renderer 先把自己固定到了 Loro。

**必须的栅栏：** accepted response 携带 backend kind，由 renderer 按该身份创建 store；或者在
observer 能打开 store 前发布 target metadata；或者 backend discriminator 未确定前禁止创建 history
store。只补一个稍后的 metadata patch 不够，因为 store 创建后 backend 是不可变的。

### F2 — Permission timeout 没有截止时间的解析所有权栅栏

**状态：** 未修复；异步 backend 调用扩大了窗口；用户可感知。

**代码路径：**

- `apps/cli/src/lib/message-handler.ts` 中 permission waiter 的
  `checkAutomaticOutcome`、`resolveWithOutcome` 和 timeout callback；
- `apps/cli/src/lib/acp/history.ts` 的 `updatePermissionOutcomeInHistory`；
- `packages/shared/src/history-writer.ts` 的条件式 `respondPermission`。

**交错顺序：**

1. permission request 正在等待。初次检查没有自动批准，随后启用自动批准，
   `checkAutomaticOutcome(true)` 开始异步 history read。
2. read 尚未返回时 timeout 到期。它设置 `timedOutResolution = true`，并开始条件式写入
   `cancelled`，但没有先取得解析所有权。
3. 自动批准 read 返回没有已有 outcome，并取得 `selected`。
4. 自动批准路径在 timeout write commit 之前进入
   `resolveWithOutcome(selected, ..., true)`；其条件式写入先成功，于是 ACP permission promise
   返回 `selected`。
5. timeout write 随后发现 outcome 已设置，不能覆盖；它后续的
   `resolveWithOutcome(cancelled)` 因 promise 已解析而被忽略。

结果是工具可能在配置的 permission deadline 之后执行。现有 writer 正确阻止两个已提交 outcome
互相覆盖，但没有决定 deadline 到达后谁拥有解析权。接入 backend 之前，自动检查在内存 waiter
解析前不会让出执行权，旧的同步 read 路径没有打开这个具体窗口。

**必须的栅栏：** timeout 必须先原子取得 resolution ownership；或者 backend 提供单一条件式 winner，
两条路径都服从它。自动批准路径在返回 ACP response 前，必须重新检查 deadline 并采用最终已提交的 winner。

### F3 — 没有 `turnId` 的 finalizer 可能结束 replacement session 的新 Turn

**状态：** 未修复；身份缺口在本分支之前已存在，异步 backend 路径扩大了暂停窗口；用户可感知。

**代码路径：**

- `apps/cli/src/lib/message-handler.ts` 中 `error`、`exit`、`terminated`、archive、child cleanup
  和 `flushAllACPUpdates` 对 `finalizeACPState(sessionId)` 的调用；
- 同文件的 `finalizeACPState` 以及无 `turnId` 时无条件执行的 `clearACPState`；
- `packages/shared/src/session-data/assistant-finalize.ts` 与 backend 的 `finish-assistant` action；
- `apps/cli/src/session/session-manager.ts` 中在发出 `exit`/`terminated` 前先从 map 删除旧 session
  instance 的事件处理。

**交错顺序：**

1. 旧 session instance 退出。`SessionManager` 从 map 删除它并发出 `exit`；message handler 开始无
   `turnId` finalizer。
2. finalizer 在 Turn history gate、ACP flush 或异步 backend history write 处暂停。
3. execution service 收到同一 session ID 的新 chat。因为 manager 已经没有旧 instance，
   `continueSession` 进入 `restoreMissingSession` 创建 replacement session，并打开新的 assistant entry。
4. 旧 finalizer 恢复，发送没有精确 `turnId` 的 `finish-assistant`。该 action 从最后一条 assistant
   entry 开始匹配，此时最后一条已经是 replacement entry，于是把新 entry 标为 finished。
5. 无 `turnId` 的 finally 随后执行 `clearACPState(sessionId)`，把 replacement 的 transient Turn state
   也清掉。

结果是旧 instance 的事件可以把新 Turn 标成 terminal，并清掉它的 ACP target。新 Turn 的输出可能
   被提前结束、归错或丢失。`finished === true` 只避免重复盖写已结束 entry，不能保护刚打开的
   replacement entry。

**必须的栅栏：** lifecycle finalizer 必须携带精确 Turn 身份。没有身份的 teardown 只能执行不会触碰
当前 Turn 的清理；`finish-assistant` 和 ACP state 清理都必须校验同一个身份。

### F4 — Durable metadata ledger 使用会丢更新的 read/modify/write

**状态：** 未修复；由 durable ledger 新增逻辑引入；重启或恢复后用户可感知。

**代码路径：** `apps/cli/src/lib/loro/doc.ts` 的 `setQueuePromotionRecord`、
`replaceSteerTurnStatuses`、`setSteerOperationRecord`，以及
`session-dispatch-watcher.ts` 和 `session-execution-service.ts` 中的 queue/steer 调用方。

**交错顺序：**

1. replica A、B 读取相同的 session metadata，得到 ledger 值 `L`。
2. A 加入 queue receipt `q`，调用 `upsertDocMeta({queuePromotionLedger: Lq})`。
3. B 基于旧快照加入 steer operation/status，调用
   `upsertDocMeta({steerOperationLedger: Ls})` 或基于旧快照写回完整 status map。
4. `loro-repo` 只在 metadata 顶层 field 合并。每个嵌套 ledger 是一个 JSON value，后写入的值会
   替换整个 ledger，不会按 operation key 深度合并。

因此 queue receipt 或 steer recovery record 可能消失。重启后缺少“history、activation 或 provider
delivery 已跨过边界”的证据，队列可能被重放或卡住，steer recovery 也可能丢失终态。queue rewrite
lease 与 steer status queue 不是同一把锁，不能阻止两个 family 之间的交错。

**必须的栅栏：** 每个 operation 使用独立 metadata key；或使用带版本的 CAS/merge-aware update；
或把 durable ledger 交给选定的 history backend，提供按 operation 的原子更新。只保留一个嵌套 JSON
value 时，单纯的顶层 patch API 不够。

### F5 — Stop 在 steer 的 durable `submitted` 状态写入期间仍可能让 provider 收到 steer

**状态：** 已在当前工作树修复，待 commit/CI；transition 引入的异步 backend 写入扩大了窗口；用户可感知。

**代码路径：**

- `apps/cli/src/session/session-execution-service.ts` 中 steer 的
  `rejectBeforeProviderSubmission`、`updateSteerTurnStatus` 和 `agentClient.steerPrompt`；
- 同文件的 `cancelSession` 和 `runtime.steerWaitController`。

**交错顺序：**

1. steer 通过最后一次 `rejectBeforeProviderSubmission` 检查：runtime 仍是当前 Turn、没有收到
   Stop、prompt 仍在接收输入。
2. provider 调用前，代码等待
   `updateSteerTurnStatus(... phase: 'submitted', delivery: 'unknown')`。这一步要排队并等待 backend
   的 durable read/write；它不经过 `wait(...)`，因此不会被 `steerWaitController.abort()` 中断。
3. backend 写入暂停时用户点击 Stop。`cancelSession` 设置 `runtime.cancelRequested = true`，记录
   `pendingInputOnCancel`，并 abort steer wait controller。
4. durable 状态写入恢复后，代码没有再次检查取消或 runtime 身份，直接设置
   `providerSubmissionStarted` 并调用 `agentClient.steerPrompt`。
5. provider 可能发送或应用 steer；Stop 请求已经返回成功，但 steer 仍改变当前 Turn，尤其是
   `pendingInputOnCancel = 'preserve'` 时会违反用户对 Stop 的直观预期。

**为什么属于本次 transition：** 旧路径的状态更新没有把异步 history/backend 写入放在 provider
提交前的这个窗口中；Roost 适配后该 await 是实际的远程或 durable 边界。已有的提交后状态处理不能
撤销一个已经送到 provider 的 steer。

**必须的栅栏：** durable `submitted` 写入返回后、调用 provider 前必须立即重新检查同一 runtime
身份、Turn 身份和 cancellation；更强的实现可以让“提交所有权”和 Stop 通过同一个 per-session
ownership fence 原子决定。仅依赖 abort 等待器不够，因为该状态写入本身没有使用被 abort 的 wait。
当前实现加入了这次提交后的立即检查；确定性测试暂停该状态写入、在期间执行 Stop，并验证 provider
没有收到 steer，最终 operation 被保存为 `settled/not_applied/pending`。

### F6 — CLI 冷启动在 backend 身份未确认时会永久绑定 Loro

**状态：** 未修复；由 backend 身份转接和不可变 binding 引入；Roost 会话冷启动时用户可感知。

**代码路径：**

- `apps/cli/src/lib/loro/doc.ts` 的 `getOrCreateSessionDoc`、`SessionDocument.init` 和
  `resolveHistoryBackend`；
- `apps/cli/src/session/session-backend.ts` 的 `createSessionBackend`；
- CLI 中未显式传入 `historyBackend` 的 session document 打开路径。

renderer 的 `createSessionStore` 已有 eager-sync/bootstrap 逻辑，因此这里不把 renderer 的已覆盖
路径重复算作问题；F6 针对的是 CLI 在 metadata 尚未权威同步时直接打开 document 的路径。
具体地，`session.chat` 的 `sendSessionChatResult` 在打开 document 前只调用 `syncDocForRead`，而
`resolveWorkspaceForSessionOrThrow` 的该调用没有保证 metadata sync；one-shot manager 的 initial
metadata sync 超时也会按 degraded mode 继续。

**交错顺序：**

1. CLI 冷启动打开一个没有本地 metadata 缓存的 session，调用
   `getOrCreateSessionDoc(sessionId)`，没有传入 backend 身份。
2. `repo.getDocMeta` 返回空记录或旧记录。`resolveHistoryBackend` 把“尚未同步”解释成 legacy
   Loro；`SessionDocument.init` 组成 Loro history，并把 `createSessionBackend` 绑定为 Loro。
3. 远程 catalog metadata 随后到达，声明该新 session 的 `historyBackend: 'roost'`。
4. 之后的调用如果把 metadata 传给 `createSessionBackend`，会得到
   `loro -> roost` identity changed 错误；如果走没有再次传 metadata 的旧入口，则继续从 Loro
   history 读取或写入。

结果是 Roost session 可能打不开、显示空/旧历史、把新写入落到错误 backend，或在 dispatch/history
操作处失败。这个问题不是旧 session 默认 Loro；问题是 backend discriminator 尚未权威确认时已经
做了不可逆的 Loro 绑定。

**必须的栅栏：** 在 catalog metadata、创建响应或等价 bootstrap 没有确认 discriminator 之前，
禁止创建 history store/backend。CLI 冷启动应等待 metadata 同步；超时只能报告可重试的打开失败。
绑定后 metadata 不得静默改写 backend；所有入口都必须把同一个已确认的身份传入并校验。

## 明确排除的候选

以下路径已经检查，但目前没有完整的、用户可见的错误结果交错，因此在出现新证据前不能当作问题报告：

- `prepared-session-input.ts` 中 activation pointer 的读写窗口；
- 已有 lease 与 history subscription 保护下的 queue-promotion activation pointer 顺序；
- `readHistoryCount()` 与 `readHistoryDirectory()` 不一致；
- `TurnHistoryGate` 的 bounded timeout。除非新轨迹证明本次改动使其产生新的确定性错误，否则它是既有的
  显式 fallback；
- `reconcileSteerHistory` 中 active-turn snapshot 的潜在窗口。当前没有构造出只延迟一个边界就能得到
  确定用户可见错误的轨迹，因此暂不列为 confirmed finding；
- 泛化的性能或长会话问题；
- 仅因为本分支包含 adapter port/registration boundary，就断言 Roost 实现不完整。

## 后续每轮审查流程

每个新 commit 或 adapter revision 都按下面步骤增量更新：

1. 记录新的 `HEAD`、比较基线、变更文件和工作区状态。
2. 从请求接受一路追到 history 或 metadata 的 durable commit，标出每个 `await`、timer、observer
   callback、queue 和 process lifecycle 事件。
3. 检查 identity 是否贯穿：session ID、backend kind、operation ID、user-turn ID、assistant-turn ID
   和 provider request ID。cleanup 或 retry 边界缺失 identity 时，列为候选。
4. 构造最短的交错。一次只延迟一个异步边界，并说明哪个写入先可见。
5. 与 `origin/main`（或声明的基线）对比，归类为引入、扩大、既有未变或已修复。
6. 只记录已确认问题。精确栅栏和确定性回归验证都存在后，才能移入“已关闭”。
7. 运行文档检查，并把本地工具不可用或未运行的测试与代码结论分开报告。

## 当前验证限制

本分支 CI 已报告通过。`git diff --check origin/main...HEAD` 通过，分支与远程一致；本轮使用本地
Vitest 运行 `apps/cli/tests/session-execution-service.test.ts`，147 个测试全部通过，且新增 F5
交错测试通过。checkout 没有可用的 `pnpm` 或 `corepack`，因此没有运行完整 workspace 检查；F1–F4
和 F6 仍未关闭。

## 更新记录

- 2026-10-02：以 `47ff40c76edaa2bb9e654b19cfde3be2b78e0c53` 为基线创建文档，记录 F1–F4 和明确排除项。
  本轮审查没有改代码、commit 或 push。
- 2026-10-02：继续审查同一基线，确认 F5（Stop/steer 提交）和 F6（CLI 冷启动 backend 身份），并
  补充 `reconcileSteerHistory` 的排除说明。本轮没有改实现代码、commit 或 push；只有这两份 review
  文档作为新文件存在于工作区。
- 2026-10-02：修复 F5，在 `submitted` durable 写入后增加 provider 调用前的 runtime/Turn/cancel
  栅栏，并加入暂停写入后执行 Stop 的确定性回归测试。CLI execution-service 测试 147/147 通过；
  尚未 commit 或 push。
- 2026-10-02：进一步收紧 F5 栅栏，加入捕获到的 `activePromptRun` 身份校验，并把最后一次通过性检查
  改成同步读取，确保栅栏通过后到 `steerPrompt` 之间没有额外的挂起点。相同的 147 个测试、格式检查和
  CLI 类型检查仍然通过。
