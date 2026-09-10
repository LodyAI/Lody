# Provider 失败后收敛上下文压缩状态

Status: implemented
Translation: current

[English](2026-09-10-context-compaction-terminal-state.md)

## 摘要

远端上下文压缩请求失败后，其 tool-call 条目可能仍停留在 `pending` 或
`in_progress`，导致消息流和会话用量底栏无限显示旋转状态。现在，当 provider prompt 返回
ACP error 或 agent 断连时，Lody 会把该 turn 内未收敛的压缩活动持久化为 `failed`；渲染层
继续直接遵循持久化 tool-call 状态。

## 决策

压缩活动与承载它的 assistant turn 具有不同的终止信号。`SessionHistory.finished` 记录
host finalization，其中也包括被中断 turn 的 teardown，因此不能证明 provider prompt 已
停止；UI 不应从该字段推断压缩终态。

Prompt error path 提供了更强的证据：ACP prompt 已返回错误，或者 provider connection 已
结束。在 finalization 清理 turn state 前，这条路径要求 finalizer 仅把该 assistant turn
内 `pending` 或 `in_progress` 的 context-compaction 条目改为 `failed`。普通完成和取消不会
请求该收敛。Provider 已写入的终态保持不变；相同 `toolCallId` 的迟到 provider update 仍可
把 `failed` 覆盖为 `completed`。

该设计修复未来的 error path，并处理之后再次经过 failure-aware finalization 的历史。
它不会迁移已经持久化的陈旧历史，因为这些历史里没有 durable evidence 能区分 #570 和
“已中断但 provider prompt 仍活跃”的情况。

## 范围与验证

本修复通过 [PR #573](https://github.com/LodyAI/Lody/pull/573) 处理
[issue #570](https://github.com/LodyAI/Lody/issues/570)。它不同于
[issue #267](https://github.com/LodyAI/Lody/issues/267)：后者是手动 `/compact` 被中断后，
provider prompt 可能确实仍处于活跃状态。普通 cancellation finalization 会有意保留该压缩
活动，而不是在 UI 中隐藏它。

单元测试验证普通 finalization 会保留未收敛活动，而 ACP failure 会请求收敛。一条确定性
生命周期回归测试使用生产 ACP history writer 和 finalizer，覆盖普通及 failure-aware
finalization、Loro 文档重新打开、迟到的 completed update，以及下一 turn 的新压缩。本次
没有增加 Model API Simulator 或端到端测试；issue #267 仍需要单独修复 provider
cancellation。
