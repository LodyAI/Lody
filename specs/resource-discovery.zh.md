# MCP 与 CLI 资源发现

Status: draft
Translation: current

[English](resource-discovery.md)

Agent 应能在创建任务前发现资源的稳定 ID，查看可读目标为何不能执行，并恢复自己发起的
Operation 列表。CLI 与 MCP 共用目录查询服务和安全摘要。

## 行为

机器、项目、Agent 配置、Agent Role 和工作区 MCP 目录支持有界列表查询。
Agent 配置与 Role 详情接受稳定 ID。列表默认 20 项，允许 1–100 项，返回 `items`、
`hasMore` 和可选 `nextCursor`。游标绑定资源、工作区、读取者和筛选条件，允许调整页大小。
按稳定资源身份排序。这是实时键集分页，并非冻结快照；新插入的较早键需要重新遍历。
本地项目身份包含机器 ID；GitHub 条目表示已启用的工作区仓库，不绑定机器。

仅返回经过授权的资源。MCP 身份来自运行中的 Turn。Role list/get 遵守
`canReadAgentRole`，不改变按显式 ID 创建 Role 会话的独立契约。可读但不可用的 Role
保留在列表中，并说明绑定、机器、模型或权限模式原因。
缺少在线状态或能力信息意味着未知，并非不可用的证据。可用性不能替代分发校验，
也不保证未来仍可用。

Agent 摘要包含模型与运行能力，不包含启动配置。MCP 摘要完全排除连接值。
已知的当前 Turn 选择与目录配置分开报告；未知选择保持缺省，已选择不代表加载成功。
Role Prompt 前缀仅通过详情返回，运行选项使用现有敏感字段规范化器。

Operation 列表在所属机器的 SQLite 存储中，按工作区、请求方会话及调用/登录用户限定。
支持状态筛选和有界键集分页。摘要仅包含 ID、种类、状态、时间和条目数量，
不返回 Prompt 或助手输出，不改变自动完成投递。

会话列表增加不区分大小写的标题/ID 搜索，以及机器、Agent 配置、Role 创建来源的
精确筛选；筛选先于现有分页及状态查询。

## 兼容性与限制

`session_create_options` 保持稀疏，并明确搜索最多 20 项；完整遍历使用目录工具。
CLI 工作区目录列表改为分页安全摘要，支持 `--all-pages`，保留资源专属 JSON 数组别名。
本地 daemon 项目列表、可信 Agent 配置 `show` 及显式的旧机器详情输出保持可用。

配置查看使用独立的展示契约：`show` 默认只输出排序后的 `envKeys`，包括空值的键，
不输出 `env` 值。仅显式 `show --show-secrets` 包含 `env`。JSON create/update
只确认 `agentConfigId` 和 `changedFields`（初始化或请求修改的字段名），不回传完整存储配置。
保存的启动值不变。无效赋值只报告位置，不回显原始输入。这会有意改变依赖旧完整
配置 JSON 的脚本：改用回执 ID，需要查看时显式执行查看命令。展示字段采用允许列表；
运行时、认证、自定义启动及未来新增字段不会自动导出，即使开启显示密钥选项也一样。
这是减少意外泄露的措施，不是新的授权边界，也不是完整备份格式。

初始接入使用现有云工作区运行时。新增 CLI 工作区查询在 local 组合中会在云请求前拒绝。
目录离线读取仍需联网验证权限，仓库列表仅支持在线查询。目录同步失败会使读取失败，
不能报告为空列表。Operation CLI 查询本机存储，不是跨机器聚合服务。

## 证据

- [查询与分页](../apps/cli/src/lib/discovery-query.ts)
- [目录服务](../apps/cli/src/lib/resource-discovery.ts)
- [MCP 工具](../apps/cli/src/mcp/discovery-tools.ts)、[CLI 边界](../apps/cli/src/commands/discovery.ts)
- [Operation 存储](../apps/cli/src/orchestration/operation-store.ts)
- [决策记录](../.agents/notes/implemented/feature/2026-09-27-resource-discovery.zh.md)
