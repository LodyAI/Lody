# 丢弃无法关联的旧额度预约

Date: 2026-10-30
Status: implemented
Translation: current

[English](2026-10-30-discard-unassociated-quota-reservations.md)

## 摘要

旧版 Claude 额度快捷方式保存了一次性 `continue`，但没有失败轮次身份。使用该原始身份且尚未准备的预约会被跳过，而不是猜测关联到某次恢复；运行状态会说明未发送的原因。已准备或已派发的输入继续由 Schedule 核对。新的手动预约标识失败轮次；Schedule 和自动恢复通过现有 Session Inbox 协调接收，以首先接受的输入为准。

## 边界

独立的[识别逻辑](../../../../apps/cli/src/lib/schedules/legacy-quota-reservation.ts)要求原始 Workspace、Session、重置时间生成的 ID、单次触发和字面完整消息。暂停后恢复的快捷预约仍能识别；普通消息及修改过内容或触发时间的 Schedule 不受影响。[Schedule 执行方](../../../../apps/cli/src/lib/schedules/schedule-engine.ts)跳过尚未准备的任务，包括等待重试的任务；不丢弃已经准备或已交付的输入。本决定取代[恢复笔记](../feature/2026-10-30-restore-quota-continue-shortcut.zh.md)中保留未准备旧预约的决定。

界面仍允许查看已有旧预约，新预约使用失败轮次和重置时间共同生成的确定性 ID。独立的[交付逻辑](../../../../apps/cli/src/automations/compat/quota-schedule.ts)在该 Session 的 Inbox 锁内检查原输入及已接受的自动恢复。Schedule 在同一把锁内发布已准备输入；自动恢复在接收之前在锁内完成最终本地检查。首个被接受的输入胜出，无法关联的新预约会被丢弃，普通 Schedule 不进入该边界。之前已准备的旧工作仅阻塞该 Session 的 Claude 额度恢复，直到其 Schedule 执行方解决；不会转移旧输入。

停止、取消和释放仍由现有 Session 与 Schedule 机制负责。自动化执行方不可用时，相关额度 Schedule 保持可重试；回执丢失时复用现有 Schedule 和 Inbox 证据，不创建新的输入。锁内元数据操作属于本地执行方；Provider 查询在锁外完成。合成测试覆盖两种接收顺序、明确的并发交错、其他 Session 独立推进、旧预约丢弃边界和预约可见性。真实 Provider 和跨设备交付尚未验证。
