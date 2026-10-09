# 在 GUI 中显示被拒绝的模型选择

Status: implemented
Translation: current

[English](2026-10-09-model-rejection-gui-warning.md)

## 摘要

Codex 和 Claude 拒绝模型选择时，错误原先只进入 debug 日志，恢复的 Turn 因而
可能使用旧模型，却没有解释选择为何未生效。现在所有 provider 的模型拒绝均进入
现有的持久化 GUI 警告路径，包括通过模型 config option 传入的选择。实际模型仍
以 agent 确认的状态为准。警告投递保持异步，不中止 Turn。

## 决定

本变更部分替代 CLI 的警告策略：模型选择失败向用户可见，Codex/Claude 的
effort、Fast 和 Plan 不匹配仍保持隐藏。
[编排 Spec](../../../../specs/session-orchestration.zh.md#运行时拒绝模型)
以 draft 记录这一保证的变更。
[模型能力决定](../architecture/2026-09-29-per-model-acp-capability-row.zh.md)
继续负责 effort 和 Fast 的发现与校验。

`applyAcpSessionRunConfig` 将标量 `modelId` 和模型 config option 的拒绝都写入
`warningSelections`。`MessageHandler` 已负责将这些选择持久化为
`agent_warning`，现有 GUI 警告视图负责显示。被拒绝的选择不会覆盖运行时 patch
中的实际模型。本变更不展示 provider 的原始错误 payload，也不改变 Turn 执行策略。

## 验证与限制

现有 applier 测试覆盖各 provider 的两种传参方式、标量优先级，以及拒绝后保留
实际模型。现有 MessageHandler history-gate 测试验证真实 SessionDocument 在
发起的用户 Turn 后收到 GUI 警告。两套测试在本地通过，共 21 项；定向 Oxfmt 和
Oxlint 检查也通过。临时 runner 复用相邻 checkout 的依赖，并禁用未使用的 Roost
导入，验证的仍是真实 Loro 历史路径。完整 CLI 类型检查受缺失的 adapter 子模块和
借用的 workspace 依赖版本不兼容阻塞。不声称已完成打包 GUI 验收。
`withTransportRetry` 吞掉 transport 错误仍是另一条未解决的失败路径。
