# MCP 与 CLI 共用资源发现

Status: implemented
Translation: current

[English](2026-09-27-resource-discovery.md)

PR: https://github.com/LodyAI/Lody/pull/1045

## 摘要

稀疏的会话创建候选项无法遍历项目、Agent 配置及离线机器，Role 创建接受 ID 却没有发现工具。
新的共享目录查询为 MCP 与 CLI 提供有界分页、安全摘要和明确的不可用原因。
Operation 摘要补齐请求方范围内的任务发现，会话查询增加标题及目标筛选。
CLI 工作区列表改为分页摘要，同时保留本地与显式详情检查路径；本次不为 local 平台增加云访问。

## 决策与职责

保留 `session_create_options` 作为轻量创建辅助入口，避免每次调用都读取完整工作区。
`resource-discovery.ts` 负责目录投影及可见性，`resource-discovery-runtime.ts`
提供同步后的目录和调用者权限验证。MCP 与 CLI 转换输入并展示结果。
`discovery-query.ts` 负责共享 Schema、筛选和游标行为，现有 SQLite Operation
存储执行有界的请求方/用户/工作区范围查询。

分别增加工具专属读取器会延续可见性、分页及凭据处理的不一致。单一通用公共工具又会
隐藏资源特定的 Schema，因此保留显式资源工具，共用一个服务。
键集分页避免偏移量变动，但不提供快照隔离。机器目录读取通过顺序执行限制并发；
初版仍会在生成一页之前扫描目录元数据，不引入额外持久索引。

Role 发现遵守目录可读权限并规范化敏感选项。显式 ID 创建仍是独立契约，见
[目录说明](../../../docs/workspace-catalog-durability.md)。目录可用性不是目标预留。
[Spec](../../../../specs/resource-discovery.zh.md) 记录兼容性和平台限制，
[CLI 指南](../../../../apps/cli/README.md) 记录命令。

## 证据与验证

检查 `buildSessionCreateOptions` 确认项目、配置、仓库匹配最多 20 项且无续页，
Role 仅有创建时的查找路径。现有 CLI 读取器使用不同返回投影，没有活跃 Note
负责统一发现主题。[Role 可用性决策](2026-09-09-agent-role-mention-availability.zh.md)
继续有效。

行为测试覆盖超过 20 项的目录分页、游标范围拒绝、授权与可见性、未知在线状态、
Role 不可用绑定、安全 MCP 摘要、真实内存 MCP 请求及 CLI 分页遍历。
SQLite 测试覆盖 Operation 读取隔离。测试使用合成目录和显式状态，验证不包含
生产写入或部署。尚未验证真实混合版本发布。Spec 保持 draft，实现不代表意图已获审批。

178 项相关测试、全仓库类型/静态检查、格式化、文档、i18n 和边界检查通过。
完整 `pnpm check` 在继承的 `NODE_ENV=production` 环境下，因未改动的
`code-review-helper` 渲染测试报错 `act is not a function` 而停止。
同一测试以 `NODE_ENV=test` 复跑通过，其余全量测试未完成。
