# Dimcode 内置 ACP

Status: draft
Translation: current

[English](dimcode-builtin-acp.md)

用户可在内置 Provider 分组中选择 Dimcode，并通过其标志识别它。设置、CLI 创建与本地
会话分发统一使用稳定标识 `builtin/dimcode`。

Lody 从目标机器的 Agent PATH 启动用户安装的 `dimcode acp`。用户自行安装支持 ACP
的版本并负责升级。Lody 不为内置 Dimcode 安装、锁定版本、升级或下载备用运行时。
Lody 启动的子进程关闭上游自动更新检查及后台安装，不改变用户终端环境。凭据和本地
状态仍使用 Dimcode 自身配置或 Provider 环境变量，不另设 Lody 私有 home。Dimcode 不自动注册。

已有内置配置保持 Provider 标识不变，改用用户安装的命令；旧 Lody npm 缓存保留。
历史 Registry 配置保留独立的启动契约。能力来源标识变更一次，使旧固定版本缓存失效；
之后用户升级版本时，与 Bub 一样通过手动刷新获取当前能力。

创建使用持久化 Provider setup：仅在真实能力验证成功后发布 Provider；失败可重试。
缺少命令或版本不支持 ACP 子命令时显示“未检测到 dimcode，使用 `npm install -g dimcode` 安装”，命令旁带复制按钮，不执行安装。
对话框可观察 setup 并刷新已发布 Provider。不支持 provider setup 的旧版机器无法创建它。
模型、模式及扩展能力来自真实 ACP 发现。在确认上游权威标题行为之前，保留 Lody 的标题生成器。

## 证据

- [启动解析](../apps/cli/src/agent/setting.ts)
- [Provider 对话框](../packages/components/src/components/settings/agent-config-dialog.tsx)
- [决策与验证](../.agents/notes/implemented/feature/2026-09-22-dimcode-builtin-acp.zh.md)
- [用户管理运行时决策](../.agents/notes/implemented/simplification/2026-10-10-dimcode-user-installed.zh.md)
