# 合并积压的 dispatch check 并在其间让出事件循环

Status: implemented
Translation: current

[English](2026-09-13-dispatch-check-coalescing.md)

## 摘要

长会话的 turn 结束后，daemon 会以 100% CPU 空转 20 到 42 秒，期间事件循环完全被阻塞：定时器、Loro
心跳和其他会话全部停摆，直到积压清空。原因是 dispatch watcher 的每会话 check 链：turn 期间链本身在
等待这个 turn，而会话 mirror 的每次 commit 都往链上追加一个新 check；turn 结束后几百个相同的 check
在微任务上连续排空，每个都重新读取完整历史。现在 `enqueueSessionCheck` 会复用已排队但尚未开始的
check，因此无论 turn 多长，最多只留下一个后续 check；链上紧跟在另一个 check 之后的 check 会先让出
一次宏任务。让 dispatch 分支不再等待整个 turn 的方案经过评估后推迟：它在守卫层面是安全的，但会改变
返回 promise 对所有调用方的含义，而仅靠合并已经消除了观察到的停摆。

## 问题与证据

2026-09-13 的日志（`~/.lody/logs/<date>.log`）签名：

```
[event-loop] lody start timer lag detected: fired 41993ms late ... cpuRatio=1.07
```

紧接其前是几百行相邻的 `dispatch.maybe_handle_session -> dispatch.find_or_await_turn
(约 130 ms) -> outcome=no-dispatchable-turn`，中间没有任何其他日志；再往前是该会话的
`execution.visible_turn ... outcome=completed` 和 `Unwatching idle session (no pending work)`。
88 分钟的日志里共有 1898 次这样的无效 check，累计 192 CPU 秒；42 秒那次是 329 次。

`apps/cli/src/session/session-dispatch-watcher.ts` 里三个设计叠加：

1. `enqueueSessionCheck` 把每次调用都追加到该会话的 promise 链末尾，没有任何合并，即使链上已经排着
   一个尚未开始的 check。
2. 会话文档的 mirror 订阅在每次 commit 时都触发一次 check，而 agent 输出期间一个 turn 会 commit
   几百次。
3. `maybeHandleSession` 的 dispatch 分支等待 `dispatchPreparedSessionTurn` 返回，其时长等于整个
   turn（`execution.prepared_session_turn` span 证实了这一点）。于是链在 turn 期间被卡住，每次
   mirror commit 都变成积压的 check，turn 结束后逐个排空。

每个排空的 check 都调用 `sessionDoc.getHistory()`，从 mirror 状态物化完整历史。对一个 341 条记录、
13 MB 的会话文档约 130 ms；对新会话只要 3 ms，所以短会话上看不出来。check 内的所有 await 都在内存
对象上通过微任务完成，排空过程一次也到不了定时器阶段。lag monitor 直到最后一个 check 之后才醒来，
Loro 看门狗随即强制 reconnect。

## 决定

- **合并。** 排队中的 check 开始时会重新读取 meta 和历史，所以它已经覆盖了在此之前到达的任何触发。
  `enqueueSessionCheck` 查找该会话中尚未开始、且生命周期代数与调用方一致的 probe 记录，返回该记录
  的 promise 而不是追加：`resolveAfterInitialProbe` 调用方拿到它的 probe promise，其余调用方拿到
  整条链的 promise。bootstrap 使用的 `reuseExistingCheck` 分支保持原有语义并优先判断。合并以
  `started` 为准，而它只在下面的让出之后才置位，因此让出期间到达的触发也会折叠进来。
- **让出。** 链上紧跟在另一个 check 之后的 check 会先 await 一次 `setImmediate` 再运行。
  `setImmediate` 在定时器阶段之后执行，所以即使真的排空多个不同的 check，定时器和心跳也能运行。
  空闲链上的新 check 不让出，RPC 和 metadata 快路径保持原有延迟。
- **继续等待 turn（推迟）。** `runVisibleSessionTurn` 在入口处同步注册 turn runtime，所以
  `getExecutionSnapshot().hasActiveTurn` 已经能守卫 turn 期间运行的 check。但
  `enqueueSessionCheck` 返回的 promise 被队列提升（`processMessageQueue`）、edit-and-resend 的
  `enqueueDispatch`、RPC offer 和测试套件当作“turn 已经跑完”，而 turn 期间会运行的 check 每个仍要
  读 meta。合并已经把 turn 后的工作限制在一个 check，所以这个更大的改动记为 follow-up，本次不做。

## 考虑过的替代方案

- 对 mirror 订阅做节流或防抖：否决。session 的 AGENTS.md 禁止额外节流，而且延迟会让第一条后续消息
  变慢，延迟过后仍然是每次 commit 一个 check。
- 当 meta 显示没有待处理激活时跳过 `getHistory`：不作为主要修复。激活之后历史仍是 turn 选择的来源
  （legacy 的 `read === false` 条目、队列提升），仅看 meta 的短路会改变 dispatch 语义；合并在不
  触碰选择逻辑的前提下消除了重复读取。

## 验证

- `apps/cli/tests/session-dispatch-watcher.test.ts`：使用 fake timers 和注入的 doc/mirror 桩，
  一个 turn 期间收到 300 次 mirror commit 加一次 turn 后的 enqueue，只产生恰好一次后续历史读取；
  该读取停在宏任务上而不是在微任务上运行；turn 期间设置的定时器在后续排队的 check 仍停着时就已触发；
  被合并的调用方拿到的 promise 只在共享的 check 完成后才 resolve；之后链仍然存活。去掉任一机制都会
  让测试失败：没有合并时被合并的 promise 永远不 resolve，没有让出时后续读取在微任务上运行。
- `pnpm check` 和 `pnpm format` 的结果记录在 [PR #676](https://github.com/LodyAI/Lody/pull/676) 中。`worktree-gc` 套件在这台机器上有一个与
  `/private/var` 路径解析有关的预存失败，与本次改动无关。
- 未测量：修复后的生产日志签名。机制已在单元测试中确定性复现；在 13 MB 会话文档上的现场确认仍待观察。

## Follow-up

- 让 dispatch 分支不再等待整个 turn，使链在 runtime 注册后立即释放。需要重新定义
  `processMessageQueue`、`enqueueDispatch` 和 RPC offer 调用方对返回 promise 的契约，并确认
  turn 期间每次 commit 的 check 只读 meta。
- `getHistory()` 每次调用都物化并规范化整个历史。基于 mirror 状态的更便宜的“是否存在可 dispatch
  的用户 turn”读取可以消除大文档上剩余的每次 130 ms。
