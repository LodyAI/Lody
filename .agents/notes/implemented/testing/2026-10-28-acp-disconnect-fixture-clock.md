# Control ACP disconnect ordering without stranding repo persistence

Status: implemented
Translation: current

[中文](2026-10-28-acp-disconnect-fixture-clock.zh.md)

## Abstract

The disconnected-prompt regression could pass its assertions and still time out while closing its offline repository. Its fake timeout clock captured a persistence yield chosen using real elapsed time, and switching clocks at cleanup discarded that callback. These cases now retain real timers throughout the repository lifetime and use explicit prompt/disconnect gates plus an explicit flush boundary to test both buffered and persisted notifications. Production behavior, existing assertions and the 30-second timeout remain unchanged.

## Decision and evidence

This applies the [native repo fixture clock decision](2026-10-27-native-repo-epoch-fixture-clock.md) to the disconnected-prompt cases. In locked `loro-repo` 0.25.0, `DocManager.drainDirtyDocs` uses `performance.now()` for its 5ms work budget and awaits `setTimeout(0)` when more work remains. The fixture faked timeout timers while leaving that monotonic clock real. `destroyRepoOnRealTimers` uninstalled the clock before `repo.destroy()`, losing an outstanding yield while the repository still owned its persistence promise.

A temporary, hoisted monotonic clock advancing 10ms on every read forced this branch before the SDK captured its clock. On the original tool-update case, timer stacks identified `DocManager.drainDirtyDocs`; cleanup reached repository destruction and then hit the unchanged 30-second timeout. [CI run 40630618794, first CLI attempt](https://github.com/LodyAI/Lody/actions/runs/40630618794/job/122625876973) records the same test timing out, but contains no stack proving which await stalled on that runner. The controlled reproduction proves the fixture defect, not that unobserved CI execution detail.

The test does not assert elapsed time, so it keeps real timers instead of trying to guess how far to advance a fake clock. The synthetic provider emits its notification, cancels the scheduled batch flush synchronously, and signals prompt entry. The test either leaves the notification buffered or explicitly awaits `flushACPUpdatesNow`, then releases the provider's disconnection. It awaits the execution and resource cleanup receipts; no sleep, polling, retry or increased timeout is used. The existing no-replay, unknown outcome, inactive execution and cleared presence assertions cover both orders for all three notification types. Batch-window cases retain their fake clock.

## Verification and limits

The complete file passed 20 consecutive independent Vitest processes (74 cases each, 1,480 cases total). The six gated disconnect variants also passed five independent processes with the injected 10ms clock; timer stacks confirmed the forced persistence yield. Removing only the real-timer fix under that same clock reproduced the 30-second cleanup timeout after execution, drain and assertions had completed. The injected clock and diagnostic logging were temporary experiments, not shipped test hooks.

The provider and Git boundary remain synthetic; lifecycle forwarding, history, execution finalization and offline repository cleanup remain real. Local repetitions and the injected-clock ablation validate this fixture path, not live providers or desktop packaging. No Effect ownership or migration boundary changes.
