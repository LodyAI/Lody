# 在 turn 边界终止陈旧的上下文压缩状态

Status: implemented
Translation: current

[English](2026-09-10-context-compaction-terminal-state.md)

## 摘要

远端上下文压缩请求失败后，其 tool-call 条目可能仍停留在 `pending` 或
`in_progress`，即使 Lody 已经结束了承载它的 assistant turn；因此消息流和会话用量
底栏都会无限显示旋转状态。现在 UI 将已结束的 turn 作为活动边界，把其中未收敛的压缩
状态投影为失败，同时保持 provider 写入的持久历史不变。这个处理既能修复已经受影响的
历史，也覆盖后续失败，并不依赖协议模拟器；但它不会尝试复刻特定 provider 的线协议
输出。

## 决策

压缩活动条目和承载它的 assistant turn 由不同主体写入。Provider 更新负责 tool-call
状态，Lody 的 turn finalizer 负责 `SessionHistory.finished`。因此传输失败可能结束 turn，
却收不到 tool call 的终态更新。

渲染层现在为两个消费方解析同一个有效压缩状态。`pending` 或 `in_progress` 仅在
assistant turn 尚未结束时保持活跃；turn 结束后，它会显示为失败，也不再计入会话级
“正在压缩”状态。Provider 明确写入的 `completed` 和 `failed` 状态保持不变。

这是一条投影规则，不是历史迁移。重写持久化 tool call 会抹掉 provider 证据和 Lody
恢复推断之间的区别，而只修复未来的错误路径又会让已经受影响的会话继续卡住。两个渲染
路径都能取得 turn 边界，它是最窄且可靠的终止信号。

## 范围与验证

本修复对应 [issue #570](https://github.com/LodyAI/Lody/issues/570)。它不同于
[issue #267](https://github.com/LodyAI/Lody/issues/267)：后者是手动 `/compact` 被中断后，
后端 turn 可能确实仍处于活跃状态；本次改动不调整 ACP 生命周期或取消行为。

单元测试覆盖未结束的活跃状态、已结束但未收敛的状态，以及显式终态。组件类型检查覆盖
turn 边界在两条 assistant tool-call 渲染路径中的传递。本次没有增加 Model API
Simulator 或端到端测试；特定 provider 的协议复现不属于这次 UI 状态恢复的范围。
