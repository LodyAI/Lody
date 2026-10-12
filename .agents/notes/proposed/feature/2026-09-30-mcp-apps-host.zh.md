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
  （序列化 JSON 上限为 16 MiB 减 64 KiB：真实应用的 HTML 转义前为 7,091,831 字节，
  上限受守护进程 16 MiB 本地 IPC 响应上限约束）。它走共享通道而非控制通道，因为应用的
  工具调用耗时没有上限。
- **不启动 Agent。** 目标控制在没有 Agent 时会启动 Lody 拥有的回合；MCP Apps 不能这样
  做，否则打开历史就会拉起 Agent 进程。没有在线 Agent 时请求返回 `MCP_APP_UNAVAILABLE`。
- **作用域。** 每个请求都指明来源 `toolCallId`。适配器把资源读取和工具调用固定到该次
  调用的服务器，并拒绝 `_meta.ui.visibility` 不含 `"app"` 的工具。Codex 以
  `<connector>.<tool>` 列出并调用 `codex_apps` 工具，而应用 HTML 使用裸名称。
  `codex_apps` 在一个服务器上聚合多个连接器，因此应用给出的名称总在来源工具的连接器
  前缀内解析，并以带命名空间的名称转发；其他连接器的工具即使给出精确名称也会被拒绝。
- **沙箱。** 渲染端用 `credentialless`、`sandbox="allow-scripts"`（opaque origin）且无
  preload 的 frame 承载视图，CSP 由资源的 `_meta.ui.csp` 生成，缺省时默认拒绝。`connectDomains` 接受 `https://` 与
  `wss://` 来源，其余指令只接受 `https://`；明文 `http://` 与 `ws://` 一律丢弃。OSS 桌面端
  不发起产品云请求。
- **视图沙箱。** 代理在写入应用文档前安装内存版 `localStorage`、`sessionStorage` 与
  `document.cookie`，使用它们的视图不会报 `SecurityError`，数据也不会落盘。不支持
  `_meta.ui.domain`：Lody 没有公网沙箱域名。
- **沙箱代理 scheme。** `srcdoc`、`blob:`、`data:` frame 会继承渲染端的 meta CSP，而它不含
  `'unsafe-inline'`；已在 Electron 39.5.1 与 Chromium 153 验证，应用的内联脚本无法运行。
  因此 frame 加载固定代理页 `lody-mcp-app://sandbox/`，其响应 CSP 是上限（`https:`，
  `connect-src` 另含 `wss:`）。
  渲染端在收到 `sandbox-proxy-ready`（SEP-1865 代理握手）后投递应用 HTML，代理替换自身
  文档；每个应用的策略作为 `<head>` 首个节点注入。渲染端 `frame-src` 在原有来源之外只
  放行该 scheme，因此 frame 无法跳转到任意 https 页面。
- **展示。** 已完成的调用显示 "Opened {app}" 并内联 frame；全屏把同一 frame 移入对话框
  （`moveBefore`，否则重新加载并重新握手）。失败的调用保留普通工具行；没有宿主、只读
  查看者或加载失败时显示应用不可用。
- **宿主上下文。** 官方 SDK 用自身 schema 校验 `ui/initialize` 与每条
  `host-context-changed`，不匹配即断开连接。尺寸始终同时带宽度与高度约束：内联发送测得的
  槽位 `width` 与 `maxHeight`，全屏发送对话框的 `width` 与 `height`，并在尺寸或模式变化时
  重发。`toolInfo` 被省略，因为 SDK 要求完整工具定义，而宿主拿不到。组件测试用 SDK 自身的
  schema 校验这两类消息。

## 考虑过的方案

- 把 HTML 与工具结果写入历史可以离线查看，但会把大体积、可能敏感的数据放进同步的 CRDT。
- 像 `file/preview` 那样用 owner-session 内容信封加密结果被推迟：steer 与 goal 的载荷
  在该传输上本就是明文。
- 否决了每应用一个 origin 加 `allow-same-origin` 的方案。在 `credentialless` 下，Chromium
  （Electron 43.7.6）会把每次加载的 nonce 分区 storage 永久写入默认 session 的 LevelDB，
  `clearData` 与 `clearStorageData` 都删不掉；去掉 `credentialless` 则视图能看到默认
  session 的 cookie。持久的每应用 storage 需要独立的内存 session（`<webview>` partition），
  留待后续。

## 限制

原生子 Agent 子会话中的视图显示不可用。视图要求运行过该工具的 Agent 仍持有它（Codex 适配器在重启后回退到
`thread/read`）。远程机器流量经 Loro Streams 以明文传输；若应用结果变得敏感需重新评估。
视图运行在 opaque origin：fetch 带 `Origin: null`，IndexedDB 与 Cache Storage 不可用。
Web Storage 与 cookie 只在单次视图加载内有效，内存版存储不是 `instanceof Storage`。
