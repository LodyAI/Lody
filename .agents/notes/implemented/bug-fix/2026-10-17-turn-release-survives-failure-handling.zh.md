# 失败处理本身出错时，turn 仍然释放占用槽

Status: implemented
Translation: current
PR: [#1652](https://github.com/LodyAI/Lody/pull/1652)

[English](2026-10-17-turn-release-survives-failure-handling.md)

## 摘要

一个 Session 永久不再响应：一轮经 Inbox 投递的 turn 失败后，失败处理本身又抛出了异常。第二个异常跳过了 Inbox 释放，turn 登记随之泄漏，而且没有记录任何释放失败。此后每条输入都以 `active-session` 被拒，live status 一直显示 `initializing`，也没有任何恢复路径接管这个占用槽。现在，visible turn 的 owner 在分类完失败后一定会执行释放。yielded turn 的 finalization 慢时改为等待，不再记为释放失败。确实无法确认的释放会显示为忙碌的 `waiting` 状态，下一条等待这个 Session 的输入会请求恢复。释放 turn 从不终止 agent 进程。引发这次事故的"空闲 GC 销毁正在使用的文档"竞态，留给 Session residency 工作处理。

## 事故经过

2026-10-17 08:47:10，空闲 GC 开始清理一个已空闲 20 分钟的 Session。agent 进程被杀两毫秒后，同一 Session 的一个 Inbox 完成通知 turn 开始执行，拿到了缓存中的 Session 文档。随后 GC 销毁了这份文档。turn 的下一次状态写入报 `Mirror not initialized`，失败处理末尾的 `setStatus(idle)` 再次失败。这个异常越过了 `runVisibleSessionTurnOwned` 的 `catch`，`inboxOwner.finish()` 和 `releaseTurnRuntime()` 都没有执行。由于 `releaseFailure` 从未被设置，只处理已记录释放失败的 `recoverInboxExecution` 也无法恢复这个 Session。

## 决定

- **分类之后无条件释放。** 失败分类移入 `settleVisibleTurnFailure`；Inbox 的 withdraw、finish 和登记释放移入 `releaseVisibleTurn`。分类抛出异常时，owner 记录原始错误和处理错误，先执行释放，然后才把处理错误重新抛给调用方。
- **慢不等于失败。** 释放 finalizer 原先最多等待 `yieldedFinalization`（yielded handoff turn 的串行收尾工作）5 秒，超时就记为释放失败。正常 turn 的主体本来就会无上限地等待这条链，所以这个上限只在主体提前退出时生效。这条链会捕获所有失败，一定会结束。现在 finalizer 等待它完成，超过 5 秒只打警告。把慢当成失败，会让 Session 一直阻塞，直到一次会终止 agent 进程的恢复；在非 Inbox 路径上则永远没有恢复。
- **真实的未确认释放继续阻断，但状态可见。** orchestration 规定释放状态未知时必须阻断后继。执行快照新增带原因的 `releaseBlocked`。dispatch 报告 `release-blocked`，不再报告 `active-session`。live status 报告带原因的 `waiting`，不再报告 `initializing`。不用 `unknown` 的原因是：fork 和 MCP 把 `unknown` 当作"不忙"，报告 `unknown` 会让 fork 越过尚未确认的资源继续执行。
- **由等待中的输入驱动恢复。** dispatch 检查遇到 `release-blocked`，或 Inbox 为阻断中的 Session 做就绪检查时，都会调用 `requestReleaseRecovery`。它对每个 Session 单飞，内部复用现有的 `recoverInboxExecution`。失败的尝试保留占用槽，由下一条等待的输入重试；成功则释放占用槽并重新检查 dispatch。服务没有新增定时器或后台任务。

## agent 进程会被保留

释放 turn 指的是：在途 ACP 请求已经结束、Inbox 执行记录已经写入之后，交还占用槽。它不终止 agent 进程，进程保持存活，供下一轮复用。只有空闲 GC（`LODY_SESSION_GC_IDLE_TIMEOUT_MS`，默认 20 分钟）、内存压力驱逐、归档或异常路径才会结束进程。异常路径包括：agent 在 Stop 后 5 秒仍不停止、连接丢失，以及阻断释放的恢复（它通过终止进程来证明释放已结束）。

## 考虑过的替代方案

- 用定时器重试阻断的释放：未采用。服务没有承载这类任务的生命周期 owner 或可注入的 clock，而且即使没有输入在等待，这种重试也会终止 agent 进程。
- 在 daemon 侧重试释放过程中的 SQLite busy 错误：未采用。orchestration 规则禁止在驱动的 `busy_timeout` 之上再加等待。
- 超过期限就把 `active-session` 当作过期：未采用。上一轮的释放可能仍在进行，这样会放行后继。

## 验证

`apps/cli/tests/session-execution-service.test.ts` 覆盖：

- 状态写入和失败处理都抛出异常的 Inbox turn 会释放占用槽、保留 agent 进程，下一条输入正常执行；
- prompt 失败、同时 yielded finalization 超过旧上限时，turn 保持占用但不出现 `releaseBlocked`，finalization 结束后正常释放；
- 阻断的释放对外可见；故障期间恢复请求返回失败；并发请求共享同一次恢复；故障解除后恢复成功。

临时消融验证了前两个测试：恢复旧的 `catch` 或旧的 5 秒超时，测试都会失败。dispatch logic 和 live status 的单元测试覆盖了新的原因和状态。

## 限制与后续

这个修复并不阻止 GC 销毁正在使用的文档。GC 仍然对一个没有引用计数的文档缓存执行"先检查后执行"，它的活动 turn 判断也看不到 prompt 之前的启动阶段。Session residency 工作会用带 lease、有引用计数的分代资源替换这两者；它堆叠在 native Repo 的接入之上，并遵循[turn 执行与 ACP 进程所有权](../../proposed/architecture/2026-09-27-effect-turn-execution-and-acp-process-ownership.zh.md)的目标设计。那份 Note 中完整的 `TurnRegistry`（以 Effect `acquireRelease` 完成登记）仍未实现：失败分类目前还是 Promise 代码，所以这里的释放靠 owner 的控制流保证，而不是靠 Scope finalizer。
