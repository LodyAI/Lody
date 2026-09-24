# 在 Session 命令中保留可重试的机器访问失败

Status: implemented
Translation: current
PR: not created

[English](2026-09-08-session-access-retry-diagnostics.md)

## 摘要

控制面短暂网络失败会在联系目标机器或启动 Agent 之前中断 Session 创建；MCP 边界还会把它
报告成永久的命令或输入拒绝，并隐藏底层网络原因。现在命令侧访问校验会在有界时间内重试
传输失败，耗尽后以可重试错误返回并保留嵌套原因。鉴权仍然 fail-closed，明确拒绝仍立即停止。

## 决定与范围

- 访问查询是幂等的，因此命令校验只对传输类失败按 250 毫秒、1 秒、2 秒重试。schema、
  身份及其他非传输错误不重试。
- daemon 已派发消息的重试循环保持独立、可中断且无上限，因为它保护的是已经持久化的用户消息。
  命令校验位于工作被接受或派发之前，所以重试必须有上限。
- MCP 单项和批量 create/chat 路径把耗尽的传输失败报告为
  `MACHINE_ACCESS_UNAVAILABLE` 和 `retryable: true`。机器访问失败不再归类为
  `COMMAND_REJECTED` 或 `INVALID_ITEM`。
- 诊断会遍历嵌套的 `cause` 和 `AggregateError.errors`，保留常见网络错误码和消息；
  不包含凭证，也不改变访问请求内容。
- presence 仍是独立信号；任何在线心跳都不能绕过或替代访问校验。

## 证据与限制

确定性测试通过注入延迟函数，覆盖重试后恢复、非传输错误立即失败，以及耗尽重试后保留嵌套
`ECONNRESET` 诊断。CLI 类型检查、lint、格式化和更广检查会记录在变更交接中。
这些证据不代表已在发布版桌面端完成恢复验收，也不能确定受影响用户原始的代理、DNS 或 TLS 原因。

见[行为契约草稿](../../../../specs/session-access-verification.zh.md)。
