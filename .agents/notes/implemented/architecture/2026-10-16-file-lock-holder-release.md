# File-lock holders keep their result when release is slow

Status: implemented
Translation: current

[中文](2026-10-16-file-lock-holder-release.zh.md)

## Abstract

On a loaded daemon, session starts failed after their worktree was already ready.
The per-repository file lock could not confirm deleting its lock file and scratch
directory within two consecutive five-second waits, and that cleanup failure
replaced the body's successful result. The lock service already retained the
unfinished deletion and kept successors out until it completed, so failing the
holder added no safety. The holder now waits once, for at most five seconds, and
keeps its body's result. The service keeps owning slow or failed deletions, the next
local holder joins them within its own acquisition deadline, and disposal still
reports anything unresolved. Only a replaced lock generation fails the holder, as
`LockOwnershipLost`. Why a small unlink took longer than five seconds is still
unproven.

## Problem

Three turns on one Linux daemon failed this way on 2026-10-16. Each log shows
`Worktree ready` or `Worktree already exists` from inside `createWorktree`, then
14–19 seconds of silence, then `FileLockCleanupFailed` thrown by
`squashFileLockFailure` inside `SessionManager.createSessionInner`. New Sessions
reported `turn_pre_prompt_failed`; a restored Session reported
`session_restore_failed`. Sending the same message again succeeded each time. The
running build predated
[preparation cleanup diagnostics](../bug-fix/2026-10-16-preparation-cleanup-diagnostics.md),
so the user saw an empty reason. That note recorded the same two-wait signature
during preparation retirement and left this question open.

The old contract ran release as the body's finalizer. Each cleanup lease (the lock
file and the scratch directory) waited up to five seconds. A timeout became
`LockReleaseFailed`, and `acquireUseRelease` combined it with the body's exit, so a
successful body produced a failure and its value was discarded. Two of the three
failures coincide with logged event-loop stalls of 5–7 seconds. On such a host a
five-second timer can fire before an already finished unlink is delivered, but the
log cannot prove that order.

The failure did not protect anything. The raw deletion kept running under the
lease, the service registry kept it, and the next local holder joined it before
running a body. Other processes saw a lock owned by a live pid and backed off.

## Decision

- **Holder.** After the body, the holder waits for its lock file and scratch
  directory under one shared five-second bound. If a deletion is still pending
  when the bound runs out, the holder only polls it and does not schedule another
  timer. A deletion that times out or fails stays registered with the service. The
  holder returns the body's exit unchanged.
- **Successor.** A local successor joins every retained deletion within its own
  acquisition deadline (`timeout`, measured from local admission), not a separate
  five-second bound. The same deadline then covers cross-process contention. A
  settled failure is retried once before the body runs. The successor fails with
  `LockReleaseFailed` only if the deletion is still unresolved at its deadline or the
  retry fails again.
- **One wait per wedged deletion.** That deadline is charged to the deletion attempt, not to
  each successor. FIFO admission would otherwise make a wedged unlink cost every queued
  holder (all Session starts for a repository) a full deadline in turn, and blame
  unrelated Sessions for it. After one successor has waited its whole deadline for a
  still-pending deletion, later successors only poll it and fail fast until a new attempt
  starts. A settled failure is not wedged and stays retryable.
- **Lost ownership.** Release reads the lock file before deleting it. If another
  generation replaced ours, nothing of ours remains to delete. The holder fails with
  `LockOwnershipLost`, because its body did not run exclusively. The lease completes,
  so later callers contend for the new owner normally instead of being fenced by a
  retry that can never succeed. Previously every later caller failed with
  `LockReleaseFailed` until the replacement disappeared.
- **Disposal.** Unchanged: it joins retained leases with the five-second bound and
  dies with `FileLockCleanupFailed`, which carries recovery leases.
- **Legacy consumers.** The worktree manager rethrows `LockOwnershipLost` unchanged
  and keeps it out of fallback catches, as it already did for `LockReleaseFailed`.

## Behavior contract

| Question         | Answer                                                                                                                                                                            |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trigger          | The body finishes, fails or is interrupted while holding the lock.                                                                                                                |
| Owner            | The `FileLocks` service instance owns each raw deletion through its lease and registry. The holder owns only its bounded wait.                                                    |
| Cancellation     | Interrupting the holder ends its wait. The masked raw deletion keeps running under the lease.                                                                                     |
| Handoff          | A local successor runs its body only after every retained deletion has completed. Another process acquires only after the file is gone, or after the existing stale-owner policy. |
| Failure recovery | The next local holder retries settled failures. Disposal reports leftovers with recovery leases. There is no background retry driver.                                             |

## Alternatives

- **Keep failing the holder and retry the whole Session start.** Rejected as the
  fix. The work had already succeeded, and one failed attempt had spent three minutes
  waiting for the repository lock and creating the worktree. Retrying start-up is
  reserved for errors that are actually transient.
- **Do not wait in the holder at all.** Rejected. A normal fast return would leave
  the lock file and scratch directory behind for a moment, and a short-lived command
  could exit before its unlink landed. The bounded wait keeps the common case clean
  and only defers the slow case.
- **Raise the five-second bound.** Rejected. It moves the threshold without
  changing who owns the failure. A long enough stall would still fail a finished
  operation.

## Trade-offs and limits

- A holder can return while its lock file still exists, but only when deletion
  exceeds the bound. Local successors wait for it and other processes back off. A
  process that exits in that window leaves a file owned by a dead pid, which the
  existing reclamation removes.
- A retained failure surfaces at the next holder or at disposal, not at the
  original call. A persistent permission error still fails the next holder until
  fixed, as before. No background driver retries it.
- `LocalWorktreePreparation` still fails a published local-project preparation when
  its scratch cleanup times out. That is the same pattern in a different owner and
  is not changed here.
- This change neither identifies nor removes the cause of slow deletions.
  Event-loop starvation from synchronous work on the daemon's main thread is the
  leading hypothesis.

## Verification

`packages/shared/tests/file-lock.test.ts` (29 cases) uses real files, injected
clocks and explicit readiness signals:

- A holder whose lock-file and scratch deletions both stall returns its value after
  one five-second bound. A queued successor does not run until the original unlink
  completes inside its own deadline.
- An interrupted holder returns an interruption. A successor whose deadline expires
  while the unlink is pending fails with `LockReleaseFailed` carrying the original
  lease, and that lease never deletes a later generation.
- A failed release keeps the body's value, fails the next holder before its body
  runs, and recovers once deletion is allowed. Scratch failures behave the same.
- A failing body reaches native and Legacy boundaries as its own error, and the
  retained deletions are retried by the next holder.
- A replaced generation yields `LockOwnershipLost` and leaves the replacement
  untouched. After it disappears, the next holder succeeds.
- Disposal still reports a pending deletion with a recovery lease.

Ablations: restoring the holder failure on `LockReleaseFailed` fails five cases,
including the incident regression. Giving the scratch directory its own
five-second wait fails the incident regression. Linux only. Other platforms and a
real starved event loop were not exercised.
