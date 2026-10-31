# 恢复 Claude 额度继续快捷入口

Date: 2026-10-30
Status: implemented
Translation: current

[English](2026-10-30-restore-quota-continue-shortcut.md)

> 尚未准备的旧预约处理方式已被[丢弃决定](../bug-fix/2026-10-30-discard-unassociated-quota-reservations.zh.md)取代。

## 摘要

自动 Session 恢复需主动启用，符合条件的用户自有机器仍可使用 Claude 额度重置快捷入口。快捷入口沿用现有定时消息机制。Schedule 和 Automation 对同一失败 Turn 协调接纳；[旧预约重叠分析](../../proposed/bug-fix/2026-10-27-quota-recovery-legacy-schedule-overlap.zh.md)说明了边界。

## 决定与验证

失败提示提供快捷入口，并保留所有权、能力、失败状态和额度检查。它使用确定性的身份，在重置后一秒创建一次性定时消息。无法关联且尚未准备的旧预约按[丢弃决定](../bug-fix/2026-10-30-discard-unassociated-quota-reservations.zh.md)处理。本决定取代[退休决定](2026-10-27-retire-quota-continue-shortcut.zh.md)。

自动恢复策略仍可独立配置；真实 Provider 行为仍未验证。
