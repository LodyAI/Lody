# Retryable unreleased Session resources

Status: implemented
Translation: current

[中文](2026-10-15-unreleased-session-resources-retry.zh.md)

## Abstract

After 0.105.0, many turns failed before their prompt with
`turn_pre_prompt_failed` and "Session … resources were not released". Version
0.105.0 began surfacing process trees that could not be proven gone after
SIGKILL, which is correct. However, a failed preparation retirement then kept its
rejection forever, so every later create of that Session failed until the daemon
restarted. Retirement now still fences replacement, but the next caller retries
it. Two cases that were not real survivors are now accepted: a process group with
only zombies left, and a Windows root that ended even though `taskkill` reported a
failure. A tree that is really alive still fails.

## Problem

`Session.terminate` throws an `AggregateError` when a process tree outlives its
bounded SIGKILL wait. It keeps the sandbox, handles and credentials for recovery
([release failure decision](2026-10-10-effect-process-release-failure.md)).
In 0.104.0 the same sandbox failure was only logged at debug level.

The preparation pool is where the failure became sticky. A turn whose
configuration missed a warm preparation awaited `claim.cleanup`. A resume awaited
`discard`. When the preparation's forced termination failed, `expire()` stored the
rejected promise in `retiring` and removed it only on success. Every later claim
miss, discard, or replacement preparation received that same rejection. Nothing
ever retried the release, even after the tree had exited.

Two common termination failures were not survivors at all:

- **Orphaned zombies.** An orphan is reparented to a reaper that never waits; the
  typical case is the daemon running as a container's PID 1. The orphan keeps its
  process group signalable: on Linux `kill(-pgid, 0)` succeeds, and on macOS it
  returns `EPERM`. Zombies hold no resources, and no signal ends them.
- **Windows partial failures.** `taskkill /T /F` exits with status 1 when one
  descendant refuses, after it has already ended the root. `terminateTree` failed
  on the delivery error at once, without checking the root.

## Decision

- `SessionPreparationService` keeps one `Retirement` per Session. A successful or
  in-flight attempt is shared. A failed attempt still fences the Session; the next
  `claim`, `discard`, `start`, expiry or shutdown starts a new attempt over the
  predecessor chain and the record's resource. The Session manager's preparation
  `cleanup` is retryable (a Session or sandbox starts a fresh termination; a failed
  sandbox cleanup uses `recoverCleanup`). Creation rollback failures carry that
  retry on `SessionPreparationCleanupError`. The first attempt still reports the
  original failure.
- `terminateTree` treats a failed SIGKILL delivery as unproven, not as fatal: it
  waits the bounded `killWaitMs` and fails only if the tree is still alive. The
  original delivery error is kept as the failure.
- `ProcessTree.hasRunningMembers` is an exact, slow member scan. It runs only for
  a tree still alive `MEMBER_SCAN_DELAY` (250 ms) after a signal, and once more
  when the grace or SIGKILL wait expires; a healthy tree is gone before either.
  POSIX groups implement it through `NodeProcessApi.listProcessGroup`:
  `/proc/<pid>/stat` on Linux, and one bounded `ps -axo pid=,pgid=,stat=`
  elsewhere. Only a group whose visible members are all zombies counts as gone. An
  unavailable scan, a running member, or an empty scan while the kernel still
  reports the group keeps the failure.
- `Session.terminateOnce` ends the per-process trees and the sandbox concurrently.
  The sandbox tracks the same process groups, so ending them in turn doubled every
  bounded wait on a survivor: the reported log shows ten seconds before each failure.

## Alternatives

- **Restore the 0.104.0 behavior of logging and continuing.** Rejected. A
  successor could contend with a live agent, port or lock, which the
  release-failure decision forbids.
- **Drop the fence after one failure.** Rejected. It would allow workspace reuse
  while the old tree may still run, against the
  [preparation handoff](../../implemented/simplification/2026-10-16-remove-draft-session-preparation.md).
- **Reap the orphans ourselves.** Rejected. Becoming a subreaper or calling
  `waitpid(-1)` would take children owned by Node's own handles.

## Trade-offs and limits

A Session whose tree is truly unkillable fails each turn after one bounded retry.
That costs about five seconds per turn instead of an instant stale rejection; the
benefit is recovery as soon as the tree is gone. Classifying a zombie-only group
costs about `MEMBER_SCAN_DELAY` and one scan, after which the registry forgets the
tree. On macOS that scan is a synchronous `ps` of up to two seconds, paid only by a
tree that outlives the delay. Under
`hidepid`, members owned by another user are invisible. A group whose only visible
members are zombies would therefore be accepted even if a foreign process remains.
We cannot signal such a process anyway. The resident Session map is unchanged:
a non-preparation Session whose termination failed keeps its existing recovery
path.

## Verification

- `packages/shared/tests/process.test.ts` uses the fake process table and the
  TestClock. It covers a zombie-only group ending at `MEMBER_SCAN_DELAY` after
  SIGKILL, and within the grace period without SIGKILL; an unlisted group still
  failing; a Windows root that ended despite a partial `taskkill` failure; and a
  Windows root that survived.
- `session-terminate-cleanup.test.ts` shows the sandbox is already terminating
  while the agent tree is waited on. It fails against the sequential order.
- `session-preparation-service.test.ts` covers retried rollback and disposal
  failures, which still fence until a retry succeeds.
- `session-manager.test.ts` drives a failed preparation release followed by a
  successful cold create. That test fails against the previous service.
- A one-off local probe confirmed that the Linux `/proc` scan reports a real
  zombie and a live member. The probe is not committed because it needs real
  timing.
- macOS `ps` parsing and real Windows `taskkill` exit codes were not exercised on
  those hosts.
