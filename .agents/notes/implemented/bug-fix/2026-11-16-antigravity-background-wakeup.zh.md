# Antigravity ACP v1 后台任务唤醒与 GC 保护

Status: implemented
Translation: current

[English](2026-11-16-antigravity-background-wakeup.md)

## 摘要

`agy acp`（`Antigravity ACP Server`，ACP v1）在模型暂时让出控制权、但仍有后台工具（`run_command`、`invoke_subagent`、`run_workflow`、`schedule`、`swarm`）运行时，会立刻以 `stopReason: "end_turn"` 结束 `session/prompt`，并在之后停止向 stdout 推送 `session/update`。Lody 现在在 `apps/cli/src/agent/` 内追踪这些 turn 结束后的后台任务：按需保持活跃 turn 等待唤醒，或通过 `onNativeWorkChanged` 上报 Core `sessionActivity`（`background` / `running`），并借助只读 `session/list` 轮询与静默 `session/load` 快照增量提取后续输出，全程不注入任何合成 prompt。

## 问题

在真实 `agy acp` 会话中，多个内置 Antigravity 工具会在后台工作完成前先结束当前模型 turn：

- 任何在 `end_turn` 时仍处于 `pending` / `in_progress` 的非 daemon 工具，以及输出包含 `"Tool is running as a background task with task id: ..."` 的 `run_command` / `run_workflow`（或无输出且未传/`WaitMsBeforeAsync` 为 `0` 的 `run_workflow`）；
- `invoke_subagent` 与 `send_message`（在投递确认后即完成工具调用，但不会推送子 agent 的 ACP 事件）；
- 非 daemon 的 `schedule` 定时器/cron 与 `swarm` 协作组。

由于 `agy acp` 在 `end_turn` 时立即 resolve `session/prompt` 并停止向 stdout 推送后续唤醒内容，Lody 会误判会话为 `idle`、丢失全部 turn 后工具结果与唤醒文本，并在 20 分钟空闲阈值后由 `SessionGCManager` 杀掉仍在运行后台任务或唤醒推理的 `agy` 进程。

## 协议背景

- **ACP v1 与 v2**：`agy acp` 协商的是 `protocolVersion: 1`，未广告 `_lody/session/activity_update`（`sessionActivity` 扩展）。ACP v2 草案标准化了 `session/list` 与 `session/load` 等会话生命周期能力（`agy acp` 已在 ACP v1 `sessionCapabilities` 中提供），但协议本身并未定义 `session/prompt` 结束后由服务端主动推送唤醒状态的通用信号。一旦 `session/prompt` 返回 `end_turn`，`agy acp` 会停止通过 stdout 推送 `session/update` 与 `session/request_permission`，并按 `path.relative(cwd, realpath(target))` 校验编辑路径是否落在工作区内。
- **Lody 原生活动契约**：[Session GC 尊重原生 Agent 的工作](2026-10-18-gc-respects-native-agent-work.zh.md) 已建立 `sessionActivity` 模型（`running` 表示模型正在自主运行或等待审批，`background` 表示等待已启动的后台任务且最多保护 24 小时，其余为 `idle` / `null`）。在 `AgentClient` 内为 `Antigravity ACP Server` 合成该状态可直接复用 `SessionGCManager` 与 `Session` 在线状态，无需改动上层服务。
- **统一身份识别**：指向 `agy acp` 的自定义配置在 `initialize` 中返回 `agentInfo.name === "Antigravity ACP Server"`，而内置配置带有 `cliType === "builtin"`，旧版 `antigravity-acp` 则二者皆无。通过 `isAntigravityServer()` 统一识别可让自定义 `Antigravity ACP Server` 获得完整兼容，同时完全不触及旧版服务。

## 决策

将全部兼容逻辑收口在 `apps/cli/src/agent/`（`antigravity-background.ts` 与 `agent-client.ts`），保持 `MessageHandler`、`SessionGCManager`、`SessionActivePresence` 与 `SessionExecutionService` 不变：

1. **基于 `session/list` + 静默 `session/load` 的只读增量恢复**：
   - 以 2 秒间隔（带单次 RPC 超时与中断竞速）轮询 `connection.listSessions`，在目标会话 `updatedAt` 变化时触发静默 `session/load`；同时在活跃的 `wakeupPlannerGraceMs` 窗口内每 6 秒（`sameSecondLoadCheckMs`）复查一次并在收敛前补做一次预校验（已主动取消孤儿 `pending` 工具时跳过），避免 `agy` 以步骤启动秒 `created_at` 作为 `updatedAt` 时漏掉同秒完成的长耗时回复，并在长时闲置等待期间停止无意义的快照读取；若服务端返回 `-32601` 不支持 `session/list`，则退回 10 秒间隔的 `session/load` 轮询。
   - 在后台 `antigravityLoadCapture` 期间屏蔽原始回放转发，并在会话 resume 启动回放（`antigravityStartupCapture` + `seedBaseline`）及 prepared replacement 切换时预置基线，确保历史 turn 永不重复回放或误触发 hold。
   - `AntigravitySessionTracker.consumeSnapshot()` 按 `toolCallId` 与 `status`/输出/后台占位文本清除变化对工具状态去重，按已流式推送字符偏移截取新增 assistant/thinking 文本（仅在真实 turn/唤醒边界、前序以非换行文本结尾且期间未插入工具调用时补 `\n\n` 段落分隔，不在同一条消息的连续分段 chunk 之间插入空行），并对未变化的 `usage_update` 去重。

