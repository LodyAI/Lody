# 将内置 MCP credential 保留在执行 Machine

Status: implemented
Translation: current

[English](2026-09-09-builtin-workspace-mcp-connectors.md)

## 摘要

Workspace MCP 过去要求用户手动填写 provider transport 和 credential，而共享 catalog 不适合
保存个人 OAuth token 或带 secret 的 URL。Lody 现在为 Linear、Notion、Cloudflare、PostHog
和飞书提供经过审核的预设，同时将每份授权加密保存在实际运行 Agent 的 Machine。这样既无需
backend credential service，也保留了协作 catalog；代价是每台 Machine 都要单独授权，并且
远程浏览器 callback relay 仍不在范围内。

## 决策

Workspace 共享的是能力标识，不是 provider 身份。内置 catalog entry 只保存 provider、preset
version、access profile、有限的 public option 和展示信息。每个用户/Machine 组合为该 entry
持有独立 credential binding。

目标 CLI 负责 OAuth discovery、浏览器 callback、token refresh、连接测试和加密存储。设置页
只通过同一台 Machine 的 RPC 访问这些操作。Session 启动时把有效 binding 转成临时 HTTP MCP
配置，并且只向 Agent 进程提供 access token。

Provider 范围固定为 Linear、Notion、Cloudflare、PostHog 和飞书。Canva 与 Slack 已从首版
需求中移除。Linear 和 PostHog 默认只读；Notion 与 Cloudflare 由 provider 授权页选择权限；
飞书在提供等价标准 OAuth client 流程之前使用官方个人 URL 配置。

## 安全与生命周期边界

Provider credential 不会进入 Workspace Flock、可选云存储、analytics、chat 或普通日志，
也不需要 Convex。内置 registry 固定 OAuth 目标、issuer 和 resource；PostHog 只读授权会过滤
metadata 中的写 scope，而不是只依赖 transport query。

Authorization fingerprint 避免 credential 跟随已经更换 provider 或策略的 catalog entry。
File lock、按 entry 串行化、generation、credential-id compare-and-delete、合并 refresh 和可
abort 测试共同保证 disconnect、remove、callback、refresh 与 shutdown 竞态最终以删除为准。

## 备选方案

没有把 token 保存到 Workspace catalog，因为任何能读取该文档的成员都可能获得个人 provider
credential。首版没有采用 backend token service，因为本地执行不需要跨 Machine 同步，而服务
会引入新的高价值多租户 secret 边界。

没有把 OAuth 委托给各 ACP Agent，因为不同 Agent 的登录与 refresh 行为并不一致，连接器可用性
会依赖当前选择的 Agent。远程 callback relay 也被延后：它需要单独审查的端到端保护交接；首版
桌面行为使用同一台 Machine 的 loopback 已足够。

## 证据与验证

产品意图记录在 draft
[`specs/builtin-workspace-mcp-connectors.md`](../../../../specs/builtin-workspace-mcp-connectors.md)，
跨模块流程记录在
[`builtin-workspace-mcp-connectors.md`](../../../docs/builtin-workspace-mcp-connectors.md)。实现和
确定性的安全/竞态测试覆盖 shared schema、settings component、CLI authorization service、
credential store 与 session resolver。当前仓库迁移已通过 `pnpm format`、`pnpm check`、
`pnpm run docs check` 和 38 项 connector 定向测试；此前实现也通过了对抗式安全/正确性审查。
真实 provider 账号授权仍未验证。
