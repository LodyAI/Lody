# Session residency：带 lease 的 Session 文档与原子回收

Status: proposed
Translation: current

[English](2026-10-17-session-residency.md)

## 摘要

空闲 GC 曾经销毁了一个 Inbox turn 两毫秒前刚拿到的 Session 文档，turn 随之以一种让 Session 直到 daemon 重启都无法使用的方式失败。根因在所有权：CLI 的 Session 文档缓存没有引用计数，GC 又按"先检查后执行"做决定，并发的 turn 总能挤进这个窗口。本 Note 提议为每个 Session 设一个 residency owner：所有使用方都持有 lease，回收只在没有 lease 时、在每个 Session 自己的门内执行；回收期间到来的 acquire 会等待并拿到全新的一代。释放 lease 从不终止 agent 进程，进程照旧在空闲 20 分钟后才回收。内核、文档缓存、GC 和 turn 的 lease 都已接入；把其余一次性借用改为持有的 lease 是后续堆叠的 PR，这些都尚未在生产中验证。

## 问题

- `LoroDocumentManager.sessions` 是没有引用计数的共享缓存，`cleanSessionDoc` 会销毁所有持有者的 Mirror 和订阅。
- `SessionGCManager.sweep` 先检查是否可清理，再等待 `cleanSessionForGC`：清除 presence、关闭预览、终止进程、销毁文档。在检查和销毁之间开始的任何操作都会失去它的文档。
- 两套"活动 turn"的判断互相矛盾：GC 读 MessageHandler store 的 phase，它在 prompt 之前的启动阶段一直是 idle；dispatch 读 execution service 的登记。

