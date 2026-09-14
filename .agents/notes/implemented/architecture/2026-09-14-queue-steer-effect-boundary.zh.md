# 队列 Steer 的 Effect 归属边界

Status: implemented
Translation: current

[English](2026-09-14-queue-steer-effect-boundary.md)

## 摘要

队列 Steer 由 `QueueSteerService` 负责精确选择、验证、恢复证据、fallback 与回执，
`ActiveTurnSteerPort` 保留 live turn 和 provider ownership。Effect 3.18.4
表达本地资源生命周期与类型化失败，不把 provider 提交包装成可撤销资源。
Native reservation 后先持久化冻结 history 和队列删除，再提交 provider；旧客户端草稿
冲突会明确失败并保留。队列 Steer 仅支持 queueItemSteer v2，没有旧 daemon 兼容路径。
不确定交付禁止重放；真实多进程崩溃和已安装应用的人工验证仍未覆盖。

## 源码证据

[workspace catalog](../../../../pnpm-workspace.yaml) 固定 `effect: 3.18.4`，
[CLI 依赖](../../../../apps/cli/package.json) 通过 `catalog:` 使用它。
[SessionExecutionService](../../../../apps/cli/src/session/session-execution-service.ts)
已经用 `Effect.gen`、`Effect.acquireRelease` 表达 turn ownership 与 finalization，
本实现延续现有方式。

