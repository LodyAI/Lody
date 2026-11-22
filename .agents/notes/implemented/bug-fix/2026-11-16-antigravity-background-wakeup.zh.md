# Antigravity ACP v1 后台工作与空闲 GC

Status: implemented
Translation: current

[English](2026-11-16-antigravity-background-wakeup.md)

## 摘要

`agy acp`（`Antigravity ACP Server`，ACP v1）在后台工作仍在运行时就会以 `end_turn` 结束
`session/prompt`、停止向 stdout 输出，且未声明 Core `sessionActivity`。Lody 曾尝试通过
stdout 工具通知启发式计数与 `session/list` `updatedAt` 轮询来合成 `sessionActivity`，但
线上证实误计数会导致会话卡在 `running`（“工作中”）状态、抑制未读/完成通知，并持续每 2 秒
轮询 `session/list` 长达 24 小时。现已彻底移除启发式合成，仅保留确定性的 Antigravity 兼容
逻辑（`isAntigravityServer` 与 `realpath` `cwd` 协商），并仅在服务端权威声明 Core
`sessionActivity` v1 时消费原生工作状态。

## 问题

`agy acp` 不声明 Core `sessionActivity`（`_lody/session/activity_update`）。当
`run_command` 超过 `WaitMsBeforeAsync` 时，`agy` 会输出占位文本（`Tool is running as a
background task with task id: ...`），任务完成时通过内部 `<SYSTEM_MESSAGE>` 唤醒模型，而
不更新原 `tool_call`。基于 stdout 通知猜测待完成数量并用 `session/list` `updatedAt` 波动
递减的启发式方案在真实会话中频繁误判：

- 同 turn 内已完成的后台命令（尤其模型回复无 `agent_thought_chunk` 时）在 `end_turn` 时
  仍被计入待完成项。
- 多个后台任务在同一波 `updatedAt` 活动中结束只会减 1，其余项会一直锁死到 24 小时上限。
- 把不可靠的启发式接入 `AgentClient.reportsSessionActivity()` / `getNativeWork()` 后，
  `SessionActivePresence` 会持续广播 `running`（UI 卡在“工作中”），`SessionExecutionService`
  会抑制完成通知并在超时后写出误报的 `nativeWorkInterrupted`，且后台每 2 秒轮询一次
  `session/list`。

## 决策

- **移除启发式 `sessionActivity` 合成。** `AgentClient.reportsSessionActivity()` 仅在
  agent 权威声明 Core `sessionActivity` v1 时返回 `true`。在 `agy` 未提供权威活动协议之前，
  turn 在 `end_turn` 正常结束并沿用标准空闲 GC，与
  [Session GC 尊重原生 Agent 的工作](2026-10-18-gc-respects-native-agent-work.zh.md) 一致。
  若未来 `agy` 声明了 Core `sessionActivity` v1，`AgentClient` 会直接按权威协议消费。
- **保留确定性的 Antigravity 兼容逻辑。** `antigravity-background.ts` 保留
  `isAntigravityServer`（内置 `antigravity` 与自定义 `Antigravity ACP Server` 对齐，排除
  旧版 `antigravity-acp`），`AgentClient` 保留 `realpath` `cwd` 协商以避免符号链接工作目录
  触发越界审批。

## 已否决方案

- **基于 stdout 工具通知 + `session/list` 轮询合成 `sessionActivity`。** 2026-11-16 实现、
  2026-11-22 移除：缺乏服务端权威任务计数时，误报会让会话卡在“工作中”长达 24 小时。
- **从 `session/load` 快照回放唤醒输出。** 在真实 `agy` 1.5.7 上验证过：每次 `session/load`
  都会重启会话的 MCP 服务器，打断正在运行的工具调用。
- **直接读取 `agy` 磁盘上的会话记录。** 属于无文档内部格式，随版本变化不可依赖。
- **挂起 `session/prompt` 或在 `end_turn` 后发送合成 steer。** 会锁住输入栏或违反根 `AGENTS.md`。

## 验证

`apps/cli/src/agent/antigravity-background.test.ts` 驱动真实 `AgentClient`，固定以下契约：
内置/自定义 `Antigravity ACP Server` 对齐并排除旧版 `antigravity-acp`；未声明 Core
`sessionActivity` 时 `end_turn` 后绝不合成 `nativeWork` 也不轮询 `session/list` / `session/load`；
若服务端权威声明 Core `sessionActivity` v1 则正常消费；以及 `realpath` `cwd` 协商。
