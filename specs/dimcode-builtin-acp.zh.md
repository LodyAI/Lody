# Dimcode 内置 ACP

Status: draft
Translation: current

[English](dimcode-builtin-acp.md)

用户可在内置 Provider 分组中选择 Dimcode，并通过其标志识别它。设置、CLI 创建与本地
会话分发统一使用稳定标识 `builtin/dimcode`。

Lody 通过 npx 启动固定包版本的 Dimcode stdio ACP 服务，复用现有配置目录专属的 npm
缓存及启动恢复流程完成安装与复用。Dimcode 不属于托管产物运行时，也不自动注册。
凭据来自 Dimcode 自身配置或 Provider 环境变量。

创建使用持久化 Provider setup：仅在真实能力验证成功后发布 Provider；失败可重试。
对话框可观察 setup 并刷新已发布 Provider。不支持 provider setup 的旧版机器无法创建它。
模型、模式及扩展能力来自真实 ACP 发现。在确认上游权威标题行为之前，保留 Lody 的标题生成器。

## 证据

- [启动解析](../apps/cli/src/agent/setting.ts)
- [Provider 对话框](../packages/components/src/components/settings/agent-config-dialog.tsx)
- [决策与验证](../.agents/notes/implemented/feature/2026-09-22-dimcode-builtin-acp.zh.md)
