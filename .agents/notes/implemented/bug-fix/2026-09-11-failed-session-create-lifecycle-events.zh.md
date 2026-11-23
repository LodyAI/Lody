# 在清理性 terminate 之前解绑失败的 Session 实例

Status: implemented
Translation: current

[English](2026-09-11-failed-session-create-lifecycle-events.md)

## 摘要

一个在空闲 GC 后被恢复的会话丢失了整整一个 turn 的 agent 输出：ACP resume 尝试失败，执行服务
回退到历史重放会话。`SessionManager` 在 `createAgent` 之前就注册了 `Session` 实例的生命周期事件，
因此失败实例的清理性 `terminate` 发布了 `terminated`，看上去就像活跃 turn 的 agent 死亡；
`MessageHandler` 随即终结了该 turn，来自替代 agent 的每一次更新都因为没有目标而被丢弃。管理器现在
会在那次 terminate 之前把实例从其监听器与活跃映射中解绑，使生命周期事件只为调用方真正拿到的实例
发布。代价是启动崩溃不再触发由 `exit` 驱动的空闲状态写入；被拒绝的 `createSession` promise 成为
唯一信号，恢复由调用方负责。

## 问题

2026-09-11 在同一台机器上的两个 dsh（`@deepseek-ai/dsh-acp-demo@0.1.1-rc.2`）会话中观察到。dsh 既
不广播 `loadSession` 也不广播 `resume`，因此空闲 GC 驱逐 agent 之后的任何续接都会走这条路径：

1. `createSessionInnerWithAgent` 调用 `createSessionInner`，后者构造 `Session`、调用
   `registerSessionEvents`，并把它存入 `sessions`。
2. `createAgent` 抛出 `[ACP_RESUME_UNSUPPORTED]`。catch 块调用 `session.terminate(true)`，从而发出
   `terminated`。
3. 管理器转发该事件。`MessageHandler` 的 `terminated` 监听器运行 `finalizeACPState`，把瞬时 turn
   状态清为 `idle`，并把 assistant 条目标记为已完成。
4. `SessionExecutionService` 捕获 resume 错误，并按设计用重放 prompt 创建一个全新会话。
   `activateTurnACPUpdateTarget` 在 idle turn 上是空操作，因此 `enqueueACPUpdate` 在六分钟里为
   34,551 个思考块与 48 个消息块记录了
   `Dropping ACP update without an active/finalized assistant entry target`。
5. 该 prompt 以 `completed` 结束；该 turn 通过 `recordSilentTurnFailure` 被记录。完整答案只存在于
   agent 自己的记录中。

该缺陷与 dsh 无关：任何 resume 失败的 agent 都会丢失兜底路径的输出。dsh 缺少 `loadSession` 是一个
能力缺口，只会在 GC 之后降低上下文质量；它没有造成丢失。

## 决策

在产生虚假事件的源头修复，而不是在下游修补：

- `registerSessionEvents` 保留其 handler，并在一个 `WeakMap` 中存放按实例的解绑函数。`createAgent`
  的 catch 块在 `terminate(true)` 之前调用 `detachSession(session)`：移除监听器，并且只有当该实例
  仍是该 id 所映射的实例时，才把它从 `sessions` 中删除。这个身份检查很重要，因为恢复路径可能已经
  在用同一个会话 id 创建替代实例。

考虑过的替代方案：

- 在执行服务的兜底路径中重新 `beginTurn`。否决：handler 的 `terminated` 监听器是 fire-and-forget，
  并且在 `waitUntilSynced` 之后的 `finally` 中清空 turn 状态，因此它可能在替代 prompt 已经开始之后
  才落地并抹掉一个活跃 turn；它还会把条目标记为 `finished` 并注册一个迟到的更新目标，之后还得撤销。
- 在 `MessageHandler` 的监听器中加守卫。否决：该事件只携带会话 id，因此 handler 无法在不跨三层新增
  管线的前提下区分「该 turn 绑定的实例」与「从未 prompt 过的实例」。

## 验证

`apps/cli/src/session/session-manager.test.ts` 使用自定义 ACP 启动方式驱动公开的 `createSession`，
并让 `Session.prototype.createAgent` 以 `[ACP_RESUME_UNSUPPORTED]` 拒绝：没有 `terminated`/`exit`
到达管理器的消费者，该会话不在映射中，而在同一 id 下创建的替代实例正是被映射的实例，其之后的
`terminateSession` 确实会发布 `terminated`。

未验证：针对真实缺少 resume 的 agent 的端到端恢复，以及 `SessionExecutionService` 兜底路径本身
（其行为未改变）。
