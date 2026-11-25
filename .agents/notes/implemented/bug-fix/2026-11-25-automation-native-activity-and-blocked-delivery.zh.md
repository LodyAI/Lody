# 自动化原生后台活动判定、空闲唤醒与阻塞交付外显

Status: implemented
Translation: current
PR: [#3353](https://github.com/LodyAI/Lody/pull/3353)

[English](2026-11-25-automation-native-activity-and-blocked-delivery.md)

## 摘要

未声明 Core `sessionActivity` v1 的 agent（如 Antigravity、Codex）在自动交付时会静默卡死：`session.group.settled` 会把尚未上报活动状态的存活进程一律视为 `native_activity_unobserved`，直到 20 分钟后空闲 GC 杀掉进程才解锁，而交付策略又把除 `target_stopped` 之外的全部 `blocked` 回执折叠为进行中状态。现在由 `MessageHandler.getNativeWork` 作为 GC 与自动化的唯一原生任务真源——声明 `sessionActivity` v1 时遵循 replace 语义，未声明时回退到 `SessionActivePresence` 的 30 秒被动 `lateActivity` 窗口。原生空闲唤醒收窄为仅唤醒 `state = 'blocked'` 且原因为会话忙碌类的回执；自动交付对确定性非忙碌阻塞立即外显 `stalled`，对瞬态/未确认阻塞提供 60 秒宽限期。对于不声明协议的 agent，静默超过 30 秒的后台 shell 会被视为空闲，这是对自动交付无害、对 `archive-after-merge` 明确接受的取舍。

## 问题

1. **`session.group.settled` 生命周期失配。** 此前 `SessionAutomationAuthority` 把未收到 `_lody/session/activity_update` 的存活进程判定为 `unknown`（`native_activity_unobserved`）。对于不声明 `sessionActivity` v1 的 agent，自动交付的每一步（例如 CI 通过后的自动合入）都会卡满 20 分钟直到 GC 清理进程；即便对声明协议的 agent，未收到首条更新时也违背了 [Session GC respects native agent work](2026-10-18-gc-respects-native-agent-work.zh.md) 的 replace 语义。
2. **阻塞状态被吞没。** `policies/delivery.ts` 将除 `target_stopped` 外的全部 `blocked` 回执视为 `outstanding`，导致权限、归属或释放未确认等阻塞在 UI 上持续显示“合入中”。
3. **空闲唤醒过宽的风险。** 若在原生任务空闲时唤醒会话下全部非终态回执，会把停在 `estimatedReset` 的配额恢复回执提前拉回 `now`（触发多余的 provider 刷新），并刷新 `waiting / not_before` 定时回执（`compact-idle`、overload 退避）的 `updatedAt`。

## 决策

1. **与 GC 共享单一原生任务真源。** `AgentClient` 暴露 `reportsSessionActivity()` 与 `getNativeWork()`（遵循 `sessionActivity` v1 replace 语义，未上报即空闲）。`MessageHandler.getNativeWork(sessionId)` 在 agent 声明协议时读 `client.getNativeWork()`，否则回退到 `sessionActivePresence.native.hasLateActivity(sessionId)`（30 秒被动窗口）。`SessionAutomationAuthority` 的 `SessionNativeActivity` 收窄为 `'idle' | 'running' | 'background'`，移除不可达的 `'unknown'` 分支。
2. **收窄空闲唤醒范围。** `onNativeWorkChanged` 归零时由 `MessageHandler` 触发 `SessionAutomationAuthority.notifyNativeIdle(sessionId)`。`AutomationLedger.wakeSessionBlocked(sessionId, now)` 走 `receipts_session` 索引仅查询 `WHERE session_id = ? AND state = 'blocked'`，且只唤醒 `reason` 属于 `SESSION_BUSY_BLOCK_REASONS` 且 `retryAt !== Number.MAX_SAFE_INTEGER` 的回执，同时递增 `capacityWakeRevision` 防止在途 `check()` 用 15 秒退避覆盖唤醒。配额恢复与 `not_before` 回执完全不受影响。
3. **自动交付阻塞三层外显策略。**
   - **忙碌类原因**（`SESSION_BUSY_BLOCK_REASONS`，包含 `target_input_pending`、`session_admission_busy`、`session_admission_blocked`）：保持 `outstanding`（正常进行中状态，不触发侧边栏提醒）。
   - **瞬态/未确认原因**（`execution_release_unconfirmed`、`guard:delivery_pr_unobserved`、`adapter_unavailable`、`permission_unconfirmed`、`target_permission_unconfirmed`、`target_unavailable`、`owner_unavailable`、`target_owner_unavailable`）：在交付检查点记录 `lastStep.blockedSince`，在 `DELIVERY_TRANSIENT_BLOCK_GRACE_MS`（60 秒）宽限期内保持进行中，超时后外显 `stalled`（`reason: 'request_blocked'` + `blockReason`）；恢复为 `outstanding` 时清除 `blockedSince`。
   - **确定性非忙碌拒绝**（`target_stopped` 映射为 `stopped`；`permission_denied`、`target_permission_revoked`、`target_archived` 等映射为 `request_blocked` + `blockReason`）：立即外显，不关闭自动交付开关。弹层中的阻塞原因展示本地化文案，避免暴露原始枚举码。
4. **Effect v4 生命周期归属与锁序。** `ManagedRunsService` 作为 scoped Layer 在 `ledger.close()` finalizer 之后获取，确保 LIFO 关闭时先终止受管子进程再关闭 SQLite；共享 dropping 唤醒队列在 `Layer.unwrap` 内创建，消除 `ManagedRuns.onExit` 与引擎启动的竞态。`DeliveryCoordinator.statusLock` 独立于引擎 `gate`，并在调用 `Automations.cancel` 前必须释放，避免 AB-BA 死锁。

## 备选方案

- **对未声明协议的 agent 保留 `native_activity_unobserved` 并加短超时。** 放弃：仍会给 Antigravity/Codex 的每次自动交付增加人为延迟，且与 GC、在线状态的原生任务定义分裂。
- **对所有非忙碌 `blocked` 回执不设宽限立即外显 `stalled`。** 放弃：短暂的 `execution_release_unconfirmed` 或 `guard:delivery_pr_unobserved` 会在正常交付过程中闪现 15 秒误报横幅和侧边栏红点。
- **原生空闲时唤醒会话下所有非终态回执。** 放弃：会破坏配额恢复“到点只刷新一次”的约定，并扰动 `waiting / not_before` 回执的活动排序。

## 取舍与局限

- **未声明协议 agent 的 30 秒被动窗口。** 不声明 Core `sessionActivity` v1 的 agent 没有静默后台 shell 的协议信号；超过 30 秒无 ACP 输出后 `hasLateActivity` 过期，`session.group.settled` 会判定为空闲。对自动交付而言只是正常排队下一步；对 `archive-after-merge` 而言，静默运行超过 30 秒的后台 shell 可能在尚未结束时被归档。彻底消除该限制需对应适配器声明 `sessionActivity` v1。
- **子 Tab 空闲唤醒。** `wakeSessionBlocked` 按当前空闲的 `session_id` 精确匹配；子 Tab 原生任务结束时，父会话上等待 `session.group.settled` 的回执最多等待 15 秒引擎周期，以避免在空闲回调中读取 Loro 会话树。

## 验证

- [automations.test.ts](../../../../apps/cli/src/automations/automations.test.ts) 纯单测覆盖忙碌原因、60 秒瞬态宽限与恢复重置、确定性拒绝立即外显，以及 `ledger.wakeSessionBlocked` 对忙碌、配额 `estimatedReset`、配额 `MAX_SAFE_INTEGER`、`waiting / not_before` 回执的精确筛选。
- [message-handler-acp-batching.test.ts](../../../../apps/cli/tests/message-handler-acp-batching.test.ts) 与 [workspace.test.ts](../../../../apps/cli/src/automations/workspace.test.ts) 真实边界集成测试覆盖协议/非协议 agent、空闲唤醒与阻塞状态发布。
- [session-continuation-note.test.tsx](../../../../packages/components/tests/session-continuation-note.test.tsx) 覆盖已本地化、未知与缺省 `blockReason` 的文案格式化。
