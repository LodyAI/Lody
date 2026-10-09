# DeepSeek Harness 用户设置

Status: draft
Translation: current

[English](deepseek-harness-settings.md)

## 行为

用户在 `DSH_HOME` 下的 `settings.yaml` 配置模型路由，默认位置为 `~/.dsh`。
Harness 0.2 ACP 组合将旧 `llm-deepseek`、`llm-pi-ai` 节传入对应原生 provider
Config schema，并保留 `agent-presets.default` 与 `.agent-presets` 下的用户预置身份。
组合不能执行上游自动设置迁移：将共享文档改名并导入生成的 profile，会让持久配置
在 profile 升级时丢失。没有设置时使用默认值；格式错误时拒绝 ACP 初始化，保持
源文档不变。

当标准 preset 可用时，失效的 `agent-presets.default` 不应阻断会话。创建 ACP
会话时，保留可用的默认 preset（包括自定义 preset）；否则选择可用的 `standard`
并记录警告。持久化并返回实际选择，不改写用户设置。宿主为已有对话创建替代连接
时同样适用。显式切换 preset 仍严格校验。如果配置的默认值和 `standard` 都不可用，
应在创建 Agent 前给出修复指引，不能任意选择其他组合或改变权限设置。

上游插件拥有配置 schema 和覆盖语义。特别是 `llm-deepseek.models` 会完整替换
本地模型目录数组。设置在启动时读取，ACP 目录限定于连接：用户刷新能力
并建立新连接以获取更新后的选项。不承诺已有会话选择器会实时更新。

显式设置 `DEEPSEEK_BASE_URL` 时，仍从端点发现模型，不将本地目录添加项合并到
端点 `/models` 响应。凭据仍通过宿主环境输入，生成的组合不能嵌入凭据。
本变更不引入产品 UI 或遥测服务。

## 证据

- [扩展组合](../packages/acp-extension-dsh/src/profile.ts)
- [扩展设置文档](../packages/acp-extension-dsh/README.md)
- [宿主启动封装](../apps/cli/src/agent/deepseek-harness-runtime.ts)

此修订以草案记录所需集成，尚无该规范修订的人工批准链接。
