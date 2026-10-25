# 会导致失败的同步确认至少等待 30 秒

Status: implemented
Translation: current

[English](2026-10-21-sync-confirmation-timeout-floor.md)

## 摘要

CLI 有多条路径在 Loro 同步确认没有在 1.5 到 20 秒内完成时直接让操作失败，并提示调用方重试。
同步慢但健康时，每次重试都会以同样的方式失败。现在，超时会导致操作失败的同步确认至少等待
`SYNC_CONFIRMATION_TIMEOUT_MS`（30 秒）；超时后继续执行的等待保持原来的短预算，
因为它们位于 turn 收尾等对延迟敏感的路径上。代价是同步确实不可用时失败得更慢，
并且当客户端工具超时短于 MCP 调用的同步预算总和时，调用可能先在客户端超时。

## 决定

规则按超时后的失败语义划分，而不是按调用了哪个辅助函数：

| 等待 | 之前 | 现在 | 超时结果 |
| --- | --- | --- | --- |
| `syncMetaOrThrow`（`LODY_LORO_SYNC_META_TIMEOUT_MS`） | 20s | 30s | 报错 |
| `syncDocOrThrow` / `syncRemoteDocOrThrow`（`LODY_LORO_SYNC_DOC_TIMEOUT_MS`） | 8s | 30s | 报错 |
| Machine Flock 同步及其协调器（`LODY_LORO_SYNC_MACHINE_FLOCK_TIMEOUT_MS`） | 8s | 30s | 可重试的 `SYNC_UNAVAILABLE` / 退避重试 |
| `ensureWorkspaceMetaSynced`、owner 历史写入前的 meta 等待 | 4s | 30s | 提示“重试命令” |
| Agent Role 与 Schedule 提案确认 | 4s | 30s | 提示“用 requestId 重试” |
| 替换外部历史后的确认 | 4s | 30s | 报错 |
| 本地项目根路径解析（4 次读取之间 3 次同步） | 约 5.7s | 约 31s | Session 初始化失败 |
| 回退恢复时等待可重放历史 | 15s | 30s | 本轮以 `session_restore_failed` 失败 |

刻意不改的部分：

- 超时后继续执行的尽力等待：turn 收尾中默认 4s 的 `waitUntilSynced` / `waitUntilMetaSynced`、
  创建后的派发确认、8s 的会话文档首次同步、会话启动时 5s 的 MCP catalog 刷新、
  以及注册前 1.5s 的本地项目查找。调大它们只会推迟 idle 状态或会话启动。
  `confirmDispatchSyncedBestEffort` 现在直接调用尽力型 meta 等待，创建路径不会继承 30s 预算。
- 重连后的 meta 恢复等待和一次性 attach 等待保持 20s：前者在占用串行恢复队列时只记日志，
  后者超时后以降级模式继续。
- 串行后台循环显式使用 8s：Coordinator 补建前的目标追平，以及 Schedule 定义读取。
  这两个循环逐项处理，一个卡住的 room 会让每轮中所有无关的 Operation 或 Schedule 多等最多 30s。
  它们的超时只是不确定性，由各自的重试负责收敛，被放弃的 `repo.sync` 仍在后台继续。
- 嵌套预算：10s 的 Session 历史元数据等待运行在 30s 的客户端 RPC 之内，
  Machine RPC 默认值（2 到 15s）是经过 Streams 的请求截止时间。单独调大任一侧，
  只会把失败挪到外层截止时间。
- `LODY_LORO_RECONNECT_TIMEOUT_MS`（10s）约束串行的重连 fiber 和每个 room 的 rejoin，
  由 30s 的 watchdog 重试。
- presence、teardown、进程退出和渲染端超时不属于同步确认。

## 限制

单个 MCP 创建在 accept 之前要经过 workspace meta 和 Machine Flock 两段同步，各自最多约 30s
（之前合计约 28s），同步降级时总和会达到 60s 的客户端工具超时。客户端放弃后 daemon 仍会继续；
[换 id 重试采纳](2026-10-21-mcp-create-fresh-id-retry.zh.md)保证相同的重试不会造成重复 Session，
但在把 Lody MCP 的客户端超时调到高于服务端预算之前，调用方仍会看到误报的失败。

## 验证

- `local-project-meta.test.ts` 使用假定时器，证明同步卡住时 30s 之前不会判定项目缺失。
- 没有测试用卡住的真实 room 驱动这两个串行循环；它们的显式预算只经过类型检查和代码审查。
- `command-runtime.test.ts` 与 `lody-mcp-server.test.ts` 中的断言覆盖传给会失败的 meta 确认的 30s 预算。
