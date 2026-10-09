# DeepSeek Harness 用户设置

Status: draft
Translation: current

[English](deepseek-harness-settings.md)

## 行为

每个 Lody DSH Provider 使用 `<Lody 数据目录>/dsh/providers/<编码后的 Provider ID>`
作为独立 `DSH_HOME`。改名不换目录，不同 Provider 的目录不同。用户可在其中的
`settings.yaml` 配置支持 settings 的插件。详情页通过目标机器发布的数据目录及
`dshProviderIsolation: 1` 能力显示「配置路径: <绝对 YAML 路径>」，指向
`profiles/lody-acp/cordis.patch.yml`；旧机器不显示猜测的路径。

该用户 patch 仅在缺失时创建。启动、并发启动及适配器升级都保留它和 `settings.yaml`，
生成的宿主配置独立更新。最后的宿主层保持 ACP 入口、会话存储路径及禁用产品服务和遥测，
不重置用户模型路由。已有原生会话和查询数据库仍使用原 DSH 会话目录。
旧全局设置和带指纹 profile 保持原样，不自动从多个旧 profile 中任选一个或复制给全部
Provider；需要的自定义项由用户迁入显示的路径。Magpie 默认的全局 DSH 扫描不会自动发现
这些私有 home，Lody 导入仍直接配置 Provider 环境变量。

Lody 内置 DeepSeek ACP 组合必须挂载上游文件设置提供者，
并保留用户文档。没有设置时使用组合默认值；文档格式错误时启动失败，不能静默
覆盖或丢弃文档。

当标准 preset 可用时，失效的 `agent-presets.default` 不应阻断会话。创建 ACP
会话时，保留可用的默认 preset（包括自定义 preset）；否则选择可用的 `standard`
并记录警告。持久化并返回实际选择，不改写用户设置。宿主为已有对话创建替代连接
时同样适用。显式切换 preset 仍严格校验。如果配置的默认值和 `standard` 都不可用，
应在创建 Agent 前给出修复指引，不能任意选择其他组合或改变权限设置。

上游插件拥有配置 schema 和覆盖语义。特别是 `llm-deepseek.models` 会完整替换
本地模型目录数组。设置提供者会观察更新，但 ACP 目录限定于连接：用户刷新能力
并建立新连接以获取更新后的选项。不承诺已有会话选择器会实时更新。

显式设置 `DEEPSEEK_BASE_URL` 时，仍从端点发现模型，不将本地目录添加项合并到
端点 `/models` 响应。凭据仍通过宿主环境输入，生成的组合不能嵌入凭据。
本变更不引入产品 UI 或遥测服务。

## 证据

- [扩展组合](../packages/acp-extension-dsh/src/profile.ts)
- [扩展设置文档](../packages/acp-extension-dsh/README.md)
- [宿主启动封装](../apps/cli/src/agent/deepseek-harness-runtime.ts)

此修订以草案记录所需集成，尚无该规范修订的人工批准链接。