事故中"释放"那一半由turn 释放修复（[#1652](https://github.com/LodyAI/Lody/pull/1652)）单独解决，本 Note 处理"所有权"那一半。

## 行为契约

| 问题     | 契约                                                                                                                                                                                                                       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 触发     | turn、dispatch watch 和读取方执行 acquire。GC sweep 和内存压力驱逐为空闲 Session 请求回收；归档和一次性清理为指定 Session 请求回收。                                                                                       |
| Owner    | residency 拥有每个 Session 的常驻值和门。只有持有门、且 lease 数为 0 的回收可以拆除它。                                                                                                                                    |
| 取消     | acquire 整体不可中断，因此在"拿到引用"和"注册 finalizer"之间不会泄漏 lease。等待是有界的，因为每个门的持有者（`open`、`close`、teardown）都由各自的 owner 限时。                                                           |
| 交接     | 回收只在 teardown 和 close 都成功后才移除这一代，等待中的 acquire 随后打开新的一代。同一 Session 的两代永远不会同时存在。                                                                                                  |
| 失败恢复 | teardown 失败会中止回收，Session 保持常驻，等下一次 sweep。close 失败时值保持 `retained`，下一次正常 acquire 会重新初始化它（与 #1607 保留 replica 的语义一致）。推迟到最后一次释放的回收失败时上报，并保持 Session 常驻。 |

## 进程保留

lease 不是 teardown。释放最后一个 lease 只启动空闲计时，别的什么都不做。文档和 Session 的 agent 进程保持常驻，供下一轮 turn 复用。只有以下情况会结束它们：

- GC sweep 回收空闲达 `LODY_SESSION_GC_IDLE_TIMEOUT_MS`（默认 20 分钟）的 Session，从最后一次 lease 释放开始计时；
- 内存压力驱逐空闲的 Session；
- 归档；
- 由其他模块负责的异常路径（agent 不响应 Stop、连接丢失、阻断的 turn 释放的恢复）。

## 决定

- **使用自定义的门，而不是 `RcMap`。** 在 Effect 4.0.2（`RcMap.ts`）中，空闲到期和 `invalidate` 都是先同步把条目移出 map，之后才关闭它的 scope。这个窗口里的 `get` 会和旧的关闭并行启动新的 lookup，重现 `replaced this replica` 背后的两个 replica 重叠。对使用中的 key 调 `invalidate`，同样会让第二代与第一代并存；而且没有供内存压力使用的"只驱逐空闲条目"操作。所以内核为每个 Session 使用一个 `Semaphore(1)` 加显式引用计数。
- **GC sweep 仍然是计时器。** 现有的 sweep 已经拥有配置（`LODY_SESSION_GC_*`）、生命周期和内存压力策略。residency 只增加原子的准入（带 `minIdleMs`、否决条件和 teardown 的 `retire`），不新增自己的后台 fiber。
- **teardown 在门内执行。** 进程终止、预览和模拟器的关闭与文档关闭在同一把门内进行，新到的 turn 不会在拆了一半的 Session 上开始。
- **观察用的 lease 不算使用。** `observe` lease 在持有期间照常保护值，但释放时空闲计时保持原样。没有这一点的话，GC 自己的 goal 检查会在回收前借用每个候选文档、重新开始它的空闲计时，空闲 sweep 和内存压力驱逐就都回收不了任何东西。这是在 review 接入 PR 时发现的。
- **归档使用推迟回收。** `deferWhileInUse` 在最后一次释放后再关闭被持有的 Session，而不是在持有者手下销毁它。

## 交付

1. 内核 `apps/cli/src/lib/loro/session-residency.ts` 及其行为测试（本 PR），堆叠在 native Repo 接入（#1607）之上。
2. 让 `LoroDocumentManager` 的 Session 文档、GC sweep、内存压力驱逐和 turn 执行都通过 lease。旧的一次性 `getOrCreateSessionDoc` 调用方 acquire 后立即释放，这会刷新空闲计时，保留今天 20 分钟的安全余量。
3. 把其余一次性调用方改为 scoped borrow，删除无引用计数的缓存、`pendingSessionDocs` 和 `isDestroyed` 检查。

## 接入

第二步把 residency 接入 daemon：

- **文档缓存。** `LoroDocumentManager` 只在 residency 中保存 Session 文档。`sessions` 变为只读视图，`pendingSessionDocs` 被删除。
  - `acquireSessionDocLegacy` 返回一个 lease。
  - `getOrCreateSessionDoc` 取得 lease 后立即释放。
  - `cleanSessionDoc` 立即回收，或推迟到最后一次释放。
  - `cleanUp` 最后调用 `shutdown`。打开和关闭仍在与渲染进程 room bridge 共用的按文档 ownership 链内执行。
- **turn。** 每个 visible turn 通过可选依赖 `leaseSessionDoc` 持有 lease，从登记之前一直到释放之后。这覆盖了 prompt 之前的启动阶段，原先基于 store phase 的检查看不到这一段。
- **GC。** `cleanSessionForGC` 经由 `retireSessionLegacy` 回收。
  - `minIdleMs` 由 GC 策略给出：sweep 用空闲超时，内存压力用 60 秒，避免 Legacy 一次性借用在调用方手下被驱逐。
  - 内存中的可清理性检查在门内作为否决条件再执行一次。
  - GC 的 goal 检查和只读的历史快照使用 `observe` lease，读取候选会话不会重新开始它的空闲计时。
  - presence、模拟器、预览和进程的 teardown 都在门内执行。teardown 失败时保留 Session 及其跟踪，交给下一次 sweep。
  - `cleanSession` 返回是否真的回收，被保留的 Session 不会被算作已驱逐。
- **teardown 不得重入。** 预览清理原先会重新获取文档来标记连接已关闭；现在它通过回收交给它的文档写入，没有打开的文档时只写元数据。GC teardown 引发的进程 `exit` 和 `terminated` 事件会被忽略，因为对它们做 finalize 会重新打开刚回收的文档。
- **尚未持有 lease。** dispatch watch 不持有 lease。GC 本来就会否决有待处理用户输入的 Session，而那正是 watch 被持有的唯一时机。

## 验证

`session-residency.test.ts` 使用 `TestClock` 和显式 deferred，覆盖：

- 共享的 open；
- 被持有时拒绝回收；
- 最小空闲时间；
- 回收中途到来的 acquire 拿到全新的一代；
- teardown 和 close 失败，以及下一次 acquire 的恢复；
- 否决条件；
- 推迟回收；
- open 失败。

一次临时消融让快速路径忽略门，回收中途到来的那个测试随之失败。

集成测试在内存 Repo 之上使用真实的 `LoroDocumentManager`，覆盖：

- 被持有的文档拒绝回收，释放后保持常驻，只在超过最小空闲时间后才回收；
- 事故的时序：GC teardown 被阻塞期间到来的 turn 会等待，并拿到全新、可写的文档，而 teardown 通过即将关闭的文档完成写入；
- 推迟到最后一次释放的清理。

一个回归测试在真实 manager 之上，运行真实的 `SessionGCManager` sweep、真实的 MessageHandler goal 检查和 `cleanSessionForGC`：空闲 21 分钟的 Session 会被回收。把 goal 检查改回普通借用后，测试失败，复现 review 中的 P1：回收返回 `recently-used`。

native Repo 接入中已有的 retained replica 测试依然通过。执行测试表明 turn 在整个 prompt 期间持有 lease，结束后保留 agent 进程。

限制：一次性调用方仍依赖被刷新的空闲计时，而不是持有的 lease（第 3 步）。dispatch watch 尚未持有 lease。MessageHandler 的否决条件和事件抑制没有专门的测试，因为 MessageHandler 没有轻量的测试夹具。
