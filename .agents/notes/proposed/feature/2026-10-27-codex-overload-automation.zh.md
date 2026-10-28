# 将 Codex 高负载恢复纳入会话自动化

日期：2026-10-27
状态：proposed
翻译：current

[English](2026-10-27-codex-overload-automation.md)

## 摘要

当前 Codex 高负载重试由已挂载的前端界面负责，关闭会话后不会继续。用户希望将其
迁入会话自动化，并允许移除旧重试界面。迁移尚未完成：Session 观察已记录结构化的
高负载分类，但自动化策略尚未消费该分类，旧重试仍然有效。

## 边界与验证

只把结构化的 Codex `serverOverloaded` 错误分类为高负载；普通服务错误和额度耗尽
仍然独立。完整迁移需要明确启用方式、重试次数和时间、原生输入与释放证据、取消和
重启行为、可见状态以及唯一派发方。新路径未完成前移除前端重试会丢失能力；两条
路径同时启用则可能重复继续。

[自动化协调器](../architecture/2026-10-25-session-automation-coordinator.md)负责持久化
Session 边界。用户选择当前不处理[保留的旧预约](../bug-fix/2026-10-27-quota-recovery-legacy-schedule-overlap.zh.md)，
因此重叠仍可能发生。错误分类仅通过合成 ACP 错误测试；真实 Codex 恢复和端到端迁移
尚未验证。
