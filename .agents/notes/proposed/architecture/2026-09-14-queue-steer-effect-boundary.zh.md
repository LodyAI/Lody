# 队列 Steer 的 Effect 归属边界

Status: proposed
Translation: current

[English](2026-09-14-queue-steer-effect-boundary.md)

## 摘要

当前队列 Steer 的交付选择分散在 renderer，operation 记录则集中在
`SessionExecutionService`。拟议边界将精确队列项选择收口为一个 daemon operation，
由 `QueueSteerService` 负责交付、资源生命周期、回执和恢复。Effect 可以组合表达这些
生命周期与失败，但核心 runtime 无法让 ACP 交付具备事务性或持久性。本次源码研究明确了
实现约束；重构及其行为验证仍待完成。

## 源码证据

当前安装版本是 `effect@3.18.4`。npm 包包含源码，但没有 `AGENTS.md`。官方 v3
checkout 包含
[AGENTS.md](https://github.com/Effect-TS/effect/blob/1af4232fea7bc613e1dc68db9bec7b1f596d9e68/AGENTS.md)
与[文档入口](https://github.com/Effect-TS/effect/blob/1af4232fea7bc613e1dc68db9bec7b1f596d9e68/docs/index.md)。
上游当前 `main` 开发的是 v4，不能将使用 `Context.Service` 或 `Effect.catch` 的示例
直接复制到本项目的 v3。CLI 规则引用的 `context/cli-effect-ts.md` 在当前 checkout 缺失。

| 原则             | 已核实的语义                                                                                          | 对 Steer 的影响                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 程序是值         | `Effect<A, E, R>` 描述惰性计算、预期失败和所需服务。                                                  | 先组合 operation，再执行；Promise 执行集中在集成边界。                                    |
| 失败具有不同含义 | 预期失败进入类型；defect 与 interruption 可通过 `Cause`、`Exit` 区分。                                | 显式表达缺失、编辑中、过期、拒绝与交付不确定，不能把所有失败转成 fallback。               |
| 资源有归属       | `acquireRelease` 保护资源获取及 finalizer 注册不被中断；`acquireUseRelease` 在 use 阶段恢复可中断性。 | rewrite lease 与 provider application lease 归属 scope；失败或中断也须清理。              |
| 并发有生命周期   | fiber 具有监督与 scope 关系；Promise 适配无法在外部工作不配合时取消它。                               | 与 prompt completion 共享 session 串行边界；Stop 必须保留 ACP owner，直到完成或确认终止。 |
| 依赖显式声明     | v3 `Context.Tag` 标识服务，`Layer` 构造实现。                                                         | 注入存储与执行 port，避免把整个 execution service 或其可变 map 传进新服务。               |

已检查安装包的 `src/internal/core.ts`（`acquireUseRelease`）、
`src/internal/fiberRuntime.ts`（`acquireRelease`）、`src/internal/core-effect.ts`
（`tryPromise`）以及 `src/ManagedRuntime.ts`。对应的
[3.18.4 源码](https://github.com/Effect-TS/effect/tree/ede2ea11c2abe7038bac3c83fb7b5eef101858d2/packages/effect/src)
是 API 依据。另已阅读上游 v3 的
[资源测试](https://github.com/Effect-TS/effect/blob/1af4232fea7bc613e1dc68db9bec7b1f596d9e68/packages/effect/test/Effect/acquire-release.test.ts)
与[中断测试](https://github.com/Effect-TS/effect/blob/1af4232fea7bc613e1dc68db9bec7b1f596d9e68/packages/effect/test/Effect/interruption.test.ts)
作为补充语义证据；未运行这些测试，也未假定它们与固定版本完全相同。

## 拟议边界

UI 为选中的行传入 `{ sessionId, queueItemId, expectedTurnId }`，展示结果，无需选择
provider 交付方式。daemon operation 验证这些标识与编辑归属，再由
`QueueSteerService` 内部选择 native delivery 或 cancel-and-dispatch。Effect 在服务
内部负责组合、类型化失败、lease 与 finalization。

`SessionExecutionService` 保留 live turn 的所有权，暴露窄执行操作。它不应仅为推进
queue recovery journal 而接收 queue phase 或 `onSubmitting` 等回调。队列存储保留
现有 history 与 activation 发布责任。request handler 在一个边界把 Effect 结果转换
为现有响应协议。

native preparation、provider submission、确认后的所有权交接与回执完成组成一条
交付链；cancel-and-dispatch 组成另一条。用 `Effect.gen` 表达顺序，以 tagged recovery
handler 处理特定可恢复失败。仅把现有 async 方法包进 `Effect.tryPromise` 不会改变
生命周期归属。

当前 renderer 还兼容旧 daemon，实现前需要使这项兼容策略与单 operation UI 一致：
保留兼容需要将 legacy 行为封装到 UI 下层；移除兼容则需要更新 draft
[交互 Spec](../../../../specs/message-queue-interactions.md) 与兼容性测试。
本次研究没有隐式移除这项能力。

## 恢复边界

finalizer 释放拥有的资源，无法撤销 provider 已接受的交付。类型化的 provider 拒绝
可以允许普通 dispatch；交付不确定则不允许。不能对整个交付 operation 使用
`Effect.retry`，也不能把 timeout 或 interruption 当成未交付的证据。

保留[原决策](../../implemented/feature/2026-09-13-queue-steer-controls.md)中的
machine-local 恢复证据与保守重放规则，将其归属迁移到 operation service；不为每个
Effect 步骤新增 durable phase。核心 `Scope` 清理无法跨越进程死亡。引入 workflow
engine 是独立的依赖与架构决策，仅为表达这两条交付链无需引入它。

## 待完成的验证

实现须保留可观察行为覆盖：选择 C 后 A/B 顺序不变、队列项缺失或编辑中、expected turn
过期、native 接受或拒绝、Stop 与 acknowledgment 竞态、持久化失败，以及响应丢失和
重启恢复。新增确定性失败与中断验证，证明 lease 会释放，同时不会放弃仍在运行的 ACP
owner。验证 UI 通过单 operation 调用，并在选定边界验证旧版本兼容。

本 note 仅记录源码研究与拟议拆分。业务代码、依赖版本及现有 Spec 均未修改；未为此
提案运行 runtime 测试。
