# Role Prompt 前缀不进入可见的用户回合

Status: implemented
Translation: current

[English](2026-10-21-role-prompt-prefix-hidden-from-turn.md)

## 摘要

通过 Lody MCP 或 `lody session create --agent-role` 以 Agent Role 创建的会话，
首条用户气泡和派生标题中会显示 Role 的 Prompt 前缀，因为两个解析器在构建可见
回合前就已拼接 `prefix + prompt`。现在 Role 解析只返回作者编写的 prompt；去除
首尾空白后的前缀经 `CreateOptions.agentRolePromptPrefix` 单独传递，只拼入回合的
执行 prompt（`inputConfig.prompt`），与桌面端输入框一致。MCP 规范命令将前缀记为
独立字段，接受时仍会冻结，供重试与恢复使用。此前已创建的回合在历史中仍保留前缀。

## 决策与依据

根因：`resolveAgentRoleCreate` 与 `resolveMcpSessionCreate` 返回
`composeAgentRolePrompt(role.promptPrefix, prompt)`，`prepareSessionInput` 再用该文本
构建可见条目。[共享契约](../../../../packages/shared/AGENTS.md)允许执行文本与可见
条目不同，桌面端路径本就保持可见条目为原文。

前缀在 `bindAgentRoleCreateOptions` 中绑定，CLI、MCP 单个创建与 MCP 批量物化都会
调用它，因此一处即可覆盖所有路径。`buildResolvedMcpCreateCanonicalCommand` 增加
`agentRolePromptPrefix`，遵守[接受时冻结规则](../../../../apps/cli/src/mcp/AGENTS.md)
并纳入指纹。`message-handler.ts` 中的守护进程恢复在字段存在时还原它；更早接受的
Operation 存储的是拼接后的 `prompt` 且无该字段，按原样重放。

已否决的方案：拼接后再从可见文本中剥离已知前缀。它依赖字符串匹配，Role 一经
编辑即失效。

## 验证

回退创建测试现断言持久化回合显示 `Continue`，而 `inputConfig.prompt` 为
`Review carefully.\n\nContinue`；解析器测试断言原始 prompt、绑定的前缀、CLI/MCP
一致性以及规范命令字段。Role、MCP、会话命令与 message-handler 测试全部通过
（474 个）。类型检查除未初始化的可选扩展子模块外无错误。

限制：未做桌面端在线端到端运行；若新版 MCP 服务端的 Operation 由旧版守护进程
恢复，前缀会丢失（两者通常随同一二进制发布）；既有历史不做改写。

相关：[CLI Role 创建](../feature/2026-10-07-cli-session-create-agent-role.zh.md)。
