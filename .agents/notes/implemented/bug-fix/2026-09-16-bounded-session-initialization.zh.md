# 用进度期限约束 Session 初始化

Status: implemented
Translation: current

[English](2026-09-16-bounded-session-initialization.md)

## 摘要

初始化依赖一旦不返回，Session 回合就会永久停在 `initializing`：没有超时，没有失败路径，
只会每 10 秒继续写一次 presence 心跳，直到守护进程被重启。2026-09-16 有两个会话分别这样
卡了 1 小时 51 分和 1 小时 47 分，最后是被 Supervisor 关停才结束。现在初始化按阶段设有
期限，计时起点是最近一次已发布的进度；超时后记录用户可见的 `session_init_failed`、停止
心跳并释放该回合。这些预算取自单台机器的日志，尚未在慢速网络下的托管运行时下载或大仓库
克隆上验证过——这正是「会上报进度的阶段按静默而非按耗时计量」的原因。

## 证据

取自 `~/.lody/logs/2026-09-16.log.1`，会话 `1b227b98`：

```
04:58:53.133  trace-span start  dispatch.resolve_user
04:58:53.135  trace-span start  execution.visible_turn
04:58:53.136  presence heartbeat  status=initializing seq=1
04:58:53.138  ERROR  Failed to verify machine access (network): fetch failed
   ... 之后 221 次心跳全是 status=initializing，再无其他事件 ...
06:49:32.563  Supervisor requested graceful shutdown
06:49:32.568  presence session entry cleared
```

`dispatch.resolve_user` 始终没有输出 `end` span。重启后的下一次尝试耗时 70061ms 才成功，
而正常值是 1ms。会话 `8fc8fcee` 自 05:02:43 起以同样方式卡住，并被同一次关停清掉。
对任何带 project 或父会话的 Session，`resolveUserForRequest` 都会无条件 await 这次查询，
因此回合主体再也没有推进。

在全部保留日志中（923 次初始化，2026-09-09 至 16），健康分布为 p50 0s、p90 4s、p99 13s。
超过 60s 的样本只有四个：上述两次卡死、第三次 31 分钟的卡死，以及一次真实的 249s
`codex-acp` 冷启动。唯一触发过既有 120s 慢阶段上报的阶段是通用的 `initializing`，
且仅出现在那两次卡死中。

`CliPresenceRuntime.setSessionPresence` 只在状态为 `idle` 或缺失时清除 presence，
所以状态停在 `initializing` 就会无限续写。

## 决策

看门狗衡量的是**静默而非耗时**：计时从最近一次 phase 或 detail 变化开始。
`managed-runtime` 会通过 `formatManagedRuntimeProgressDetail` 发布递增的下载百分比，
因此健康的传输会持续重置计时、获得不受限的合法墙钟时间，而卡死的传输仍会被判定超时。
没有进度信号的阶段退化为按耗时计量——那是它们唯一能提供的信号。

各阶段预算不同，因为它们诚实的最坏情况相差数量级：`initializing` 180s（是
`USER_PROFILE_TIMEOUT_MS` 这一该阶段唯一有意慢依赖的 60s 期限的 3 倍，也明显高于
最差健康观测值 70s）；`acp`/`resuming`/`managed-runtime` 900s（是最差健康 ACP 启动
249s 的 3.6 倍）；`git-clone` 1800s（无进度信号且输入无上界）。统一超时被否决：任何
紧到能救通用阶段的值，都会杀死一次合法的克隆。

由 `SessionActivePresenceController` 负责检测，因为它已经为 120s 慢阶段上报持有按阶段
计时，并且是唯一被允许发布 Session presence 的模块。它不自行清除 presence——
`loro/AGENTS.md` 把这项职责保留给拥有该回合的 Effect 释放路径——但它会立即停掉自己的
心跳，使每 10 秒唤醒所有 presence 订阅者的开销在检测时刻就终止，而不必等到拆除往返完成。

由 `SessionExecutionService` 负责执行。`awaitInitializationStall` 通过
`Effect.raceFirst` 与回合主体竞速；除非看门狗触发否则它永不完成，因此进入 `running`
的回合不付出任何代价。发生卡死时走既有的 `recordKnownChatFailureAndHaltEffect` 路径，
原因为 `session_init_failed`，由它产生可见的会话失败、把用户回合标记为失败并让 Session
回到 `idle`。直接中断 fiber 的方案被否决：作用域终结器会读 `Cause.isInterrupted`，
那样会把卡死误报成用户取消。竞速仍会中断落败的主体 fiber，因此在 runtime 上锁存
`initializationStalled`，将其排除在终结器的取消分支之外。

那个挂起的 Promise 只是被放弃，而非被取消。与
[有界身份查询](2026-09-16-bounded-session-user-identity.zh.md)一样，CloudPort 没有提供
取消信号；等待结束了，底层请求可能仍在继续。不会自动重发消息。

### 垃圾回收

`SessionGCManager` 并不直接读 presence，但 `isEligibleForCleanup` 会调用
`hasActiveTurn`，而 `MessageHandler.hasActiveTurn` 返回
`state.turn.phase !== 'idle' || hasSessionActivePresence(sessionId)`。卡死的回合两个
条件都满足，所以这类会话永远不可回收。这一点无需单独修复：让回合失败会释放 runtime 与
presence 条目，回收资格随之恢复。

## 验证

`tests/session-execution-service.test.ts` 新增两个测试，把真实的
`SessionActivePresenceController` 接入该服务，注入时钟并只伪造 `setInterval`，
使 Effect 调度器照常运行——没有真实 sleep，也不断言 mock 调用次数。断言的都是可观察状态：
会话失败的原因与消息、用户回合状态、最终的 `idle` 状态、presence 的 clear 事件、
无论时钟推进多远都不再发布心跳，以及 `hasActiveTurn` 回到 false。第二个测试让一次
managed-runtime 下载在持续上报进度的情况下超出 60 秒预算达 450 秒，证明进度重置有效，
随后让它卡住。

消融验证：分别禁用看门狗、以及保留看门狗但移除竞速，都会让两个测试一直挂到 vitest 的
30 秒超时——正是线上的症状。完整的 130 个测试全部通过。

未验证：900s 与 1800s 预算从未被真实的下载或克隆触达，因此它们是上界而非实测值。
只有 `initializing` 的预算是对照实际卡死校准的。
