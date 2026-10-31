# 恢复 Claude 额度继续快捷入口

Date: 2026-10-30
Status: implemented
Translation: current

[English](2026-10-30-restore-quota-continue-shortcut.md)

> 尚未准备的旧预约处理方式已被[丢弃决定](../bug-fix/2026-10-30-discard-unassociated-quota-reservations.zh.md)取代。

## 摘要

此前恢复了符合条件的用户自有机器上的 Claude 额度重置快捷入口，因为自动 Session 恢复需主动启用。失败提示现在开启 Session 恢复，不再创建 Schedule；已有预约仍由定时消息机制管理。Schedule 和 Automation 对同一失败 Turn 协调接纳；[旧预约重叠分析](../../proposed/bug-fix/2026-10-27-quota-recovery-legacy-schedule-overlap.zh.md)说明了边界。

## 决定与验证

原快捷入口以确定性身份创建重置后的一次性定时消息。失败提示现在为当前已确认的失败和后续失败开启 Session 恢复策略。无法关联且尚未准备的旧预约按[丢弃决定](../bug-fix/2026-10-30-discard-unassociated-quota-reservations.zh.md)处理。本决定取代[退休决定](2026-10-27-retire-quota-continue-shortcut.zh.md)。

自动恢复策略仍可独立配置；真实 Provider 行为仍未验证。
