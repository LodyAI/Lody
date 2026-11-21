# Antigravity ACP v1 后台工作与空闲 GC

Status: implemented
Translation: current

[English](2026-11-16-antigravity-background-wakeup.md)

## 摘要

`agy acp` 在后台工作仍在运行时就以 `end_turn` 结束 `session/prompt`，之后不再向 stdout
写入，于是 Lody 的空闲 GC 会杀掉仍在工作的进程。Lody 现在照常结束 turn，并在这些工作
唤醒模型、重新安静之前合成 Core `sessionActivity`，只使用无副作用的 `session/list` 轮询。
agy 在这些唤醒中产生的输出不会回放到 Lody：唯一能返回它的接口 `session/load` 会重启会话
的 MCP 服务器，并在真机运行中打断了一次工具调用。

## 问题

`agy acp`（`Antigravity ACP Server`，ACP v1）只要模型让出控制权就以 `end_turn`
结束 `session/prompt`，即使它启动的后台工作仍在运行：超过异步阈值的
`run_command`、`schedule` 定时器与 cron、`invoke_subagent` / `send_message`、
`swarm` 以及异步 `run_workflow`。这些工作结束后，agy 在自己的会话里唤醒模型，
但不再向 stdout 写 `session/update` 或 `session/request_permission`。agy 没有声明
Core `sessionActivity` 扩展，所以 Lody 看到的是空闲会话，`SessionGCManager` 在空闲
超时后杀掉了仍在工作的进程。

## 决策

修复留在 `apps/cli/src/agent/`（`antigravity-background.ts` 与 `AgentClient`），复用
[Session GC 尊重原生 Agent 的工作](2026-10-18-gc-respects-native-agent-work.zh.md)
的原生工作契约：turn 在 `end_turn` 结束，由 `sessionActivity` 保持进程存活。

- **`end_turn` 时的待完成项。** 根据 turn 中实时收到的通知，下列未解决工具各计一项：仍处于
  `pending` 或 `in_progress` 的工具；输出为 agy「running as a background task」占位文本的
  工具；派出只能靠唤醒模型报告结果的工作的工具（`invoke_subagent`、`send_message`、
  `swarm`、没有输出的 `run_workflow`）。agy 会让 `schedule` 一直保持 `in_progress`
  直到触发，所以定时器不需要特殊处理。`IsDaemon: true`、失败与取消的工具不计入。不解析
  agy 工具参数。由于 agy 在同 turn 内通过 `<SYSTEM_MESSAGE>` 投递后台任务完成通知而不会
  更新原占位 `tool_call`，当 Lody 收到带 `sender` 的 `<SYSTEM_MESSAGE>` `user_message_chunk`
  （优先按 `taskId` 精确匹配），或在可见 `agent_message_chunk` 之后、无工具调用介入的情况下
  收到新的 `agent_thought_chunk` 时，会将对应同 turn 后台项标记为已解决。
- **按活动释放。** 存在待完成项时，Lody 每 2 秒查询一次 `session/list`，上报
  `background`，`updatedAt` 变化期间上报 `running`。一段 `updatedAt` 变化之后保持
  30 秒不变，计为完成一项。没有剩余项时、显式 `session/cancel` 时上报空闲；最长 24 小时，
  与 Core `background` 上限一致。如果没有 `session/list` 或它持续失败，监视器会一直保护到上限。
- **跨 turn。** 用户发出新消息时仍未完成的项会延续到新 turn，之前的后台工作继续受保护；
  如果新 turn 开始时已有一轮 turn 后唤醒正在进行，则会先结算该项再延续其余项。
- **`cwd`。** Lody 把工作目录的 `realpath` 作为 Antigravity ACP 的 `cwd` 协商；agy 按
  realpath 比较编辑目标，否则符号链接工作目录下的工作区内编辑也会要求审批。

## 已否决方案

- **从 `session/load` 快照回放唤醒输出。** 已实现并在真实 agy 1.5.7 与
  `gemini-4-hydrogen-medium` 上测试，回放本身可用。但每次加载都会停止并重启会话的 MCP
  服务器：按 6 秒节奏，125 秒内 19 次加载、20 次服务器启动。把加载限制为每分钟一次、
  且只在 `updatedAt` 静止 10 秒后进行，一次 30 秒的 MCP 工具调用仍在约 10.7 秒处被切断，
  以 EOF 返回 `failed`，因为工具运行期间 `updatedAt` 不会变化。从外部无法用任何时间规则
  区分「说完了」和「在等一个慢工具」。
- **加载时传空的 `mcpServers`。** 未经验证；agy 可能在会话剩余生命周期内卸下其 MCP 服务器。
- **直接读取 agy 磁盘上的会话记录。** 没有副作用，但格式没有文档，任何 agy 版本都可能改变。
- **保持 `session/prompt` 挂起直到后台工作完成。** 最多锁住输入栏 30 分钟，还需要第二套
  状态机；原生工作契约已经覆盖 turn 结束后的后台工作。
- **按 agy 工具参数计数**（`DurationSeconds`、`CronExpression`、`MaxIterations`、swarm
  `tasks`/`n`、`manage_*` kill）。agy 一改参数计数就会出错。
- **`end_turn` 后发送合成 prompt 或 steer。** 根 `AGENTS.md` 禁止引导 agent 的文本。
- **在 `SessionGCManager` 或 `MessageHandler` 中特判 Antigravity。** 这些消费者保持与
  提供方无关。

## 验证

`apps/cli/src/agent/antigravity-background.test.ts` 用真实 `AgentClient` 对接模拟的
`session/list`，固定以下行为：turn 在 `end_turn` 结束、静默工作在空闲超时之后仍受保护、
每个待完成项对应一次唤醒、24 小时上限、`session/list` 失败时继续保护、守护进程与失败工具
排除、跨新消息延续、`realpath` 协商，以及从不调用 `session/load`。真机运行覆盖的是本 note
否决的回放设计；仅按活动释放的规则尚未在真实 agy 上运行。

## 局限

- agy 在 `end_turn` 之后写出的输出不会出现在 Lody 中。agy 提供无副作用的读取方式后，
  可以在不重启 MCP 的前提下回放。
- 多个待完成项在同一段活动中唤醒 agy 时只会释放一项，会话会一直受保护，直到下一段活动或
  24 小时上限。模型在唤醒中新启动的工作不会计入。
- `end_turn` 后等待 agy 未转发的权限请求的工具，仍会卡住该 agy 会话，直到用户取消；
  `realpath` 协商消除了最常见的触发原因。
