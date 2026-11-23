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

## 消融实验驱动的清理

原有五组测试的基线为 157 项通过。删除生产代码前，先将两组 discovery 测试扩展到
22 项行为用例，覆盖 CLI 输入规范化与边界、Role 机器筛选、机器元数据不可用时的
GitHub 专属查询，以及混合项目结果。随后逐组删除并验证：

| 候选项 | 证据与结论 |
| --- | --- |
| CLI 的通用查询解析 | 删除后 22 项仍通过；服务继续通过严格的资源 Schema 校验输入。 |
| 命令工厂中的 machine/project 分支 | 没有生产调用方，这两个命令自行注册兼容参数。将工厂收窄到三个真实调用方；22 项测试及 CLI 类型检查通过。 |
| 重复的项目类型判断、机器列表按机器 ID 筛选分支 | 前面的提前返回或 Schema 拒绝使其不可达。删除这两处判断，并将每行 Agent 能力解析合并为一次；22 项通过。 |
| 重复的资源 Schema 字段 | 从共享 Schema 派生显式字段白名单；五个 MCP 工具和服务直接调用仍拒绝无关字段，22 项通过。 |
| Agent 摘要转发包装函数 | 改为导入别名；扩大后的六组回归测试共 174 项通过。 |

反向对照实验临时删除最终结果的机器筛选，Role 测试立即失败：期望只有 `two`，实际
返回 `one` 和 `two`。恢复筛选后测试重新通过。上游机器读取筛选不能替代它，因为不可读
或缺失的 Role 绑定仍需保留在可见目录中。GitHub 专属查询的提前返回、授权、游标校验、
安全投影和旧 CLI 路径均保留。这些实验支持本次局部精简，不构成所有运行状态的形式化
证明或性能基准；公开参数和 Spec 意图不变。

本轮全仓库类型/静态检查、格式化、文档检查（61 条既有警告）、i18n 和边界检查通过。
`NODE_ENV=test pnpm check` 运行到 CLI 套件，结果为 3116 项通过、7 项失败、1 项跳过。
其中六项 cloudflared 生命周期测试超时，一项 Git 工作区元数据回填断言失败。
将四个改动的生产文件临时恢复为精简前的 HEAD 后，`stops through IPC` 和
`backfills an existing local owner` 两个代表用例分别复现了相同失败。
随后恢复精简版本，174 项定向测试再次通过。全量检查并非全绿，后续阶段未完成；
本 PR 不扩展修改这些无关失败。
