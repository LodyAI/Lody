# Keep mobile mention expansion ready across live catalog updates

Status: implemented
Translation: current

[中文](2026-11-26-mobile-mention-catchup-readiness.zh.md)

## Abstract

Sending the first turn of a new mobile conversation with an `@session:<id>` reference intermittently failed with `mention_expansion_failed` because `createSession` appended to `${workspace}:meta`, waking the `meta` long-poll and marking `'meta'` unhealthy across a forced `setTimeout(0)` checkpoint yield right when `sendTurn` read `mentionCatalog`. The shared mobile `cloud-runtime` now resets its 12 ms frame-import slice after idle network waits, updates catalog projections before clearing `unhealthy`, waits up to 3 seconds in `mentionCatalog` only for active error-free stream catch-ups, falls back to live `meta` Flock rows before catalog flush, and skips code blocks/spans and letterless `$` tokens during skill expansion. Offline or failed streams still clear catch-up state immediately and reject without waiting; live multi-device burst timing remains verified through deterministic synthetic transports rather than cloud load.

## Decision

- **Reset the import slice after network idle (`catalog-sync.ts`, `index.ts`)**: `catalogImportCheckpoint` previously kept one timestamp from initial bootstrap, so every post-long-poll frame saw `>= 12 ms` elapsed and yielded a macrotask before importing a single byte while `watch(mode)` had already added `mode` to `unhealthy`. Resetting the slice clock before each post-read import batch and marking `unhealthy` on `upToDate: true` frames only if a `>= 12 ms` slice actually yields keeps routine single-turn live updates synchronous and healthy.
- **Update projections before clearing `unhealthy` (`index.ts`, `handlers/mentions.ts`)**: `watch(mode)` scans `flock` and writes `catalogs.set(mode, ...)` before deleting `unhealthy` or waking `resumeAcceptedInputs`. `getMentions` also falls back to scanning `state.metaReplica.flock` when a newly created session is not yet in `catalogs.get('meta')`, and accepts `group:` project IDs on new-chat mention queries.
- **Scoped, bounded wait for error-free catch-up (`index.ts`, `handlers/mentions.ts`)**:
  - *Trigger*: Multi-page incremental bursts (`!next.upToDate`) or `>= 12 ms` frame-import yields on `meta` or a referenced `machineId` concurrent with `getMentions` during `sendTurn` or `@` picker queries.
  - *Spread*: Scoped strictly to `getMentions` while `state.unhealthy.has(mode)` and `state.catchingUp.get(mode)` holds an active error-free catch-up promise; `publishNow` and other callers retain existing `unhealthy` semantics.
  - *Recovery and dependencies*: `watch(mode)` owns one shared `Promise<void>` per mode in `state.catchingUp`, resolved on `upToDate` completion and cleared immediately on any `retrySessionRead` error, `catch`, `finally`, or watcher `abort`, bounded by a 3-second `Promise.race` timer that is cleared on completion.
  - *Base behavior and hazard*: Previously `getMentions` rejected immediately with `metadata_not_ready` / `machine_unavailable` (mapped by `expandMentions` to definite `mention_expansion_failed`), forcing manual Retry on healthy bursts. Waiting only on error-free catch-up preserves fast offline rejection and re-verifies workspace, replica, and `unhealthy` state after waking, so unconfirmed data never becomes authoritative.
- **Reject prose false positives for `$skill` (`mention-expansion.ts`)**: `referencePattern` skips fenced code blocks and inline code spans (matching `protocol/message-references.ts`) and requires at least one Unicode letter in `$` tokens so currency amounts (`$100`, `$5.99`) and positional shell tokens (`$1`) never trigger Machine RPC skill scans.
- **Outbox `metadata_not_ready` parity (`OutboxDispatcher.swift`, `SessionOutbox.kt`)**: Background Outbox sends retain `waiting` on `metadata_not_ready` alongside `session_not_ready`, and iOS maps `metadata_not_ready` / `session_not_ready` to localized `native.runtime.sessionNotSyncedRetry` when surfaced on a foreground send.

### Rejected alternatives

- **Skip `state.unhealthy` checks in `getMentions` for `@session`**: Rejected because `mentions.md` requires send-time reference checks against healthy workspace metadata and `agent-roles.test.mjs` pins `mention_expansion_failed` when `meta` is genuinely unhealthy.
- **Treat all `mention_expansion_failed` replies as silent background retries in Outbox**: Rejected because a deleted `@role:<id>` or offline computer is a definite user-visible failure that must keep the draft retryable rather than spinning silently.

## Verification

- iOS runtime & Outbox: `apps/mobile/ios/apps/ios/tests/native/mentions.test.mjs`, `apps/mobile/ios/apps/ios/tests/native/agent-roles.test.mjs`, `apps/mobile/ios/apps/ios/verification/kit/outbox/main.swift`.
- Android mirrored runtime & unit suite: `apps/mobile/android/runtime/test/catalog-budget.test.mjs` and `:app:testDebugUnitTest`.
- Limits: Exercised against deterministic synthetic Streams transports and host unit harnesses; live authenticated cloud bursts on physical devices were not re-run here.
- Pull requests: [LodyAI/lody-ios#189](https://github.com/LodyAI/lody-ios/pull/189), [LodyAI/lody-android#63](https://github.com/LodyAI/lody-android/pull/63).
