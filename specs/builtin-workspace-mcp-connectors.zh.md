# 内置 Workspace MCP 连接器

Status: draft
Translation: current

[English](builtin-workspace-mcp-connectors.md)

Lody 的 Workspace 设置为 Linear、Notion、Cloudflare、PostHog 和飞书提供经过审核的连接器
预设。用户无需了解 transport URL 或 header 即可添加预设，然后在实际运行 Agent 的 Machine
上授权提供商。现有自定义 Workspace MCP Server 能力保持不变。

## Workspace 与 Machine 的职责

内置连接器刻意区分两种状态：

- Workspace catalog 只保存公开的预设标识、版本、访问模式和展示信息，不保存
  `connection`；
- 每个用户需要在每台目标 Machine 上分别授权该 catalog entry。

Provider credential 永远不是 Workspace 数据。OAuth access/refresh token、动态 client
信息、discovery state 以及飞书个人 MCP URL 都保存在按用户、Workspace 和 catalog entry
隔离的 Machine 本地加密存储中。Authorization code 与 PKCE verifier 仅存在于当前进程。
Catalog 和任何可选云服务（包括 Convex）都不会存储或中转这些值。

设置页只通过同一台 Machine 的 RPC 管理 credential。目标 Machine 远程、离线或不支持该
能力时，Lody 保留公开 catalog entry，并提示用户在目标 Machine 上打开设置；不会回退为云端
credential 通道。

## Provider 行为

Linear、Notion、Cloudflare 和 PostHog 使用浏览器 MCP OAuth。Lody 执行 protected resource
与 authorization server discovery、Authorization Code + PKCE S256，并在需要时执行动态
client 注册。OAuth 目标与 metadata 受内置 provider registry 限制；redirect response、resource
或 issuer 不匹配都会 fail closed。

Linear 默认使用只读 MCP endpoint。Notion 与 Cloudflare 的权限由 provider 授权页选择，
Cloudflare 保持默认 Code Mode。PostHog 默认使用 `mode=cli&readonly=true`；OAuth resource
不包含 transport query，只读流程只请求身份 scope 与 `*:read` scope。

飞书个人接入返回专属 MCP URL，不是标准 client OAuth 流程，因此采用引导式配置。Lody 打开
官方配置页，只接受 allowlist 中飞书/Lark 域名的 HTTPS URL，将完整 URL 作为 Machine 本地
secret 保存，绝不写入 catalog。

## Session 行为

添加连接器不会自动为所有 turn 启用它。选择仍使用现有 `mcpServerIds` turn 配置，并保留显式
空数组。ACP session 启动前，目标 CLI 从本地 credential store 解析已选择的内置 entry，并在
可能时刷新即将过期的 OAuth token。只有 access token 会进入提供给 Agent 的内存 HTTP MCP
配置；refresh token 永远不会交给 Agent。

没有匹配本地 credential 的 entry 解析为 `auth_required`，并从 Agent MCP server 列表中省略。
Provider、preset version、access profile、endpoint、OAuth resource、public option 或 issuer
变化时，已有授权失效并要求重新授权。授权只影响之后启动的 session；运行中的 Agent 不会
热加载连接器。

## 生命周期与恢复

用户可以在目标 Machine 上查看状态、重试授权、测试或断开连接。断开、OAuth callback、
refresh、连接测试、服务关闭和 catalog orphan cleanup 使用串行化或 generation 校验，避免晚到
操作恢复已删除 credential。从 Workspace 移除内置 entry 时，Lody 会尝试断开当前选中
Machine；其他 Machine 在下次读取 catalog 时删除自己的 orphan binding。

Provider 或网络失败不会删除公开 catalog entry，用户可从同一卡片重试。其他 provider、
stdio、共享 API key 和显式管理的 HTTP header 继续使用手动自定义 MCP 配置。

## 首版限制

首版不在 Machine 间同步 credential，不通过 Lody 代理 provider 流量，不提供 service-account
授权，也不包含 Canva 和 Slack。设置页暂不开放 Linear/PostHog 的潜在读写模式。每个 provider
的真实账号浏览器授权仍属于发布验证；仓库内的确定性 fixture 覆盖协议和安全边界。

## 证据

Provider 定义和公开 preset 校验位于 `packages/shared/src/builtin-mcp-providers.ts` 与
`packages/shared/src/workspace-mcp.ts`。Machine 本地授权位于
`apps/cli/src/mcp/workspace-mcp-auth-service.ts` 和
`apps/cli/src/mcp/workspace-mcp-credential-store.ts`。设置 UI 位于
`packages/components/src/components/settings/builtin-mcp-connector-grid.tsx` 和
`packages/components/src/components/settings/mcp-setting.tsx`；session 解析位于
`apps/cli/src/agent/session-mcp-resolver.ts`。
