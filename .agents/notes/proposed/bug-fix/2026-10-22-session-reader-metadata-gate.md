# Bound the session-reader metadata gate

Status: proposed
Type: bug-fix
Translation: current
Issue: [#1796](https://github.com/LodyAI/Lody/issues/1796)

[中文](2026-10-22-session-reader-metadata-gate.zh.md)

## Abstract

Opening a session with no usable local state — typically one created on another
device — pends forever when the workspace Meta binding never restores: the
renderer-reader identity gate had no timeout, and the store cache reuses a
pending create promise, so even leaving and re-entering the session could not
retry. The gate is now bounded by the Meta first-sync budget and rejects with a
descriptive `TimeoutError`; a failed create is evicted, so re-entering retries.
Two smaller liveness defects in the same gate are fixed with it: a torn-down
binding's rejected wait no longer strands a recorded binding change, and a Roost
identity missing its owning machine now registers the binding wait instead of
returning without any wait at all.

## Defects and change

`awaitSessionReaderMetadata` (`create-workspace-runtime.ts`) resolves only when
the session-plane Meta binding reaches `restored` and the catalog identity
(`historyBackend`, `machineId`) is known; it previously rejected only on runtime
dispose or session deletion. A stalled Meta room (sync stall, sign-out, offline)
therefore produced a permanent skeleton with no error.

- **Bounded wait.** A 120-second timer (the existing Meta first-sync budget, so
  a legitimate cold restore never loses the race) finishes the gate with a
  `TimeoutError`. `createSessionStore` already unloads the doc and the managed
  store cache already evicts a failed create, so re-entering the session retries
  against whatever state the Meta room reached — no new ownership is introduced.
- **Rejected binding wait re-evaluates.** `waitFor({ phase: 'restored' })`
  rejects when its binding is torn down (transport re-attach). The status change
  is recorded in `bindingChanges` while the wait is still registered and the
  rejection handler only removed the watch, stranding the change until an
  unrelated external wake. The rejection path now mirrors the success path and
  re-evaluates when a change was recorded, so the replacement binding gets a
  fresh wait. An abort at finish still settles first, so no re-registration
  follows a completed gate.
- **Incomplete Roost identity falls through.** `historyBackend: 'roost'`
  without `machineId` returned before any binding wait was registered. It now
  falls through to the shared wait/restore flow; restoration completion
  re-checks the identity, and the timeout bounds truly absent metadata.

## Verification and limits

Two regressions join `create-workspace-runtime-meta-recovery.test.ts` against
the real `LoroRepo` with gated transport sync:

- a cold open whose Meta binding never restores rejects with `TimeoutError`
  after the budget (fake timers), unsubscribes its observation, evicts the
  failed create, and a re-acquire after restore succeeds;
- a binding whose restored-phase wait rejects after a recorded status change
  registers a second wait and completes the open when sync resumes, with no
  further metadata events. Both fail without the source change (the first hangs
  until the test timeout).

Full `packages/components` suite: 596 files / 5912 tests pass; `tsc --noEmit`
passes. Not covered: the renderer still maps a rejected open to a console-only
error (skeleton remains until the session is re-entered); surfacing an explicit
error state with retry is deliberate follow-up UI work. The Meta stall trigger
itself is out of scope; see the streams read-loop note for its upstream fixes.
