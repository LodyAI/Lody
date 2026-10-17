# Diagnosable preparation cleanup failures

Status: implemented
Translation: current

[中文](2026-10-16-preparation-cleanup-diagnostics.zh.md)

## Abstract

A turn sometimes failed before its prompt with "Session preparation cleanup
failed: " followed by nothing, and the daemon log gave no further reason. Two
gaps hid the cause. The file-lock errors that worktree removal can raise had
empty messages, and a warm preparation that the turn could not claim was
discarded without a log line. Both now explain themselves: lock errors name the
lock path and the underlying cause, and a missed claim logs its reason and the
names of the mismatched settings. Cleanup behavior is unchanged. Whether a
transient lock-release timeout should still fail the turn is left open.

## Problem

One failing turn on a loaded Linux daemon shows the sequence. The turn arrived
with settings that did not match its warm preparation, so the claim missed and
the cold start awaited the preparation's retirement, as the
[preparation handoff](../../implemented/simplification/2026-10-16-remove-draft-session-preparation.md)
requires. Retirement killed the agent and removed the prepared worktree and
branch under the per-repository file lock. About ten seconds after the branch
was deleted, retirement rejected with an empty cause, and the turn failed after
waiting 75 seconds.

Ten seconds matches two consecutive release waits of `FILE_LOCK_CLEANUP_MS`
(five seconds each): one for the lock file and one for the lock's scratch
directory. `LockReleaseFailed`, `LockIoError` and `FileLockCleanupFailed` are
`Data.TaggedError`s without a `message`, and an Effect 4.0.2 tagged error with
no message field has `message === ""`. `SessionPreparationCleanupError` formats
its cause by message, which produced the empty suffix. The lock directory was
clean afterwards, so the unlink did complete eventually, only later than the
bounded wait. The same window shows event-loop stalls and slow Git commands.
Why a tiny unlink took more than five seconds is not proven by the log.

The claim miss itself was silent. `SessionManager` awaited `claim.cleanup` with
no record of whether the requester, claim key, readiness or compatibility had
differed, so the investigation could only guess which setting changed.

## Decision

- `LockIoError`, `LockReleaseFailed` and `FileLockCleanupFailed` define a
  `message` getter, as `LockTimeout` and `LockReentrant` already did. It names
  the path and a one-line cause, squashing an Effect `Cause` (for example
  "Operation timed out after '5s'"). `FileLockCleanupFailed` lists the primary
  failure followed by each distinct release failure. The structured fields and
  cleanup leases are unchanged.
- `SessionPreparationService.claim` returns a `reason` with every miss:
  `absent`, `requester`, `claim-key`, `not-ready`, `incompatible` or
  `compatibility-error`.
- `SessionManager` logs every miss except `absent` at debug level. An
  `incompatible` miss lists the differing setting names, such as
  `configOptionValues.permission_mode` or `launch.env`, and never their values,
  because the launch half carries the agent environment.

## Alternatives

- **Log the full `Cause` with `Cause.pretty`.** Rejected for the error message:
  it includes stacks and repeats in every wrapper. Callers that need the full
  `Cause` still have it on the error.
- **Retry or ignore a release timeout during retirement.** Deferred. It would
  change the guarantee that a failed release fences same-Session replacement
  ([retirement retry](2026-10-15-unreleased-session-resources-retry.md)) and
  needs its own decision.
  Later change: a lock-release timeout no longer fails the holder; see
  [holder release](../architecture/2026-10-16-file-lock-holder-release.md).

## Trade-offs and limits

Messages include absolute lock paths under the Lody data directory. They are
local diagnostics and the same paths already appear in debug logs. A miss
adds one debug line per affected turn. The root cause of the slow unlink
remains unverified; the new messages are meant to confirm or refute it the
next time it happens.

## Verification

- `packages/shared/tests/file-lock.test.ts` asserts the timeout message of a
  bounded release failure and the combined message of a body failure plus
  two release failures.
- `session-preparation-service.test.ts` asserts the `absent`, `requester`,
  `claim-key`, `incompatible` and `compatibility-error` reasons.
- `session-manager.test.ts` asserts that a changed `permission_mode` option
  logs its name but not its value.
- The full `session-manager.test.ts` file timed out on this machine both with
  and without this change. The preparation tests were run on their own.
