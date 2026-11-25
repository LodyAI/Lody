# Automation native-activity observation, idle wakes, and blocked delivery visibility

Status: implemented
Translation: current
PR: [#3353](https://github.com/LodyAI/Lody/pull/3353)

[中文](2026-11-25-automation-native-activity-and-blocked-delivery.zh.md)

## Abstract

Auto delivery stalled silently on agents that do not advertise Core `sessionActivity` v1 (such as Antigravity and Codex): `session.group.settled` treated any live process without an activity update as `native_activity_unobserved` until idle GC killed the process 20 minutes later, while the delivery policy folded all non-`target_stopped` blocked receipts into the in-progress state. `MessageHandler.getNativeWork` now serves as the single native-work contract for both GC and automations, honoring `sessionActivity` v1 replace semantics when advertised and falling back to `SessionActivePresence` 30-second passive `lateActivity` otherwise. Native idle wakes narrow strictly to `state = 'blocked'` session-busy receipts, and Auto delivery surfaces durable non-busy blocks immediately while giving transient/unconfirmed blocks a 60-second grace period. For non-reporting agents, a background shell that stays silent for over 30 seconds is intentionally treated as idle; this is harmless for Auto delivery and an accepted trade-off for `archive-after-merge`.

## Problem

1. **Lifecycle mismatch on `session.group.settled`.** `SessionAutomationAuthority` previously treated any live agent without a `_lody/session/activity_update` notification as `unknown` (`native_activity_unobserved`). For agents that never advertise `sessionActivity` v1, every Auto delivery step (such as the final merge request after CI passed) blocked for up to 20 minutes until idle GC tore down the process, and even reporting agents that had not yet emitted an update violated the replace semantics recorded in [GC respects native agent work](2026-10-18-gc-respects-native-agent-work.md).
2. **Silent blocked state.** `policies/delivery.ts` mapped every `blocked` receipt except `target_stopped` to `outstanding`, so the conversation chip kept displaying "Merging" indefinitely whenever admission was blocked for permission, owner, or release reasons.
3. **Over-broad wake hazards.** Waking every non-terminal receipt on a Session when native work goes idle would pull quota-recovery receipts off their `estimatedReset` deadline (triggering extra provider refreshes) and bump `updatedAt` on `waiting / not_before` timers (`compact-idle`, overload backoff).

## Decision

1. **Single native-work contract shared with GC.** `AgentClient` exposes `reportsSessionActivity()` and `getNativeWork()` (returning `null` when idle under `sessionActivity` v1 replace semantics). `MessageHandler.getNativeWork(sessionId)` checks `client.getNativeWork()` when the agent advertises `sessionActivity` v1, and otherwise falls back to `sessionActivePresence.native.hasLateActivity(sessionId)` (30-second passive window). `SessionAutomationAuthority` therefore sees `'idle' | 'running' | 'background'` with no unreachable `'unknown'` branch.
2. **Scoped idle wake.** When `onNativeWorkChanged` clears to `null`, `MessageHandler` notifies `SessionAutomationAuthority.notifyNativeIdle(sessionId)`. `AutomationLedger.wakeSessionBlocked(sessionId, now)` queries `WHERE session_id = ? AND state = 'blocked'` (using `receipts_session`), wakes only receipts whose `reason` is in `SESSION_BUSY_BLOCK_REASONS` and whose `retryAt !== Number.MAX_SAFE_INTEGER`, and increments `capacityWakeRevision` so an in-flight `check()` cannot overwrite the wake with a 15-second backoff. Quota recovery and `not_before` receipts are untouched.
3. **Three-tier blocked Auto delivery visibility.**
   - **Busy reasons** (`SESSION_BUSY_BLOCK_REASONS`, including `target_input_pending`, `session_admission_busy`, and `session_admission_blocked`): remain `outstanding` (in-progress step label, no sidebar alert).
   - **Transient/unconfirmed reasons** (`execution_release_unconfirmed`, `guard:delivery_pr_unobserved`, `adapter_unavailable`, `permission_unconfirmed`, `target_permission_unconfirmed`, `target_unavailable`, `owner_unavailable`, `target_owner_unavailable`): record `lastStep.blockedSince` in the delivery checkpoint and remain in-progress for `DELIVERY_TRANSIENT_BLOCK_GRACE_MS` (60 seconds) before surfacing `stalled` (`reason: 'request_blocked'`, `blockReason`). Recovery back to `outstanding` clears `blockedSince`.
   - **Durable non-busy denials** (`target_stopped` -> `stopped`; `permission_denied`, `target_permission_revoked`, `target_archived`, etc. -> `request_blocked` + `blockReason`): surface immediately without disabling Auto delivery. The popover formats `blockReason` via the localized label rather than showing raw enum strings.
4. **Effect v4 runtime ownership and lock order.** `ManagedRunsService` is a scoped Layer acquired after the `ledger.close()` finalizer so LIFO teardown stops child processes before closing SQLite; a shared dropping wake queue is created in `Layer.unwrap` so `ManagedRuns.onExit` never races engine startup. `DeliveryCoordinator.statusLock` stays separate from the engine `gate` and must be released before calling `Automations.cancel` to prevent AB-BA deadlocks.

## Alternatives

- **Keep `native_activity_unobserved` for non-reporting agents and rely on a short timeout.** Rejected: it would still add artificial latency to every Auto delivery step on Antigravity/Codex and diverge from GC's and presence's existing definition of native activity.
- **Surface every non-busy `blocked` receipt immediately without a grace window.** Rejected: momentary `execution_release_unconfirmed` or `guard:delivery_pr_unobserved` passes would flash a false "stalled" banner and sidebar attention dot for 15 seconds during normal operation.
- **Wake all non-terminal receipts on native idle.** Rejected: breaks the one-refresh-at-reset invariant for `recover-capacity` receipts parked at `estimatedReset` and perturbs `updatedAt` ordering on `waiting / not_before` receipts.

## Trade-offs and limits

- **30-second passive window on non-reporting agents.** Agents that do not advertise Core `sessionActivity` v1 have no protocol signal for silent background shells. After 30 seconds without ACP output, `hasLateActivity` expires and `session.group.settled` treats the session as idle. For Auto delivery this only queues the next step normally; for `archive-after-merge`, a silent background shell older than 30 seconds can be archived while still running. Closing that gap requires those adapters to advertise `sessionActivity` v1.
- **Child-tab idle wake.** `wakeSessionBlocked` matches `session_id = ?` on the idle Session; if a child tab finishes native work while a root Session waits on `session.group.settled`, the root receipt waits up to the 15-second engine cap rather than reading the Loro session tree inside the idle callback.

## Verification

- Pure unit tests in `apps/cli/src/automations/automations.test.ts` cover busy vs. 60-second transient grace vs. immediate durable stall transitions, `blockedSince` reset on recovery, and `ledger.wakeSessionBlocked` selectivity across busy, quota `estimatedReset`, quota `MAX_SAFE_INTEGER`, and `waiting / not_before` receipts.
- Real-boundary integration tests in `apps/cli/tests/message-handler-acp-batching.test.ts` and `apps/cli/src/automations/workspace.test.ts` drive `MessageHandler`, `SessionActivePresence`, `SessionAutomationAuthority.settled()`, and `createWorkspaceAutomationsLegacy` across reporting and non-reporting agents, idle wakes, and blocked delivery status publication.
- UI label tests in `packages/components/tests/session-continuation-note.test.tsx` verify localized, unknown, and omitted `blockReason` formatting.
