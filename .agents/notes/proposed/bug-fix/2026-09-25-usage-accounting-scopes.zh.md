# 用量计量范围跨越 adapter 重启

Status: proposed
Translation: current

[English](2026-09-25-usage-accounting-scopes.md)

## 摘要

除 Codex 外，所有 builtin ACP agent 的 Token 用量都被少算。Adapter 上报的分模型
累计值随进程重启归零，但 resume 后 CLI 仍沿用同一计量身份（ACP session ID），
而托管端按身份取最大值，于是每次重启后的新用量在超过旧总量前都被隐藏。Core
现定义永不复用的 `_meta.lody.usageScopeId`：Claude 以每条 SDK result、Codex 以
native turn、Kimi 以激活、共享累加器（Grok、DSH）以实例为范围。CLI 把每个范围
映射为独立身份，托管端不变。已少算的数据无法恢复，Pi 用量仍未入库。

## 问题

托管端 `upsertSessionUsageFromCli` 把 `modelUsage` 视为每个
`(session, user, acpSessionId)` 的累计值，并逐字段取 `max` 合并。回退的快照按设计
得到零增量，因此过期上报不会扣减已存储的用量。

各 adapter 的累计值只存在内存中：Claude 的 `usageBaseline`、Kimi 的
`lodyUsageSinceActivation`、Core 的 `SessionUsageAccumulator`。空闲回收、CLI
重启或崩溃会让 adapter 重启，并 resume *同一个* ACP session，其累计值于是在旧
身份下从零开始。每次重启丢失 `min(新用量, 历史峰值)`；长会话以 cache read 为主，
损失很大。Core 契约本已要求此时使用“新的消费端计量身份或恢复基线”，但只有
Codex 通过 `usageTurnId` 做到了。

## 决策

- **Core**：`_meta.lody.usageScopeId`（不超过 256 字符）表示 `modelUsage` 只在该
  范围内累计。范围 id 在 ACP session 内唯一，且永不复用。每个
  `SessionUsageAccumulator` 实例用随机 id 标注输出。
- **Claude**：每条 SDK result 是一个范围，以其 `uuid` 为键，只携带该 result 对
  query 级读数的新增。读数低于上一次时表示新的 `query()`，整份读数都计入。
  query 被替换时不携带任何状态。
- **Codex**：native turn id 作为 Core 范围发送，并在一个版本内同时以旧字段
  `codex.usageTurnId` 发送。
- **Kimi**：每次激活使用一个随机范围。
- **CLI**：任何 provider 的范围都映射为 `nativeSessionId:scope:encodedId`；无范围
  更新沿用 ACP session ID。

托管持久化、表结构和查询均不变。每个范围对应一行 `sessionUsageTotals`，行数随
result（Claude）或 turn（Codex）增长，与 Codex 现有行为一致。

## 备选方案

- **只上报 delta 并带幂等键。** delta 投递不是 exactly-once，adapter、CLI 合并与
  托管端都需要新账本。比范围方案侵入性更大，未采用。
- **由 CLI 追加按进程的代次后缀。** 能修复重启问题，但 adapter 更了解自己的原生
  生命周期；在 adapter 内划分范围也能让重试按 result 或 turn 保持幂等。
- **Claude 按用户 turn（`promptUuid`）划分范围。** 自主 result（task-notification
  跟进）没有用户 turn，但其费用真实存在；按 result 划分可以覆盖它们。

## 限制与后续

- 已少算的历史数据不会恢复。
- Pi 发送 `modelUsage: {}`，CLI 会跳过，因此 Pi 用量从未入库；模型归属需要另行决策。
- adapter 修复需在 Core 发布、各 adapter 发布或重新构建后才生效；未标注范围的
  adapter 仍会少算。

## 验证

- Core：`npm test`，含重启后新实例的范围测试。
- Claude：`vitest run`，覆盖逐 result 增量、重启后完整计入、无新增的 result 不上报。
  一个无关的 `acp-agent-settings` 测试在负载下失败，单独运行通过。
- Codex：`token-usage-events` 测试。
- Kimi：`e2e-turn` 与 `lody-extension` 测试，以及 `tsc`。
- CLI：`lody-acp-extension` 与 `usage-tracking-service` 测试。
