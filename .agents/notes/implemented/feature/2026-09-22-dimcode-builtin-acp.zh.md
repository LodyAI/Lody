# 通过 npx 接入 Dimcode 内置 Agent

Status: implemented
Translation: current

[English](2026-09-22-dimcode-builtin-acp.md)

## 摘要

Lody 的内置 Provider 选择器此前没有 Dimcode。本次接入增加稳定的 builtin 标识，
通过 npx 启动包自带的 ACP 服务。固定 0.5.10 版本，使离线缓存复用与能力缓存标识一致。
创建复用持久化的真实验证流程，提供的 SVG 随主题颜色显示。隔离探测已确认 ACP 初始化
及缺少凭据时的失败行为，尚未验证已认证的实际对话。

## 决策

行为由 [Spec](../../../../specs/dimcode-builtin-acp.zh.md) 定义。
[Bub](2026-09-11-builtin-bub-provider.md) 依赖用户安装的命令；Dimcode 使用
`npx --prefer-offline -y dimcode@0.5.10 acp`。浮动 npm 标签不利于精确版本的缓存恢复及
能力新鲜度判断，因此包版本与能力来源键共用一个版本常量。不增加 adapter、workspace
依赖、托管运行时 manifest 或自动注册。

对话框中 Bub 的 setup 观察流程扩展为两个 Provider 共用，同时保留 Bub 专属安装指导。
TS 与 CJS 本地请求校验均接受 Dimcode，CLI 将其无歧义名称推断为 builtin。不预设模型或
权限默认值；在有真实认证对话证据之前，不声明上游拥有权威标题。

## 证据与限制

公开 npm 元数据和 `--help` 确认二进制命令为 `dim`/`dimcode`，子命令为 `acp`。
临时 HOME 下的 0.5.10 探测完成协议 v1 的 `initialize`，无凭据的 `session/new` 返回
需要认证。包内运行时声明的默认技能目录为 `.agents/skills` 和 `~/.agents/skills`，
内置技能注册表使用相同目录。未发送 prompt、登录账号或使用真实用户对话。自动化覆盖扩展现有的启动与缓存
参数解析、本地校验一致性、Provider 发布和对话框 setup／重试／刷新行为测试。

验证：shared、CLI 和 components 的 125 项相关测试通过；三个包的类型检查、变更范围的
类型感知 lint（零错误）、i18n、公开边界、格式和文档检查通过。未运行全仓构建，
也未执行已认证的端到端对话。

创建 PR 前，全量 `pnpm check`、`pnpm format` 和 `pnpm run docs check` 均通过。
