# 额度恢复与保留的旧预约重叠

日期：2026-10-27
Status: proposed
Translation: current

[English](2026-10-27-quota-recovery-legacy-schedule-overlap.md)

## 摘要

Claude 的定时 `continue` 和 Session 自动恢复可能针对同一项中断工作。[已实现的交付流程](../../implemented/bug-fix/2026-10-30-discard-unassociated-quota-reservations.zh.md)通过失败轮次识别新预约，并通过 Session Inbox 最多接收一项输入。没有该身份且尚未准备的旧快捷预约会被丢弃；已准备或已派发的旧工作仍由 Schedule 核对。实现已有合成测试，但真实 Provider 和跨设备行为仍需验证。

## 边界与剩余验证

旧快捷预约的 ID 对应 Workspace、Session 和五小时重置时间，不包含失败轮次，不能单独证明它由哪次失败产生。不能仅凭 `continue` 文本丢弃普通或已编辑的 Schedule，也不能丢弃已接收的输入。

新快捷预约 ID 包含失败轮次和重置时间。Schedule 交付与自动恢复接收使用同一把 Session 锁；一项输入被接收后，另一项会被丢弃或拒绝。已准备或派发的旧快捷预约只阻塞同一 Session 的 Claude 额度恢复，直到 Schedule 执行方解决。停止、取消、未确认提交和定时消息所有权仍由现有机制负责。启用恢复只作用于后续观察，不会重新触发以前的失败。

测试覆盖两种接收顺序、明确的并发交错、其他 Session 独立推进，以及无法关联的旧快捷预约。真实 Provider、远端机器和端到端恢复仍未验证。
