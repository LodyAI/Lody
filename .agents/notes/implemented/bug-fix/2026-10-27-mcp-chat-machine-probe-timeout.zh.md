# 由 presence 而不是一次性 RPC 探测判定目标机器是否离线

Status: implemented
Translation: current

PR: [#1939](https://github.com/LodyAI/Lody/pull/1939)

[English](2026-10-27-mcp-chat-machine-probe-timeout.md)

## 摘要

当一次性 Loro Streams 状态 RPC 在短暂的传输变慢中超时时，`lody_session_chat` 会对
presence 显示在线的机器返回永久性的 `COMMAND_REJECTED: Machine … is offline or
unavailable.`；`session_status_many` 也会把同一台机器报为离线。现在移除了该探测的远端
分支。会话的 create、chat、cancel 以及两个状态读取函数，只在 presence 明确判定离线时
才把远端目标视为离线，并以带类型、可重试的 `MACHINE_OFFLINE` 报告。presence 未知时
继续执行；状态读取中的 RPC 超时只让实时状态变为 stale。权限、所有权、归档和会话
存在性检查保持不变。

## 原因

`ensureTargetMachineOnline` 每次针对远端目标都新建 Streams RPC 客户端，并发送
`requestMachineStatus({ timeoutMs: 10_000 })`。超时返回 `null`，代码用与明确失败
相同的消息报告它。在 MCP chat 路径中，这个普通 `Error` 不匹配任何映射，于是变成
`COMMAND_REJECTED`、`retryable: false`（批量为 `INVALID_ITEM`）。在状态读取中，它
会在实时状态 RPC 执行之前就把 `machineOnline` 设为 false。现场证据：调用方自己的
Streams 连接同一时刻重连耗时约 29 秒，而 presence 和稍后相同请求的重试都显示目标
在线。

## 决定

这个探测并没有保护调用方真正需要的东西：

- create 和 chat 通过已同步的 Session 文档投递。写入之后的 dispatch RPC 本来就是
  尽力而为的快速路径，Coordinator 也会在 Operation 截止时间内重试落地。
- cancel 和状态读取紧接着就会发送自己的 RPC（`requestSessionCancel`、
  `requestSessionLiveStatus`），该 RPC 自己就会报告不可达。

因此 `ensureTargetMachineNotOffline` 保留不依赖 RPC 的检查：

- 会话命令环境的工作区/机器匹配；
- 同机目标的本地 daemon 检查，它保留了 `DAEMON_NOT_RUNNING` 与 `DAEMON_BUSY` 的
  区分。

对远端目标，它读取三态 presence，只有明确离线时才抛出 `MachineOfflineError`。

对状态读取，由 presence 决定 `machineOnline`。presence 未知时，只有已应答的实时状态
RPC 才算在线证据，因为状态的布尔结构没有第三种取值。

在 MCP 中，接受之前 `MachineOfflineError` 保持其可重试的 `MACHINE_OFFLINE` 错误码，
单个和批量 chat 都是如此。若在投递一个已接受的单个 chat 时出现该错误，工具会返回
仍为 active 的 Operation 供 daemon 重放，与 create 和批量 chat 的现有行为一致。

考虑过的替代方案：保留探测，只把超时重新分类为可重试的 `MACHINE_UNREACHABLE`。
没有采用，因为每次调用前仍要经历缓慢的 token/gateway/流建立，而且调用方仍需重试
本已由持久路径负责的工作。

## 范围与限制

人类 CLI 的 `session create/chat/cancel` 现在只在 presence 离线时快速失败。presence
在线但不可达的远端机器，会由 cancel RPC 或最终投递发现。MCP `session_create` 在接受
前本来就跳过这项检查，保持不变。测试使用注入的 presence 和会拒绝的 RPC stub，没有
端到端复现 Streams 变慢。
