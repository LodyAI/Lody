# Codex 分模型用量归因

Status: proposed
Translation: current

[English](2026-09-15-codex-per-model-attribution.md)

## 摘要

Codex 的 thread 总量此前没有模型归属，因此用量界面只能显示不透明的
`codex:unattributed` 桶。锁定 runtime 还会发送精确的单次 completion 用量事件；
适配器现在会把这些事件归到已解析的模型，只把未覆盖的余量保留为未归属，并在
resume 时恢复一个小的累计 sidecar。fork 会话会排除源历史。sidecar 丢失和
消费端长期 accounting identity 仍是未解决限制。

## 背景

Codex app-server 的 `thread/tokenUsage/updated` 只有 thread 级累计值，没有
model 字段。适配器过去把全部总量放在 `codex:unattributed`，因此 AI 用量页面
无法把 Codex token 归到实际产生它们的模型。

## 修正

锁定 Codex 0.153.4 还会为每次上游 Responses API completion 发送
`rawResponse/completed`。它的 `usage` 是精确值，不累计也不 replay，`responseId`
可用于幂等去重。适配器现在把这些事件归到已解析的 thread/turn 模型。任何没有被
精确事件覆盖的 thread 总量仍留在 `codex:unattributed`，因此旧 runtime 或无法
解析模型时，总量仍然正确，而不是伪造一个模型。

适配器还会在 `$CODEX_HOME` 下保留一个小的累计 sidecar，并在 resume 时恢复。
fork 会话会把源历史总量记为 excluded，因此 fork 子会话只报告 fork 之后的用量。
sidecar 不是投递账本；CLI 仍会重试自己的累计快照。CLI 不再为 legacy adapter
从当前 UI 选中模型合成 `modelUsage`；缺失归因时直接跳过。

## 限制

- sidecar 是机器本地的。恢复一个 exact-attribution thread 时如果 sidecar 丢失，
  新进程可能把历史 token 当作未归属。长期方案仍然是消费者侧持久的 accounting
  identity。
- `rawResponse/completed` 在锁定 runtime 中是内部 app-server 事件，需要像生成的
  客户端类型一样遵守版本/能力约束。
- Subagent thread 有 `thread/settings/updated` 时使用自己的模型；否则其精确响应
  会回落到 `codex:unattributed`。

## 证据

- `src/CodexUsageAccounting.ts`
- `src/CodexUsageBaselineStore.ts`
- `src/CodexEventHandler.ts`（`rawResponse/completed`、`thread/settings/updated`、
  `model/rerouted`）
- `src/__tests__/CodexACPAgent/token-usage-events.test.ts`
- `apps/cli/src/agent/agent-client.ts`（不再回落到 UI 模型）
