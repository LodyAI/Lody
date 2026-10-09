# 输入区用量指示器

Status: draft
Translation: current

[English](session-usage-indicator.md)

提供商同时上报本周和五小时订阅用量时，尚无上下文用量的输入区在紧凑指示器中
显示五小时百分比。例如，本周已使用 29%、五小时已使用 11% 时，入口显示 11%。

## 显示约定

有效的上下文用量优先显示。压缩上下文时，指示器显示压缩状态。
只有调用方启用无上下文时的订阅用量显示，才使用所选提供商和模型的额度。

订阅用量优先选择有效的五小时窗口，即使其用量为 0%。不存在有效五小时窗口时，
保留已有的最长周期窗口选择。既没有有效上下文，也没有符合显示条件的订阅用量时，
隐藏指示器；正在压缩上下文除外。

详情弹层按周期从长到短显示所有有效窗口，保留提供商上报的名称和重置时间。
紧凑指示器的窗口选择独立于详情排序。

## 证据

- [指示器与详情弹层](../packages/components/src/components/sessions/session-usage-popover.tsx)
- [行为测试](../packages/components/tests/session-usage-popover.test.tsx)
- [决策记录](../.agents/notes/implemented/bug-fix/2026-10-01-five-hour-usage-indicator.zh.md)
