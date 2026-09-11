# 使用实时所有权证据协调陈旧的上下文压缩状态

Status: implemented
Translation: current

[English](2026-09-11-stale-context-compaction-reconciliation.md)

## 摘要

Provider failure 修复之前写入的 Session，可能在 Agent 已停止后仍保留 `pending` 或
`in_progress` 的 context-compaction item，导致重新打开或升级后仍显示持久化的旋转状态。
现在，Lody 会把 owner turn 已 finished 的记录视为修复候选，并请求 Session 当前的 owner
daemon 协调精确的 turn 与 tool-call id。只有实时执行所有权证明该 turn 已不活跃时，daemon
才会写入 `failed`；证据缺失或存在歧义时，历史保持不变。

## 决策

Renderer 仍只读取持久化的 compaction 状态。它不会把 `SessionHistory.finished`、超时、
重启或 presence 缺失重新解释成 provider 已终止。最新 compaction 未完成且所属 assistant
turn 已 finished 时，renderer 会在 Session 打开期间发起一次经过 capability gate 的协调请求。
Transient `unknown` 可以在后续历史活动后重试；不支持该能力或不可访问的 daemon 不会触发
其他写入 fallback。

请求携带 `sessionId`、`turnId` 和 `toolCallId`。目标 daemon 先验证当前 Session metadata
确实把所有权分配给本机，然后在现有 Session history rewrite barrier 内检查 execution-service
turn ownership、阻塞中的 Session 创建、active presence 和 pending dispatch。目标 turn 仍
active，或存在未归属工作导致结论不确定时，历史不变。当 daemon 能证明该 turn 已不是实时
owner 时，它只把指定且未完成的 `context_compaction` item 改成 `failed`；已有终态、不匹配、
未知和无关的持久化 item 均被保留。

该修复针对打开的 Session 惰性执行，而不是启动时迁移。全局扫描会激活数量不受控的旧文档，
却仍无法建立 provider 所有权。版本化的 Machine capability negotiation 也确保混合版本客户端
不会向未实现这套证据契约的 daemon 发送写请求。

## 替代方案与边界

基于记录年龄的清理被否决，因为经过多长时间不能证明 provider 已释放 turn。只在 UI 隐藏
spinner 也被否决，因为这会让 transcript 与持久化历史及其他 reader 不一致。把 `finished`
视为充分条件同样被否决；正如
[provider failure 决策](2026-09-10-context-compaction-terminal-state.zh.md)所记录，host
finalization 可能早于 provider termination。

Owner daemon 离线或版本过旧时无法修复该 item；Session 会继续显示其持久化状态，直到兼容的
owner 能提供证据。本次变更不假定每一条历史未完成 compaction 都已陈旧，也不会改写当前视图
请求之外的活动。

## 验证

行为测试覆盖精确 item 修改、active 与 indeterminate 所有权结果、owner-daemon 持久化、本地
capability gating 和 Loro Streams RPC 分发。共享 schema 会校验请求与响应 shape。本次没有
加入启动扫描、存储迁移或端到端 provider fixture。
