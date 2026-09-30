# 在 Lody 会话中托管 MCP Apps

Status: proposed
Translation: current

[English](2026-09-30-mcp-apps-host.md)

## 摘要

Codex 会把声明了 MCP Apps 界面（SEP-1865）的工具调用渲染成可交互的内嵌视图，而 Lody
只显示 "Ran mcp.…"。本提案让 MCP 连接留在 Agent 内：历史只保存一个小描述符，桌面端
通过 Machine RPC 按需向在线 Agent 获取应用的 HTML、工具输入与工具结果，并在沙箱
iframe 中展示。应用只能读取来源服务器的资源、调用其中对应用可见的工具。主要取舍是
视图依赖正在运行的 Agent：之后在没有 Agent 的情况下查看历史，应用显示为不可用。

## 决定

- **协商。** 只有真实会话客户端声明 `clientCapabilities._meta.lody.mcpApps`；能力探测
  与历史目录客户端从不渲染工具调用。适配器只在协商后发出 `tool_call._meta.lody.mcpApp`，
  Lody 只在 Agent 声明 `agentCapabilities._meta.lody.mcpApps` 时使用 `_lody/mcp_apps/*`。
- **延迟存储。** `history-apply` 保存 `toolCall.mcpApp = {server, tool, resourceUri,
  appName?, preferredDisplayMode?}`（字符串不超过 2048 个字符，`resourceUri` 必须是
  `ui://`）。无效描述符被忽略；未知显示模式或过长应用名只丢弃该字段；不带该 meta 的
  更新保留已存描述符。字段可选，旧文档依然有效，旧读取方会忽略它；HTML、输入和结果
  从不进入 CRDT。
- **传输。** 单个 Machine RPC `session/mcp-app` 携带带判别字段的请求（`load`、
  `resource_read`、`tool_call`）和查看者的 `userId`。守护进程先校验机器访问权限，再用
  Agent 自己的会话 id 转发。失败均有类型：`MCP_APP_UNAVAILABLE`、
  `MCP_APP_ACCESS_DENIED`、`MCP_APP_AGENT_ERROR`、`MCP_APP_RESPONSE_TOO_LARGE`
  （8 MiB）。它走共享通道而非控制通道，因为应用的工具调用耗时没有上限。
- **不启动 Agent。** 目标控制在没有 Agent 时会启动 Lody 拥有的回合；MCP Apps 不能这样
  做，否则打开历史就会拉起 Agent 进程。没有在线 Agent 时请求返回 `MCP_APP_UNAVAILABLE`。
- **作用域。** 每个请求都指明来源 `toolCallId`。适配器把资源读取和工具调用固定到该次
  调用的服务器，并拒绝 `_meta.ui.visibility` 不含 `"app"` 的工具。
- **沙箱。** 渲染端用不带 `allow-same-origin`、preload 或凭据的 frame 承载视图，CSP
  由资源的 `_meta.ui.csp` 生成，缺省时默认拒绝。OSS 桌面端不发起产品云请求。

## 考虑过的方案

- 把 HTML 与工具结果写入历史可以离线查看，但会把大体积、可能敏感的数据放进同步的 CRDT。
- 像 `file/preview` 那样用 owner-session 内容信封加密结果被推迟：steer 与 goal 的载荷
  在该传输上本就是明文。

## 限制

尚未端到端验证。视图要求运行过该工具的 Agent 仍持有它（Codex 适配器在重启后回退到
`thread/read`）。远程机器流量经 Loro Streams 以明文传输；若应用结果变得敏感需重新评估。
