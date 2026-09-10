# Provider 失败后收敛上下文压缩状态

Status: implemented
Translation: current

[English](2026-09-10-context-compaction-terminal-state.md)

## 摘要

远端上下文压缩请求失败或取消后，其 tool-call 条目可能仍停留在 `pending` 或
`in_progress`，导致 provider 已不再活跃时，消息流和会话用量底栏仍无限显示旋转状态。
现在，失败的 provider prompt 已结束或取消中的 prompt 被成功 terminate 后，Lody 会把该
turn 内未收敛的压缩活动持久化为 `failed`；渲染层继续直接遵循持久化 tool-call 状态。

## 决策

压缩活动与承载它的 assistant turn 具有不同的终止信号。`SessionHistory.finished` 记录
host finalization，其中也包括被中断 turn 的 teardown，因此不能证明 provider prompt 已
停止；UI 不应从该字段推断压缩终态。

Prompt error path 提供了更强的证据：一个已经启动的 prompt 带错误返回了控制权，且已不再
处于 in-flight 状态。在 finalization 清理 turn state 前，这条路径要求 finalizer 仅把该
assistant turn 内 `pending` 或 `in_progress` 的 context-compaction 条目改为 `failed`。这个
生命周期信号可以覆盖 `Connection failed: error sending request` 一类传输错误，不依赖
numeric ACP error code 或错误文案白名单。

取消分为两个阶段。Host teardown 先记录 turn 已取消，但保持 compaction 活跃；随后执行
owner 等待 raw ACP request，五秒后可以 terminate 旧 session，而 terminate 失败时继续等待
raw completion。只有 drain 完成以后，host 才收敛未完成 compaction、flush usage state，
并释放 owner。Provider 已写入的终态保持不变；相同 `toolCallId` 的迟到 provider update 仍可
把 `failed` 覆盖为 `completed`。

该设计修复未来的 error path，并处理之后再次经过 failure-aware finalization 的历史。
它不会迁移已经持久化的陈旧历史，因为这些历史里没有 durable evidence 能区分 #570 和
“已中断但 provider prompt 仍活跃”的情况。

## 范围与验证

本修复通过 [PR #573](https://github.com/LodyAI/Lody/pull/573) 处理
[issue #570](https://github.com/LodyAI/Lody/issues/570)。它与
[PR #571](https://github.com/LodyAI/Lody/pull/571) 的 provider ownership recovery 组合后，
也补全了 [issue #267](https://github.com/LodyAI/Lody/issues/267) 所需的 compaction activity
清理：被中断的 `/compact` 在 provider prompt 仍活跃时保持 active，并在下一 prompt 可以
取得 session 前进入终态。

单元测试直接使用 #570 的原始传输错误 shape，验证 prompt 已结束时即使没有 ACP code 也会
请求 compaction settlement。确定性的 cancellation 测试验证：保留 raw provider ownership
期间 compaction 仍为 active；raw completion 或成功 terminate 后变为 failed；terminate
失败后继续 active；且下一 prompt 执行前已经完成收敛。生命周期回归还覆盖 Loro 文档重新
打开、迟到的 completed update，以及下一 turn 的新压缩。本次没有增加 Model API
Simulator 或端到端测试。
