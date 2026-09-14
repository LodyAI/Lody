# Session 机器访问校验

Status: draft
Translation: current

[English](session-access-verification.md)

创建 Session 或发送消息时，Lody 可能需要通过控制面校验请求者是否能使用目标机器。
明确允许时继续，明确拒绝时立即停止。传输失败不等于拒绝：命令校验会在短暂且有上限的
时间内重试；仍失败时返回可重试的 `MACHINE_ACCESS_UNAVAILABLE`，并且不创建或派发工作。

机器 presence 和访问校验回答的是两个不同问题。Loro Streams 中的新鲜心跳只表示该机器
最近能通过 presence 通道连接；它不能证明控制面的访问校验接口可达。界面和 Agent
不能把 `online` 标签当作访问校验成功的证据。

重试耗尽后，如果运行时提供了底层传输原因和错误码，诊断信息必须保留它们，例如
`ECONNRESET`、`ENOTFOUND` 或 `ETIMEDOUT`。可重试错误仍然保持 fail-closed：调用方可以重试
同一个命令，但 CLI 不能在鉴权服务不可用时视为已获得权限。

## Workspace 读取与 Operation 接受

Cloud 命令可能先用 CLI 凭证枚举 workspace，即使目标就在同机。该读取只重试暂时传输故障，
最多四次、单次上限五秒、总上限十秒。耗尽后返回 `WORKSPACE_ACCESS_UNAVAILABLE`；明确凭证
拒绝返回 `WORKSPACE_ACCESS_DENIED`。响应无效或未配置返回不可重试的 `WORKSPACE_RESOLUTION_FAILED`。
取消会中止尚未完成的 workspace fetch。这些失败都不会授予权限或延长缓存授权；workspace 不在
授权列表和机器权限拒绝仍然拒绝访问。本次不改变 OSS local-only 组合，也不新增 cloud desktop 离线契约。

对单项 MCP `session_chat`，本地 Operation store 的接受是持久化边界。接受前读取失败不创建
新工作；接受后物化失败返回已存的 active Operation，由现有协调器恢复，不把发送判为拒绝。
可能已接受但回执不可读时返回 `OPERATION_RESULT_UNAVAILABLE`：查询原 Operation ID，不分配
新 ID 补偿。同 ID chat 重放仍要求命令、请求者和源 Turn 一致。尽力同步不能倒置持久成功。
取消请求不会撤销已经接受的 Operation。

manager 在不支持取消的旧调用结束后才释放，包括获取期间取消的情况。这不是整个命令的超时。
失败诊断记录 stage、接受状态、Operation ID、安全 endpoint 标签以及有界白名单 cause code/status，
不记录 prompt、凭证、原始错误消息或敏感 URL。

## 证据

有界命令重试和诊断实现在 `apps/cli/src/session/session-access-retry.ts`。命令访问校验通过
`apps/cli/src/commands/session.ts` 进入该逻辑；MCP 单项和批量结果通过
`apps/cli/src/mcp/machine-access-error.ts` 保留可重试属性。确定性测试位于
`apps/cli/tests/session-access-retry.test.ts` 和
`apps/cli/src/mcp/machine-access-error.test.ts`。

本草稿记录本次要求的行为；测试不代表已完成发布端恢复验收。

Workspace Effect 边界位于 `apps/cli/src/lib/workspace.ts` 和 `command-runtime.ts`；单项 chat 编排
位于 `apps/cli/src/mcp/lody-mcp-server.ts`。确定性测试位于 `apps/cli/src/lib/workspace.test.ts` 和
`apps/cli/src/mcp/session-chat-network-boundary.test.ts`；后者使用合成目标 sink，不是完整目标 daemon。
