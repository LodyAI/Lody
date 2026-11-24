# 客户端读取快照

[English](README.md)

`useLodySnapshot` 订阅的数据与 `lody.readSnapshot` 可以读取的数据相同，两者都受当前工作区授权约束。同一插件安装中，订阅同一目标的组件共用数据源；最后一个订阅退出时释放它。数据变更只会使对应快照失效。没有订阅、也没有显式读取时，不会生成原始快照。返回的 JSON 与原数据分离，且递归冻结。如果 selector 每次都返回新对象，可传入 `isEqual`，避免内容相同时重新渲染面板。

| 目标 | 可读取的数据 |
| --- | --- |
| `workspace-state` | 以 ID 为键的 `sessions`、`projects`、`agentRoles` 和 `schedules`。可见本地项目副本的键为 `machineId:localProjectId`。`workspaceProjects`、`pinSections`、`mcpServers`、`projectMcpDefaults` 来自工作区目录。传入 `path` 可只读一个子树。 |
| `project-state` / `session-meta` | 可见本地项目或 Session 的元数据。只有创建该 Session 的插件可以读取其 `businessKey`。 |
| `session-transcript` | 通过该 Session 的 Loro 或 Roost 历史读取器返回 `{ turns }`。用 `turnIds` 指定最多 100 个 Turn，或用 `limit` 读取最近 1 至 100 条，默认 20 条。 |
| `schedule-doc` | 工作区 Schedule 存储中的相应文档。 |

客户端不返回可写句柄、环境变量映射、认证请求头或托管密钥字段。脱敏针对宿主的结构化字段，不会识别用户或 Agent 写在 Turn 正文中的任意文本。