2. **两级生命周期策略与卡死解锁保障**：
   - **规范工作区 `cwd` 归一化**：在发起 `session/new`、`session/load`、`session/resume`、`unstable_forkSession` 与轮询 RPC 前，`AgentClient` 先用 `fs.realpath` 解析 `workdir`（路径不存在时回退原值，同时保持 `LODY_MCP_WORKDIR` 与客户端 `resolvePath` 不变），避免 macOS `/tmp`、`/var/folders` 等符号链接目录触发 `agy acp` 误报越界编辑审批。
   - **Tier 1（最长 30 分钟 turn hold）**：当 `end_turn` 离开时仍有除 `schedule`/`swarm` 以外任意进行中的非 daemon 工具（`pending` / `in_progress`）、带后台 task 占位文本的工具、无输出立即异步的 `run_workflow`，或未被 `manage_subagents` 取消的 `invoke_subagent` / `send_message` 时，`AgentClient.prompt()` 保持挂起并持续增量转发唤醒输出，直至所有可等待任务完成并经过 25 秒静默收敛窗口（`settleQuietMs` / `failedWakeupToolGraceMs`），或用户触发 Stop `abortSignal` 立即中断并发送 `session/cancel`。当多个子代理被合并进同一次唤醒（或同轮还留有 `schedule`/`swarm`），首次唤醒收敛后会自动让渡至 Tier 2，避免把输入栏锁死 30 分钟。
   - **Tier 2（最长 24 小时后台守护监控）**：非 daemon 的 `schedule`/`swarm`（即便 `agy acp` 在触发前一直维持其为 `in_progress` 也不阻塞 `prompt()`；按 `tasks`/`n` 统计多 worker 并排除 `IsDaemon: true` 与 `manage_task` `kill`）、合并唤醒剩余的子代理等待，以及超过 30 分钟仍未结束的 hold 会正常结束 `prompt()` 并转入脱离轮询，通过 `onNativeWorkChanged('background' | 'running' | null)` 防止 GC 误杀同时保留前端可打断性。
   - **Turn 后孤儿 `pending` 权限卡死恢复**：由于 `agy acp` 在 `end_turn` 后不再转发 `session/request_permission`，任何在 `end_turn` 后进入 `status: "pending"` 且未收到 `requestPermission` 调用（`notifyLivePermissionRequest`）的工具会在 `orphanedPendingToolGraceMs`（4 秒）后在 Tier 1 与 Tier 2 中统一过期：`AgentClient` 合成失败的 `tool_call_update`（`ORPHANED_POST_TURN_PERMISSION_MESSAGE`）并发送 `session/cancel` 解锁卡死会话，避免触发 30 分钟或 24 小时超时挂起。
   - 新用户 `prompt`、`cancel`、`closeDetachedSession`、`setSessionConfigOption`/`setSessionMode`/`unstable_setSessionModel`、replacement 切换与连接断开均会先干净收敛脱离监控。

## 已否决方案

- **在 `end_turn` 后发送合成 prompt 或 steer 探测**：违反 `AGENTS.md` 对合成指令的禁令，且会污染会话历史并干扰模型决策，已否决。
- **对定时器、cron 与 swarm 永久阻塞 `session/prompt()`**：会长时间锁定输入栏，阻塞用户发送新消息；Tier 2 借助 `sessionActivity` 既能保护进程不被 GC，又不影响用户交互。
- **在 `SessionGCManager` 或 `MessageHandler` 中硬编码 Antigravity 特判**：破坏 Core 扩展与消费端的中立边界，已否决。

## 局限

- 仅当 `agy acp` 将变更落盘到可查询会话快照时才能观察到增量，因此 `end_turn` 后的输出存在轮询粒度延迟（支持 `session/list` 时约 2 秒，降级时约 10 秒），无法达到 stdout 实时流的零延迟。
- 轮询在连续 5 次 RPC 失败（`maxConsecutiveFailures`）、满 24 小时（`detachedMaxDurationMs`）或连接中断/中止信号后会有限退出，防止死进程或异常 RPC 导致后台循环泄漏。
- `IsDaemon: true` 的长驻命令与守护 cron 仍被刻意排除，避免开发服务器等常驻进程无限期阻止空闲 GC。
