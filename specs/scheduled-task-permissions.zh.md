# 定时任务的权限能力

Status: draft
Translation: current

[English](scheduled-task-permissions.md)

定时任务编辑器沿用会话输入框显示的 Agent 默认值，包括 provider 提供的权限
选项。保存、守护进程创建和运行交接不额外强制要求显式权限值，也不为此要求
存在能力缓存。省略的运行配置沿用常规会话和 provider 默认值。Pi 等没有权限
控制的 provider 不需要虚构模式。

常规会话准备和 provider 配置路径继续校验执行设置是否受支持。机器所有权、
Agent 可用性、目标会话检查和凭据排除保持不变。移除这道重复检查不会自动
批准 provider 的权限请求。

## 依据

- [Shared validation](../packages/shared/src/schedule-types.ts)
- [Schedule UI](../packages/components/src/components/schedules/AGENTS.md)
- [Daemon scheduling](../apps/cli/src/lib/schedules/AGENTS.md)
