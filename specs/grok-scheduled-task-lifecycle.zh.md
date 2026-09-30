# Grok 定时任务生命周期

Status: draft
Translation: current

[English](grok-scheduled-task-lifecycle.md)

Grok 在对话中创建定时任务时，Lody 应通过现有 ACP Extension Core schema
接收其生命周期。Grok 负责调度与执行，适配器负责转换原生事件。这不会创建
机器级 Lody Schedule，也不承诺 Grok 停止后继续执行。

适配器声明 `tasks: { version: 1, scheduled: true }`。标准 ACP 工具更新通过
`_meta.lody.task` 携带 `kind: "scheduled"`，使用独立于子 Agent 执行 ID 的稳定
任务 ID。创建为 pending，触发为 in_progress，移除结束调度生命周期，但不表示
触发的子 Agent 执行成功。关闭时的显示清理不能终结持久化任务。回放保留回放
标记与任务身份，包括恢复过程中的回放。只转换已拥有的会话及明确请求
load/resume 的会话。

原生调度工具的规范身份映射为 Core 的 `CronCreate`、`CronDelete`、`CronList`。
原生输入、输出和失败保持原意，不把 interval 改写为 cron。本次不增加 Core
字段或 RPC。倒计时、下次触发时间展示及调度控制不在本次范围内；生命周期接入
本身不能让现有基于 cron 的面板理解 interval。

## 证据

- 适配器：`packages/acp-extension-grok/src/proxy.js` 及其协议测试。
- Core：`packages/acp-extension-core/src/session.ts` 与 `src/capabilities.ts`。
- [实现决策](../.agents/notes/implemented/feature/2026-09-29-grok-scheduled-task-lifecycle.zh.md)。
- 已检查 grok-build `f0e3be1` 的原生协议；尚未使用锁定的 Grok 1.0.40
  运行时完成带认证的真实执行验证。
