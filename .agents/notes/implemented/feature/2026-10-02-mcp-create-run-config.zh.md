# MCP 创建会话的显式配置

Status: implemented
Translation: current

[English](2026-10-02-mcp-create-run-config.md)

## 摘要

MCP 创建会话原本可以选择模型和规划控制，却需要 Role 才能显式指定权限。
单个和批量创建现在接受 ACP `modeId` 与 `configOptionValues`，复用已有 CLI
能力校验和持久化 Operation 配置。所有公布的 option 均可选择，包括没有类别
的权限 selector；不引入权限映射或升级政策。Fixture 测试和删除实验验证的是
派发配置与重试身份，不代表真实 provider 的权限执行或桌面验收。

## 决策与证据

[Issue #1172](https://github.com/LodyAI/Lody/issues/1172) 要求临时创建时显式选择
配置。[创建合同](../../../../specs/session-orchestration.zh.md#会话创建配置)
负责优先级、授权、合并和恢复行为。已有语义解析器继续处理 model/reasoning/
Fast/Plan；raw options 使用 CLI 对公布的 id、类型和值的校验。权限 option
不替换显式语义控制。无需类别白名单、语义权限别名、provider 映射、权限等级
或第二个 resolver。

两个已有组合细节需要明确处理。运行时先应用标量 mode/model 再处理 raw
selector，因此 create 必须在显式 raw selector 存在时清除相应继承标量，
与 chat 已有处理一致。没有提供语义 model 时，语义 effort 必须按 raw option
选择的模型校验。旧式 Plan 占用 ACP mode selector，因而与不同的显式 mode
冲突；独立 Plan option 可以与权限共存。Raw option map 仍整体替换继承 map。

发现接口投影 mode 与 option selector 元数据，不暴露当前值或启动配置。
两个 MCP 发现入口共用摘要。Operation 存储已支持具体 mode/map，无需迁移或
新增恢复分支。接受时的目标配置保持冻结，显式输入参与命令身份。Role 拥有的
手填覆盖项仍被忽略。

## 验证与删除实验

已有 MCP suite 组合真实 schema、派发构造、能力解析、CLI 校验和 SQLite
接受/重开。合成能力包含无类别的 Grok 形状权限、Codex 独立 Plan 和 Claude
旧式 Plan。单个/批量身份测试验证重开后的固定目标 id 与冻结配置、map 键顺序
等价，以及更改选择时拒绝重试。这些测试不执行 daemon 恢复 worker 或真实 provider。

以下删除均实际应用到源码、运行测试，然后恢复：

| 删除的行为 | 观察到的回归 |
| --- | --- |
| 旧式 Plan 冲突检查 | 冲突测试失败：显式 `auto` 被静默替换为 `plan`。 |
| Raw selector 清除继承 mode/model | 继承测试失败：父会话的 `agent` 和模型仍具有优先级。 |
| 按 raw 模型校验语义 reasoning | 目标模型测试失败：不支持的 effort 按探测模型被误接受。 |
| 命令身份中的 mode/map | 单个和批量身份测试均失败：更改选择被当作重试接受。 |

在已有边界保留这些小检查。舍弃的类别白名单与权限 resolver 备选方案没有实现。
不保留新的持久化格式、运行时政策层或 provider 专用派发路径。

五个相关 suite 的 202 个测试通过，shared 类型检查、限定文件格式/lint 和公开
边界检查通过。CLI 类型检查受到缺失依赖和 Streams transport 类型不匹配阻塞。
临时回退三个生产文件的改动后，同样的八条诊断仍存在；恢复后 patch 的 SHA-256
完全一致。根目录 `pnpm check`
在 Claude adapter 构建时因依赖/API 不匹配停止。文档检查仍有无关的缺失子模块
链接。真实 provider 权限执行、完整 daemon 重放和打包桌面验收仍未验证；
没有修改任何真实会话权限。

实现：[MCP server](../../../../apps/cli/src/mcp/lody-mcp-server.ts)、
[CLI 创建边界](../../../../apps/cli/src/commands/session.ts)、
[共享能力摘要](../../../../packages/shared/src/acp-run-config.ts)、
[MCP 回归 suite](../../../../apps/cli/src/mcp/lody-mcp-server.test.ts)。
