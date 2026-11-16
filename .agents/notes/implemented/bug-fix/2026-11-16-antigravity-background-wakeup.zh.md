# Antigravity ACP v1 后台任务唤醒与 GC 保护

Status: implemented
Translation: current

[English](2026-11-16-antigravity-background-wakeup.md)

## 摘要

`agy acp` 在后台工作仍在运行时就以 `end_turn` 结束 `session/prompt`，之后不再向 stdout
写入，导致 Lody 丢失唤醒输出并回收仍在工作的进程。Lody 现在照常结束 turn，在后台工作
未完成期间合成 Core `sessionActivity`，并从只读 `session/load` 快照把未显示的输出回放到
已结束的 turn。是否仍有后台工作由工具状态加安静窗口判断，而不是解析 agy 工具参数；
代价是轮询延迟，以及对长时间静默工作的有限等待。

## 问题

`agy acp`（`Antigravity ACP Server`，ACP v1）只要模型让出控制权就以 `end_turn`
结束 `session/prompt`，即使它启动的后台工作仍在运行：超过异步阈值的
`run_command`、`schedule` 定时器与 cron、`invoke_subagent` / `send_message`、
`swarm` 以及异步 `run_workflow`。这些工作结束后，agy 在自己的会话里唤醒模型，
但不再向 stdout 写 `session/update` 或 `session/request_permission`。agy 没有声明
Core `sessionActivity` 扩展，所以 Lody 看到的是空闲会话：唤醒输出没有进入历史，
`SessionGCManager` 在空闲超时后杀掉了仍在工作的进程。

## 决策

修复留在 `apps/cli/src/agent/`（`antigravity-background.ts` 与 `AgentClient`），
复用 [Session GC 尊重原生 Agent 的工作](2026-10-18-gc-respects-native-agent-work.zh.md)
已有的原生工作契约：turn 照常在 `end_turn` 结束，之后到达的输出写入已结束的
turn，与 Claude 后台任务的处理方式相同。

- **合成 `sessionActivity`。** turn 结束时如有后台工作，`AgentClient` 启动监视器并上报
  `background`；新输出出现后的几秒内上报 `running`。当本 turn 没有处于 `pending`
  或 `in_progress` 的工具、且安静窗口内没有变化时，监视器回到空闲。窗口为 30 秒；
  如果本 turn 派出的工作只能靠之后的唤醒报告完成（子代理、`send_message`、swarm、
  没有输出的 workflow，或输出是 agy「running as a background task」占位文本的工具），
  则为 10 分钟。agy 会让 `schedule` 一直保持 `in_progress` 直到触发，所以定时器
  不需要特殊处理。守护进程（`IsDaemon: true`）不计入。单个监视器最长 24 小时，
  与 Core `background` 上限一致。用户在后台工作完成前发出新消息时，尚未结束的工作会
  延续到新 turn，新 turn 结束后监视器继续运行并回放其完成结果；工具本身的更新写回该工具
  最初出现的那条回复。
- **只读回放。** 监视器每 2 秒查询一次 `session/list`，`updatedAt` 变化时执行
  `session/load`；最近 90 秒内有输出变化时每 6 秒额外加载一次，释放前再加载一次。
  agy 用步骤开始那一秒作为 `updatedAt`，慢回复可能在不改变它的情况下完成。
  不支持 `session/list` 的服务端每 10 秒加载一次。回放的通知被捕获而不转发。
  `AntigravitySessionTracker` 先折叠每个工具的回放状态，只有最终状态与 Lody
  已显示的不同时才发出；助手文本与思考文本按最后一条用户消息之后已流式输出的
  字符数截取。resume 时回放的历史记作基线，永不重发。
- **独占会话记录。** 新 prompt、cancel 与 detached close 会停止监视器并等待进行中的
  加载结束；配置、模式与模型切换会暂停监视器、完成后恢复，因此这些 RPC
  推送的通知不会被误当作回放。
- **孤立的权限请求。** `end_turn` 后变为 `pending` 且没有转发权限请求的工具会卡住 agy。
  4 秒后 Lody 把它作为 `failed` 发出并发送 `session/cancel`。agent README 中描述的
  `realpath` `cwd` 协商消除了最常见的触发原因：符号链接工作目录下的工作区内编辑。

## 已否决方案

- **保持 `session/prompt` 挂起直到后台工作完成。** 最初实现最多挂起 30 分钟，再移交给
  第二个监视器。这会锁住输入栏，还需要第二套状态机，而原生工作契约已经让它变得不必要。
- **按 agy 工具参数计数**（`DurationSeconds`、`CronExpression`、`MaxIterations`、swarm
  `tasks`/`n`、`manage_*` kill）。agy 一改参数计数就会出错；工具状态加安静窗口
  不需要了解这些参数。
- **`end_turn` 后发送合成 prompt 或 steer。** 根 `AGENTS.md` 禁止引导 agent 的文本，
  而且会污染会话。
- **在 `SessionGCManager` 或 `MessageHandler` 中特判 Antigravity。** 这些消费者保持与
  提供方无关。

## 验证

`apps/cli/src/agent/antigravity-background.test.ts` 用真实 `AgentClient` 对接模拟的 agy
会话记录，固定以下行为：turn 在 `end_turn` 结束、`background` → `running` → 空闲的状态
轨迹、无重复回放（含 resume 历史与分段回复）、`updatedAt` 冻结时的补加载、定时器与子代理
等待、守护进程排除、配置切换时暂停、孤立权限请求恢复与 `realpath` 协商。本次重写尚未在
真实 `agy acp` 上重新运行。

## 局限

- 输出有轮询延迟：约 2 秒，没有 `session/list` 时约 10 秒。
- 静默时间超过派发安静窗口的工作会失去保护；如果它在监视器停止后才唤醒模型，
  这部分输出不会被回放。
- 每次加载都会回放整个会话记录，开销随会话长度增长。agy 是否在每次 `session/load`
  时重新挂载 MCP 服务器，尚未在真机上测量。
- 针对孤立权限请求的 `session/cancel` 也会取消该次唤醒中正在进行的其他工作。
