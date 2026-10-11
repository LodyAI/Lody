# 将 Codex 标题迁移到可配置的 Lody 会话

Status: implemented
Translation: current

[English](2026-10-10-codex-client-titles.md)

## 摘要

Codex 适配器原本使用写死的模型生成标题，绕过 Provider 标题设置。
现在 builtin Codex 通过 Lody 现有独立会话生成标题并开放设置，默认使用
gpt-5.6-luna、low 推理和 full access。移除适配器生成器避免重复请求，
包括为标题会话再次生成标题。原生显式命名继续兼容，其他 Provider 标题归属不变。

本决策部分替代 [ACP 标题归属](2026-09-08-acp-owned-session-titles.md)
和[标题能力协商](../feature/2026-09-24-acp-session-title-capability.md) 中 Codex 的部分。
[Spec](../../../../specs/acp-session-titles.md) 仍为 draft。

## 职责与限制

共享归属判断对 builtin Codex 忽略旧能力缓存，会话分发和 Provider 设置共同使用它。
非空的已保存标题配置优先于默认值。运行时拒绝不可用的 Codex 选项，避免悄悄换模型；
失败保留现有的提示词衍生兜底标题。独立会话沿用 Provider 认证，不改变主聊天模型或权限。
Full access 仅配置在独立标题会话，其现有临时工作目录和客户端权限处理不变。

适配器保留原生显式标题和提示词预览，移除标题模型请求、能力声明及过时生成生命周期。
部署必须包含更新后的适配器，旧适配器二进制仍可能自行生成标题。
子模块与宿主修改需一起交付。

## 验证

行为覆盖包括旧归属缓存下设置的显示与保存、独立标题请求的默认和自定义配置、
不可用选项、Codex 与其他 Provider 的分发、原生命名事件及适配器生命周期。
这些检查无需真实模型请求；测试不证明实际账号有权使用默认模型。

已完成验证：372 项相关测试通过，shared、CLI、components、Codex 类型检查、
适配器构建、范围内 lint（仅警告）及公共边界检查通过。

创建 PR 前的完整 `pnpm check` 已通过类型检查和 lint，但在未修改的
`github-git-transport.test.ts` 递归 SSH 克隆测试停止：本地 Git 认证桥返回
`context_unreadable`。单独重跑复现同一失败（其余 5 项通过），CLI 共 3707 项测试通过。
`pnpm format` 通过。

配套适配器 PR: [acp-extension-codex #68](https://github.com/LodyAI/acp-extension-codex/pull/68).

适配器分支已合入上游 #67 的故障诊断历史；被移除的生成器及其诊断由客户端标题生成替代。合并后重新通过适配器类型检查和 28 项相关测试。
