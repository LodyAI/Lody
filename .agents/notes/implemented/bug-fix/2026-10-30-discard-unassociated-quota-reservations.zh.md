# 丢弃无法关联的旧额度预约

Date: 2026-10-30
Status: implemented
Translation: current

[English](2026-10-30-discard-unassociated-quota-reservations.md)

## 摘要

旧版 Claude 额度快捷方式保存了一次性 `continue`，但没有失败轮次身份。在 2026-11-16 之前，使用该原始身份且尚未准备的预约会被跳过，而不是猜测关联到某次恢复；由于这类预约均已过期，该兼容跳过已被删除。已准备或已派发的输入继续由 Schedule 核对。此前创建的关联轮次的预约标识失败轮次；Schedule 和自动恢复通过现有 Session Inbox 协调接收，以首先接受的输入为准。

## 边界

摘要所述的旧识别逻辑和 Schedule 执行方的 `LEGACY_QUOTA_UNASSOCIATED` 跳过，已在 2026-11-16 的[兼容切断](../simplification/2026-11-16-drop-pre-october-compatibility.zh.md)中删除：v1/v2 快捷预约都在该日期前到期，不含失败轮次的 id 现在按普通一次性 Schedule 处理。本决定曾取代[恢复笔记](../feature/2026-10-30-restore-quota-continue-shortcut.zh.md)中保留未准备旧预约的决定；[额度预约匹配逻辑](../../../../apps/cli/src/lib/schedules/quota-reservation.ts)只识别关联轮次的 `qc3_` 预约。

已有预约仍可在 Schedules 中查看；失败提示现在开启 Session 恢复，不再创建预约。独立的[交付逻辑](../../../../apps/cli/src/automations/compat/quota-schedule.ts)在该 Session 的 Inbox 锁内检查原输入及已接受的自动恢复。Schedule 在同一把锁内发布已准备输入；自动恢复在接收之前在锁内完成最终本地检查。首个被接受的输入胜出，无法关联的新预约会被丢弃，普通 Schedule 不进入该边界。之前已准备的旧工作仅阻塞该 Session 的 Claude 额度恢复，直到其 Schedule 执行方解决；不会转移旧输入。

停止、取消和释放仍由现有 Session 与 Schedule 机制负责。自动化执行方不可用时，相关额度 Schedule 保持可重试；回执丢失时复用现有 Schedule 和 Inbox 证据，不创建新的输入。锁内元数据操作属于本地执行方；Provider 查询在锁外完成。合成测试覆盖两种接收顺序、明确的并发交错、其他 Session 独立推进、旧预约丢弃边界和预约可见性。真实 Provider 和跨设备交付尚未验证。