安装包有源码但没有 `AGENTS.md`。官方 v3 checkout 包含
[agent 规则](https://github.com/Effect-TS/effect/blob/1af4232fea7bc613e1dc68db9bec7b1f596d9e68/AGENTS.md)
与[文档入口](https://github.com/Effect-TS/effect/blob/1af4232fea7bc613e1dc68db9bec7b1f596d9e68/docs/index.md)。
不能把使用 `Context.Service` 或 `Effect.catch` 的上游 v4 示例复制到本项目的 v3。
CLI 规则引用的 `context/cli-effect-ts.md` 在当前 checkout 缺失。

已检查安装包 `src/internal/core.ts` 的 `acquireUseRelease`、
`src/internal/fiberRuntime.ts` 的 `acquireRelease`、
`src/internal/core-effect.ts` 的 `tryPromise`，以及 `ManagedRuntime` API。
对应的 [3.18.4 源码](https://github.com/Effect-TS/effect/tree/ede2ea11c2abe7038bac3c83fb7b5eef101858d2/packages/effect/src)
是 API 依据。另已阅读上游 v3 的
[资源测试](https://github.com/Effect-TS/effect/blob/1af4232fea7bc613e1dc68db9bec7b1f596d9e68/packages/effect/test/Effect/acquire-release.test.ts)
与[中断测试](https://github.com/Effect-TS/effect/blob/1af4232fea7bc613e1dc68db9bec7b1f596d9e68/packages/effect/test/Effect/interruption.test.ts)
作为补充证据；未运行它们，也未假定它们与固定版本完全相同。

## 边界与实现

| 归属                                                                              | 责任                                                                           |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| UI                                                                                | 每行仅传 session、queue item 和 expected turn；不选择 native/fallback。        |
| [QueueSteerService](../../../../apps/cli/src/session/queue-steer-service.ts)      | 精确选择、验证、持久 marker、恢复、fallback 和有界回执。                       |
| [ActiveTurnSteerPort](../../../../apps/cli/src/session/active-turn-steer-port.ts) | live ownership、native submission、prompt handoff、精确 Stop 与本地 guard。    |
| SessionExecutionService                                                           | 实现 port；组合 Context.Tag/Layer，并在 per-session queue 执行领域 operation。 |
| SessionDocument                                                                   | 同步比较 row revision 后修改；history 只走共享 HistoryWriter。                 |

Queue 服务不读取 runtime map、agentClient、promptInFlight、invocation 或 successor，
也不使用 onSubmitting/onAcknowledged/onApplied/onUndelivered 回调。Provider requester
来自活动 invocation，不相信队列作者。服务定义自己的窄依赖契约，不导入
SessionExecutionServiceDeps。既有普通 turn 与 composer 路由不变。

Source facade 为队列 Steer 和 mutation 共用 [session 授权](../../../../packages/components/src/providers/session-control-authorization.ts)，
使用完整的已认证 machine/project 快照。控制需要 machine 权限，local-project session 还需
对应项目权限。复用 UI visibility 是错误的：它刻意允许 session 创建者在 machine 权限撤销后
仍看到 session，但不能据此授予控制权。因此控制契约不包含 currentUserId 或 session owner，
也不调用 visibility predicate。RuntimeProvider 提供按 workspace 隔离的快照；metadata 或授权缺失时
fail closed。Routing plane 独立于 sender 可用性，local 失败不能落入 Streams。
目标 daemon 无法从此 RPC 认证调用方身份。

## 资源和失败

rewrite/ownership guard 和 adapter 本地 ACK gate 用 Effect.acquireRelease 归属 Scope。
提交到 ACK cleanup 注册之间屏蔽 fiber interruption，避免释放本地 handle 的责任丢失；
Stop 仍取消 ACP，而非其 owner fiber。Scope 既不能撤销外部提交，也不能跨进程死亡执行。

| 类别                                                        | 行为                                                                                      |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| SteerPreparationFailure、ProviderRejected、提交前 StaleTurn | 只有确定未交付且前提允许才恢复普通 dispatch；reservation 前缺失、编辑中或过期仍无副作用。 |
| ProviderDeliveryUnknown                                     | 向上返回错误，不进入 fallback、不重放。包括提交后失去 ownership 或 handoff 失败。         |
| PersistenceFailure                                          | Journal/history 持久化失败；保留 durable evidence，不能仅凭错误 tag 推导未交付。          |

`prepareSteer` 完成 prompt 构建、配置应用和 ownership 验证后，queue service 才写
`submitting`。只在 preparation 调用处处理其失败，不 blanket catch PersistenceFailure
来 fallback。`submitSteer` 消费不透明的单次 handle；execution service 用私有 WeakMap
保留惰性 submission effect，不暴露 runtime 对象或 callback。Journal 持久化后，port 再次
检查 ownership，provider call 前不再等待异步准备。该调用的普通同步/异步异常均为
ProviderDeliveryUnknown；明确的 AgentSteerNotDeliveredError 仍证明拒绝交付。无效或已用
handle 不能重放。写前证据与 provider call 之间的 crash 仍不确定；不新增 phase 或重试整个 operation。

## 权威写入与恢复

仅提前删除 row 无法防止 history 持久化等待期间另一个客户端保存编辑。因此
queueItemSteer 升为 v2：renderer 对支持者的 edit/remove/reorder 通过窄领域 RPC
`session/queue-mutate` 到 daemon，与 reservation 共用串行入口和 rewrite conflict guard。
更新/删除带 canonical row revision，重排带原始 ID 快照；冲突和缺失明确失败。
RPC 失败绝不退回直接写入。enqueue、普通发送和其他 UI 数据仍由 renderer 写入，
没有恢复通用 write-intent mirror。旧 daemon 不开放队列 Steer。

Native 顺序是 reservation marker → pending_apply history durable → queue removal durable
→ prepareSteer → submitting marker → submitSteer → durable receipt。任一提交前 barrier 失败禁止 provider 调用。
恢复使用 marker 和冻结 history；不要求原 row 存在。旧 marker 仍可读；若残留 row 无 revision，
只有可证明与冻结内容一致且不在编辑中才删除，否则保留并等待对账。不能通过恢复丢掉已接受编辑。

没有 history 的 `reserved` 清除 marker、保留 queue，不生成终态 receipt。相同 C/T 的重试
重新验证并建立 reservation，既支持启动恢复后重试，也支持当前请求继续；clear 失败则不能继续。
此处缓存错误会让确定未提交的操作在当前 active turn 剩余期间永久无法再次 Steer。
有 history 的 `reserved`/`fallback` 可恢复同一个普通 turn；`submitting`/`acknowledged` 不重放；
`applied` 恢复 accepted 回执。普通 cancel-and-dispatch 保留既有 history/activation
发布顺序与内存回执。完整契约由 [Spec](../../../../specs/message-queue-interactions.zh.md) 拥有；
它仍是 draft。本决策替代[原记录](../feature/2026-09-13-queue-steer-controls.zh.md)的
共享 row 保留到交付完成及旧 daemon 兼容策略。

编辑器在最后一行消失后仍保持挂载，显示冲突提示并保留未保存草稿，直到用户明确关闭。
旧软件直接写 CRDT 不等于 v2 authority 接受保存；不能声称兼容任意旧 renderer。

## 验证与限制

已有 suites 覆盖精确 C 保留 A/B、provider 拒绝与不确定失败、Stop/late ACK、连续 handoff、
receipt/restart，以及真实 LoroDoc 上的 reservation 与 edit/remove/reorder 冲突。
显式 promise gate 验证删除持久化先于 provider，以及 reservation/history/removal/submission-marker
持久化失败时零提交、marker 加 history 的恢复和本地 guard 释放。组件覆盖 row 消失后的草稿保留，
共享协议拒绝 v1。测试不使用睡眠或真实网络来决定竞态。
Prompt 构建或 mode/model 失败时，C 可普通 dispatch、marker 为 fallback，provider 零调用。
Provider 同步抛错或 ACK 拒绝保留 submission 证据，不 fallback、不重放。
Submission marker 持久化期间的 Stop 也会在 provider call 前被检查。

Execution suite 用内存传输连接真实 source facade、Streams client/server、LoroDoc 和
execution service。Machine 可见但私有项目不可见时，两种 control 均拒绝：零 append、无 marker，
queue/history/active turn 不变。同一 trace 覆盖 session 创建者被撤销 machine 或拒绝项目权限，
即使 UI visibility 仍为 true；残留项目权限不能绕过 machine 撤权。Local 缺 sender 同样拒绝且不创建远程 client。开放项目权限的
正向对照可到达 daemon 并应用 C。重启恢复和请求内 pre-history 恢复都允许相同 C/T 继续。
这些是确定性合成数据 trace，不是生产用户 trace。

直接 CLI、components 类型检查与目标测试已运行；根级 pnpm check / pnpm format
因缺少 corepack 无法启动，改用已安装 pnpm 运行目标检查和 Prettier。
没有真实 provider、完整桌面端到端、进程 kill/restart 或任意旧客户端混跑的验证。
