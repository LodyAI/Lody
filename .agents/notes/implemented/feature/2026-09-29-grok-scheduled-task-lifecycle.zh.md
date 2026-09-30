# 通过现有 Core 元数据接入 Grok 定时任务

Status: implemented
Translation: current

PR: https://github.com/LodyAI/Lody/pull/1102
适配器 PR：https://github.com/LodyAI/acp-extension-grok/pull/24

[English](2026-09-29-grok-scheduled-task-lifecycle.md)

## 摘要

Grok 原生定时任务通知此前直接透传，缺少 Core 生命周期元数据，Lody 无法将其
作为提供方无关的任务事实消费。适配器现在通过现有 schema 转换创建、触发和
移除事件，并声明定时任务能力。原生 interval 输入保持不变，基于 cron 的下次
触发时间面板不在本次范围内。锁定运行时上的真实认证执行仍待验证。

## 决策与证据

Core 已定义定时任务能力、生命周期元数据及标准调度工具名。对最初调查的
修正是：Core 足以完成生命周期接入，额外时间字段仅在更完整的调度展示中需要。
复用现有契约可避免另建一套 RPC。

原生源码 `xai-org/grok-build@f0e3be1` 定义 created/fired/deleted 事件、规范
`x.ai/tool` 元数据及明确保留任务供恢复使用的 shutdown 移除原因。适配器只转换
已拥有或正在恢复的会话，保留回放标记及稳定的命名空间 ID，不把触发视为执行
成功。shutdown 被消费而不生成终态；移除结束调度所有权，子 Agent 输出独立处理。

与[机器级调度](2026-09-24-machine-owned-scheduled-tasks.zh.md)不同，本适配器
不调度工作，也不创建工作区定义。interval 无法安全转换为 cron；只规范工具名
不能让基于历史推导的倒计时面板支持 interval。

## 验证

协议测试覆盖能力、重复触发、更新、移除原因、shutdown、恢复完成前的回放、
恢复失败、异常及其他会话事件、标准工具身份、失败保留和 interval 输入不变。
本次运行完整适配器测试及语法检查。合成测试不覆盖 Grok 1.0.40 的真实认证执行。

意图：[Spec 草案](../../../../specs/grok-scheduled-task-lifecycle.zh.md)。
