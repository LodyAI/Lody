# 恢复 Claude 额度继续快捷入口

Date: 2026-10-30
Status: implemented
Translation: current

[English](2026-10-30-restore-quota-continue-shortcut.md)

> 尚未准备的旧预约处理方式已被[丢弃决定](../bug-fix/2026-10-30-discard-unassociated-quota-reservations.zh.md)取代。

## 摘要

恢复需要用户点击的 Claude 额度重置快捷入口，因为实验性的 Session 恢复界面默认关闭，且仅支持本机 Session。快捷入口沿用现有定时消息机制，符合条件的用户自有远端机器仍可使用。实验性恢复策略和定时继续分别执行；同时启用时可能产生重复继续，跨执行方协调仍是[待定方案](../../proposed/bug-fix/2026-10-27-quota-recovery-legacy-schedule-overlap.zh.md)。

## 决定与验证

输入框重新挂载原快捷入口，并保留所有权、能力、失败状态和额度检查。它继续使用确定性的身份，在重置后一秒创建一次性定时消息，保留已有预约。本决定取代[退休决定](2026-10-27-retire-quota-continue-shortcut.zh.md)；不会删除或修改已有 Schedule。

恢复的组件和行为测试来自本分支的基线。自动恢复策略仍可独立配置；此处不声称实现了跨执行方互斥或完成真实 Provider 验证。
