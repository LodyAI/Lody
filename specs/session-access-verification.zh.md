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
同一个命令，但除下文的缓存放行外，CLI 不能在鉴权服务不可用时视为已获得权限。

目标机器派发消息时，可以直接使用本地缓存的已确认放行结果，而不必等待控制面。机器 owner 的
缓存放行不过期。workspace 成员的放行按请求者和本地项目缓存，自控制面最后一次确认起一小时内
有效，并且只对完成校验的那个登录账号和机器有效；CLI 账号或机器变化时会丢弃全部成员放行。每次走缓存的派发仍会在后台校验：确认放行会刷新该条目，明确拒绝会清除它。因此控制面可达
时，撤销在下一次派发生效；不可达时，最迟一小时生效。传输失败永远不会新建或延长缓存放行。

## 证据

有界命令重试和诊断实现在 `apps/cli/src/session/session-access-retry.ts`。命令访问校验通过
`apps/cli/src/commands/session.ts` 进入该逻辑；MCP 单项和批量结果通过
`apps/cli/src/mcp/machine-access-error.ts` 保留可重试属性。确定性测试位于
`apps/cli/tests/session-access-retry.test.ts` 和
`apps/cli/src/mcp/machine-access-error.test.ts`。派发缓存的判定位于
`apps/cli/src/session/session-access-policy.ts`，存储位于
`apps/cli/src/lib/local-workspace-catalog.ts`；`apps/cli/tests/session-access-policy.test.ts` 和
`apps/cli/tests/session-dispatch-watcher.test.ts` 覆盖过期、按项目区分、撤销以及离线成员派发。

本草稿记录本次要求的行为；测试不代表已完成发布端恢复验收。
