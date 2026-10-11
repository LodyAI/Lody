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

## 保留执行设置的类型

复用会话控件也必须复用 ACP 的 `string | boolean` 值契约。默认值、编辑、
会话/Role 提案、持久化定义及准备好的会话轮次均保留原始类型；select 的
字符串 `"false"` 不是布尔值。凭据排除及选项大小限制保持有效。

定时任务协议 v2 声明此契约。新客户端创建、编辑、恢复、执行时要求目标支持
v2；旧机器仍可查看、暂停及删除任务。旧定义保持可读，不改写 Registry 指纹、
activation 或冻结的运行标识。显示和交接时，仅对目标 Agent 声明为 boolean
的选项转换精确的旧值 `"true"`/`"false"`。未知选项和其他值仍由普通会话校验，
缺少能力数据不允许猜测类型。此兼容不会重跑已耗尽重试次数或已提交的工作。

## 依据

- [Shared validation](../packages/shared/src/schedule-types.ts)
- [Schedule UI](../packages/components/src/components/schedules/AGENTS.md)
- [Daemon scheduling](../apps/cli/src/lib/schedules/AGENTS.md)
