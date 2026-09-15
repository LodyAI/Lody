# 在不盲目重放的前提下协调已停止的 steer

Status: implemented
Translation: current

[English](2026-09-13-stopped-steer-reconciliation.md)

## 摘要

当 Stop 结束目标轮次而 ACP 投递结论仍未返回时，steer 可能永久停在 `pending_apply`。本修复只取消本地应用等待，让 raw request 继续由现有 ACP cleanup 持有，并把明确拒绝交回普通 dispatch，或记录明确可见的投递未知终态。这样既不会遗留历史孤儿，也不会盲目重放，同时保留更新轮次的 dispatch ownership。

## 问题与边界

[Issue #666](https://github.com/LodyAI/Lody/issues/666) 描述了 [#571](https://github.com/LodyAI/Lody/pull/571) 的 Stop ownership 修复之后仍存在的生命周期缺口。renderer 的五秒 RPC 超时有意不被视为未投递证明，但 Stop 此前既不能释放应用 waiter，也不能结算对应的 `pending_apply` 行。相关的 [#477](https://github.com/LodyAI/Lody/issues/477) 和已关闭的 [#471](https://github.com/LodyAI/Lody/pull/471) 还说明，重排旧 steer B 时不能覆盖更新的用户轮次 C；[#530](https://github.com/LodyAI/Lody/issues/530) 则提出更广泛的可见恢复体验。

本次改动不引入新的持久状态体系，也不重发结果含糊的请求，只扩展现有历史元数据和 Stop cleanup 边界。

## 决策

- `AgentClient` 暴露已提交 steer 的 delivery promise，并把 request-method steer 纳入 `pendingPrompts`。因此中止应用等待可以释放 session queue，同时不丢弃 provider verdict。
- Stop 等待 steer mutation queue 释放，再沿用现有 prompt drain/termination 路径。明确的 `AgentSteerNotDeliveredError` 会把 exact row 恢复为 `pending` 并更新 `messageQueueUpdatedAt`，但绝不写入由 producer 持有的 `latestUserMsgId`。
- 已接受或传输结果未知、但缺少应用 commit 时，先把精确 id 写入有界的持久 metadata fence，再把可见行终结为 `failed` 并记录 `_lodySteerOutcome: delivery_unknown`。该 fence 阻止 daemon 重启或迟到 history 副本再次派发旧 steer；UI 只允许作为新轮次重发，并提示 provider 可能已收到原请求。
- Finalization 会隔离迟到结果，避免其转移 ownership、把已停止的 source 标为 handled，或复活旧行。

## 备选方案与取舍

自动重排所有已停止 steer 更简单，但在投递结果含糊时可能造成重复工作。把成功的 request response 当作已应用，则会混淆 provider 接受与 acknowledged-steer 契约中的 successor-turn application commit。在现有 session metadata 中保存有界的精确 id 列表，既能提供重启 fence，也无需引入独立状态体系或可变重放队列。

可见重试仍由用户决定。Lody 无法证明结果含糊的 provider 是否已执行副作用，因此对话框会解释风险，而不会声称 exactly-once execution。

## 验证

确定性 CLI 测试让 steer request 在 Stop 和 termination 期间保持 unresolved，并覆盖其 history 行尚未同步的情况，验证 cleanup 能释放、持久 fence 独立于 history 生效，且更新轮次保留 dispatch ownership。Dispatch 测试验证 fence 只抑制匹配的 RPC/history activation；Component 测试验证 marker 识别和新轮次重发边界。
