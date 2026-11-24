# 工作流插件的贡献项

[English](README.md)

启用插件后，其 Role、Skill、MCP server 和 ACP provider 的 ID 均为 `plugin:<plugin-id>:<contribution-id>`。Role 的 `promptPath` 从当前安装版本读取；`skills` 引用同一插件包中的 `skills/<name>/SKILL.md`，`mcpServers` 引用同一 manifest 中的局部 ID。编辑插件提供的 Role 会创建用户自己的副本。只要贡献的 Role、Skill、MCP/ACP 定义及对应文件未变，安装就沿用同一代际，因此仅修改客户端不会重启 MCP 或 ACP 子进程。禁用插件会撤下其贡献项，并关闭该安装版本拥有的 MCP 和 ACP 子进程。

Node MCP 入口通过标准输入和标准输出交换消息时，使用 `transport: "stdio"`。使用 `transport: "http"` 时，在 `process.env.LODY_MCP_SOCKET` 指定的地址监听，通过 `/mcp` 提供 Streamable HTTP 服务，并在开始监听的回调中发送 `process.send('lody:mcp-ready')`。十秒内未就绪，Lody 会报告启动失败。Lody 向 ACP 客户端提供当前 Session 专用且需要认证的回环 URL，插件不需要开放公共端口。两种 MCP 传输和随包提供的 ACP provider 均在 daemon 之外运行。子进程只继承必要的环境变量；要让子进程读取某个字符串或 secret 配置值，须在 `envKeys` 中显式列出对应的键。

## 机器所有者授权

在加密工作区中，机器所有者在个人设备上打开 **设置 → 插件**，选择操作、项目和 Role 后授权。`*` 表示该机器的所有项目或所有 Role。所有者可以单独撤销授权，不需要卸载插件。安装、链接插件或收到事件都不会产生授权。

后台写入同时需要 manifest 中的 `workflow.autonomous` 和对应操作的 `sessions.write` 或 `sessions.approve`。daemon 在此安装所属的加密工作区内重新核验签名、当前所有者及实际目标的授权范围。已结束的回合只记录来源，不能授权新输入。禁用或替换安装后，原授权失效。

Sorbet 根据 `session.turn.completed` 事件中的 `agentRoleId` 筛选架构师，以 `{ resumeFromCursor: true }` 订阅，无需原始快照权限，也不在 `onStart` 扫描历史。重放沿用同一验证请求 ID 和业务键，并保留父 Session 和事件提供的来源轮次。创建成功后，`ctx.storage` 保存该父 Session 的验证状态。加密工作区的后台交付需要机器所有者授权；仅有来源轮次不能授权执行。
