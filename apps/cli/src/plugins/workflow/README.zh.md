# 工作流插件的贡献项

[English](README.md)

启用插件后，其 Role、Skill、MCP server 和 ACP provider 的 ID 均为 `plugin:<plugin-id>:<contribution-id>`。Role 的 `promptPath` 从当前安装版本读取；`skills` 引用同一插件包中的 `skills/<name>/SKILL.md`，`mcpServers` 引用同一 manifest 中的局部 ID。编辑插件提供的 Role 会创建用户自己的副本。禁用插件会撤下其贡献项，并关闭该安装版本拥有的 MCP 和 ACP 子进程。

Node MCP 入口通过标准输入和标准输出交换消息时，使用 `transport: "stdio"`。使用 `transport: "http"` 时，在 `process.env.LODY_MCP_SOCKET` 指定的地址监听，通过 `/mcp` 提供 Streamable HTTP 服务，并在开始监听的回调中发送 `process.send('lody:mcp-ready')`。十秒内未就绪，Lody 会报告启动失败。Lody 向 ACP 客户端提供当前 Session 专用且需要认证的回环 URL，插件不需要开放公共端口。两种 MCP 传输和随包提供的 ACP provider 均在 daemon 之外运行。子进程只继承必要的环境变量；要让子进程读取某个字符串或 secret 配置值，须在 `envKeys` 中显式列出对应的键。
