# 队列 Steer 的 Effect 归属边界

Status: proposed
Translation: current

[English](2026-09-14-queue-steer-effect-boundary.md)

## 摘要

当前队列 Steer 的交付选择分散在 renderer，operation 记录则集中在
`SessionExecutionService`。拟议边界由 `QueueSteerService` 负责精确选择、验证、
持久恢复证据、fallback 策略与结果；`ActiveTurnSteerPort` 负责 native 提交和 live turn
交接。Effect 表达本地资源生命周期与类型化失败语义，不会让 provider 提交变得可撤销。
队列 Steer 必须具备受支持的 `queueItemSteer` capability，不提供旧 daemon 兼容路径。
设计已修订，实现与行为验证仍待完成。

## 源码证据

[workspace catalog](../../../../pnpm-workspace.yaml) 固定 `effect: 3.18.4`，
[CLI 依赖](../../../../apps/cli/package.json) 通过 `catalog:` 使用它。
[SessionExecutionService](../../../../apps/cli/src/session/session-execution-service.ts)
已经用 `Effect.gen`、`Effect.acquireRelease` 表达 turn ownership 与 finalization，
本提案延续现有方式。

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

## 职责边界

| 归属                  | 责任                                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| UI                    | 为所选行传入 `{ sessionId, queueItemId, expectedTurnId }`，展示结果。                                          |
| `QueueSteerService`   | 精确队列项选择、验证、持久恢复证据、fallback 策略、结果与回执。                                                |
| `ActiveTurnSteerPort` | live turn ownership、provider native submission、prompt handoff，以及与 Stop 和其他 active turn 操作的串行化。 |
| 队列存储              | 现有 history 与 activation 发布责任。                                                                          |
| 集成边界              | 通过 `Layer` 提供 v3 `Context.Tag` 服务，执行组合后的 operation，将结果映射到响应协议。                        |

active turn 实现留在 execution owner。QueueSteerService 不得访问
`runtime.session.agentClient`、runtime map、`promptInFlight`、`successor` 或
`invocation`。port 从活动 invocation 派生冻结的 requester identity，并在自己的串行边界
内验证 expected turn；调用方验证不能替代这个检查。

native operation 暴露领域结果，概念契约如下：

```ts
interface ActiveTurnSteerPort {
  steer(input: {
    sessionId: SessionId;
    expectedTurnId: string;
    turn: SteerTurn;
  }): Effect.Effect<NativeSteerApplied, StaleTurn | ProviderRejected | ProviderDeliveryUnknown>;
}
```

`SteerTurn` 是经过验证的不可变 turn 数据，不是 runtime handle。
`NativeSteerApplied` 证明本地 handoff 成功，不代表 prompt 已完成。
`StaleTurn` 证明在提交前拒绝；提交后失去 ownership 不能报告为这种安全拒绝。

这是 native operation 的契约，不是全部 execution operation 的完整接口。native 支持
查询和 expected-turn cancellation 也由 execution owner 的操作封装。
QueueSteerService 选择策略，无需检查 provider client。禁止暴露
`onSubmitting`、`onAcknowledged`、`onApplied`、`onUndelivered` 回调来推进
queue journal。新服务不能只是把现有依赖 runtime 的代码换个文件。

## 资源与失败模型

`Effect<A, E, R>` 描述惰性计算，显式声明预期失败与依赖。用 `Effect.gen`
组合 operation，在策略所属层以类型化 handler 恢复。仅把现有 async workflow 包进
一个 `Effect.tryPromise` 不会改变生命周期归属。

rewrite lease 与本地 live-turn ownership/serialization guard 归属 `Scope`。
provider submission 是不可撤销的外部副作用，不属于可 release 的资源。顺序是获取本地
ownership、提交 provider 副作用，再在契约允许时释放本地 ownership。finalizer 防止
本地 ownership 泄漏，不证明 provider 没执行。现有 adapter acknowledgment handle
也仅是本地同步资源，留在 port 内部。

预期错误模型分为三类：

| 类别                   | 证据与示例                                                             | 恢复策略                                                                                                        |
| ---------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Safe rejection         | 确定 provider 没执行：`ProviderRejected`、提交前的 `StaleTurn`。       | 仅在 operation 前提仍成立时才有资格 fallback/retry。过期、缺失或编辑中的选择仍是失败且无副作用，不得停止 turn。 |
| Indeterminate delivery | `ProviderDeliveryUnknown`：提交可能已执行，包括确认或 handoff 不确定。 | 向上传递失败，不设 fallback handler，禁止 replay。                                                              |
| Local failure          | `PersistenceFailure`、验证或 lease 获取失败。                          | 根据 durable evidence 恢复；本地错误本身不证明未交付。                                                          |

使用独立的 v3 `Data.TaggedError` 类表达 `ProviderRejected`、
`ProviderDeliveryUnknown` 与 `PersistenceFailure`。native port 对交付证据分类，
operation 的持久化边界负责 `PersistenceFailure`。提交后的本地失败必须保留可能已交付
这一事实，不能改标成 `ProviderRejected`。

策略 handler 是 `Effect.catchTag("ProviderRejected", fallbackToDispatch)`。
`ProviderDeliveryUnknown` 没有对应的 fallback handler。defect 与 interruption
仍通过 `Cause`/`Exit` 区分；timeout 或 Promise 中断都不能证明 provider 没执行。
不得重试整个交付 operation。

## 持久化与 capability 策略

QueueSteerService 拥有持久恢复证据：在进入可能提交的 port 调用前持久化 write-ahead
证据，取得结果后持久化回执。若在这两个边界之间崩溃，除非权威证据证明其他结果，否则
保守地视为交付不确定。journal 契约的实现不得引入 phase callback 或暴露 live runtime
状态。保留[原决策](../../implemented/feature/2026-09-13-queue-steer-controls.md)中
已有 marker 的恢复与保守重放保证；不为每个 Effect 步骤增加 durable phase。

核心 Scope 清理无法跨越进程死亡。Stop 必须保留 ACP owner，直到原始调用完成或确认
终止；外部工作不配合时，Promise 包装无法取消它。引入 workflow engine 是独立架构
决策，不是这两条交付链的必需条件。

队列 Steer 不兼容旧 daemon。未声明受支持的 `queueItemSteer` 版本时，所有行的
Steer 都不可用，包括队首。不得退回 renderer 写历史、legacy native Steer 或队首
cancel。支持该协议的 daemon 上，每一行传自己的队列标识，由 daemon 选择 native
delivery 或 cancel-and-dispatch。

这仅替代原决策中队列 Steer 的旧 daemon 兼容策略，composer 提交行为不在本次变更内。
draft [交互 Spec](../../../../specs/message-queue-interactions.md) 记录修订后的意图；
renderer 当前仍包含旧路径。

## 待完成的验证

保留选择 C 后 A/B 顺序不变、队列项缺失或编辑中、expected turn 过期、native
接受/拒绝、Stop 与 acknowledgment 竞态、持久化失败及响应丢失/重启恢复的行为覆盖。
验证三类错误：只有满足前提的安全拒绝才进入 fallback dispatch；交付不确定绝不
replay；本地失败根据 durable evidence 恢复。确定性失败/中断测试须证明本地 guard
会释放，且不会放弃仍在运行的 ACP owner。不支持协议的 daemon 上，任何行都不得有
可用的队列 Steer 操作，也不得发出 legacy submission 或 cancellation。

业务代码与依赖版本均未修改。修订后的设计与 Spec 不代表实现证据；未运行 runtime 测试。
