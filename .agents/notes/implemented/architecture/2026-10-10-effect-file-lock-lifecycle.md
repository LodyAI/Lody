# Native Effect file locks and fair ownership handoff

Status: implemented
Translation: current
PR: [#1377](https://github.com/LodyAI/Lody/pull/1377)

[中文](2026-10-10-effect-file-lock-lifecycle.zh.md)

## Abstract

Promise lock queues and timer retries obscured cancellation and swallowed cleanup failures. A FileLocks Layer now owns FIFO admission and failed-release generations; scoped operations publish complete metadata through exclusive hard links, with one compatibility runtime for unmigrated callers. Clock/Schedule preserve contention deadlines and stale-lock policy. Independent cleanup waits are bounded while their raw OS operations remain owned, and acquisition-only retry preserves combined body/release failures. Linux tests verify implemented behavior; real Windows and unsupported filesystems remain unverified.

## Decision and evidence

The dependency and delivery owner remains the [migration roadmap](../../proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.md). This is the first unit after the merged process foundation (#1065, #1069, #1348), using the existing native `probePid` rather than executing its synchronous compatibility API.

The official `FileSystem` service and `NodeFileSystem.layer` supply I/O. `FileLockHost` fixes the pid and supplies a directory resolver evaluated for each operation; core tests may inject a fixed directory. Correction: the initial composition-time directory snapshot changed the old per-operation environment semantics and has been removed. Official sources checked against installed Effect and platform-node-shared 4.0.2 include `FileSystem.ts`, `NodeFileSystem.ts`, `Semaphore.ts`, `Deferred.ts` and `internal/effect.ts`.

Two tempting implementations failed inspection or experiments:

1. **Semaphore alone does not preserve strict admission order.** A retained behavioral test queues two callers, then has the holder immediately request the same lock again. On installed 4.0.2 it produced holder → newcomer → second → third. Ref atomically registers tickets and Deferred directly reserves the next owner's permission before a newcomer can register. Cancellation removes its own ticket without waiting on an earlier holder. The same test now requires holder → second → third → newcomer.
2. **Asynchronous `wx` plus metadata write exposes an empty file.** The old synchronous write did not yield in that window. Another process can classify the empty file as malformed and take over during an async write. A private scratch directory owns the fully written candidate; `FileSystem.link` exclusively publishes it at the unchanged `.lock` path. Failed preparation and interruption remove scratch. Metadata preparation stays interruptible under its candidate owner; only exclusive publication masks cancellation until its result and registered release can be joined. Behavioral tests cancel at both boundaries. No second spawn, collector or termination backend is introduced.

Each successful publication registers release before running the body. A release checks pid and token, reports `LockReleaseFailed` and retains the unresolved token in its owner. The next caller first retries that release. Failed scratch removal is retained too;
Layer finalization retries unresolved releases and surfaces an aggregate failure if
any remain. The acquisition timestamp is refreshed for each publication attempt,
so cross-process waiting does not shorten the existing stale-age window. Missing files are already gone; unreadable files fail rather than becoming stale. Malformed readable metadata and the 30-minute takeover policy remain unchanged. Reclamation rechecks observed content before removal. Correction: if the content changed and the file still exists, reclamation returns to scheduled backoff and the contention deadline; only confirmed absence or successful removal allows immediate retry. This preserves a cooperative file protocol, not a compare-and-unlink kernel primitive or an advisory-lock guarantee across expired-owner takeover.

## Preserved lock policy

Every operation resolves its directory using explicit `locksDir`, the current
`LODY_LOCKS_DIR`, then the current installation profile's `locks` directory
(including current `LODY_DATA_DIR`). The process-lifetime compatibility runtime
does not cache this resolution. Names replace characters outside
letters, digits, underscore and hyphen with underscore and append `.lock`.
Same-context acquisition of the same resolved path, including sanitized aliases
and child fibers, fails immediately; different names may nest.

The default 30-second `timeout` starts after local FIFO admission. It bounds only
contention on another file owner, not local queue waiting, body execution or
filesystem I/O. Retry delays start at 100 ms, grow by 1.5 and cap at two seconds;
a configured first delay is used unchanged even above the cap, with subsequent
delays capped. Negative or non-finite delays fail with `LockIoError` before
admission. Elapsed time is checked after a failed attempt, so a retry may overshoot
by its delay; this is not a strict I/O deadline.

A fresh pid belonging to this user keeps its lock. Missing or foreign-user pids,
malformed readable metadata and age over 30 minutes permit stale reclamation.
There is no heartbeat; expired live holders remain subject to the existing
takeover policy. Stale cleanup scans `.lock` files and `.lody-lock-*` scratch
directories without opening documents or starting work. Correction: normal
finalizers and the in-memory failed-release registry cannot collect crash
leftovers. Complete scratch metadata uses the same pid/age policy as locks, so
fresh live owners retain both published and waiting candidates. Missing or
incomplete metadata requires more than 30 minutes since the latest available
directory/owner mtime; unavailable mtimes retain the directory. Recheck owner
contents before recursive removal. This grace period protects active preparation
while allowing abandoned empty or partially written candidates to be collected.
Filesystem failures remain observable. Hard-link support is
required; unsupported filesystems fail visibly. This remains a cooperative
file protocol, not a kernel advisory lock or a crash transaction.

## Consumer boundary and deletion conditions

```text
FileLocks Layer instance (Ref registry + Deferred tickets)
  └─ admitted operation → owned candidate → exclusive publication
       └─ native body → verified release → FIFO handoff
fileLocksLegacy (one process-lifetime ManagedRuntime)
  ├─ withLock: worktree / cloudflared / Baguette Promise bodies
  └─ runPromise: catalog mutations at existing application entrypoints
```

Catalog mutations now compose `withFileLock` and expose FileLocks in their environment. Its Promise write queue and nested Effect execution are deleted. The short file read/modify/write body remains uninterruptible until its original filesystem Promises settle, preventing lease release while a write continues. This gives no crash recovery or cross-peer transaction guarantee. Catalog read caching still has its old Promise refresh logic and is not declared fully migrated.

The old Promise `withFileLock` export is replaced by the native Effect API. `cleanupStaleLocks` is native; no production caller needed a synchronous compatibility cleanup entry. The sole `fileLocksLegacy` object is deprecated and its name remains visible in imports and calls. Worktree and installation entrypoints retain their Promise workflows; their callbacks receive caller cancellation directly and are joined in the body before release. A callback ignoring its signal can delay cancellation. Finalizers do not wait on an unbounded Promise body. Remove the compatibility object and async-context bridge after these entrypoints use the daemon runtime; provide one FileLocks instance in that root so separate service instances do not accidentally charge local contention as cross-process waiting.

Native programs crossing fileLocksLegacy.runPromise use squashFileLockFailure over #1379's process-aware projection, preserving body failures and every file/process recovery lease. Direct Cause.squash loses the lease and is caught by the resource-state test. This adds no lock kernel or execution facade. The lock protects program execution; transferred failed process resources are not reported released.

## Verification

The owning suite retains real-file FIFO/reentry, cancellation, stale-generation,
crash-scratch and cross-process coverage. Earlier migration/review experiments
caught fourteen ownership mechanisms and four directory/reclamation mechanisms.
Current cleanup tests retain those behaviors and add independent bounded release,
original-operation recovery, successor protection and complete mixed failure.

Verification of the final assembled source against main 45753fe61e0427043f5cb14c91b33e996ca376b0:
workspace typechecks and type-aware lint pass with zero errors. Full pnpm check
reaches CLI testing: 3753 pass, one skip, and the previously reproduced Roost
signed-prefix 30-second timeout; no full green check is claimed. Supplemental
Shared passes 112 files / 1415 cases and Electron passes 216 cases. Eight related
CLI suites pass 124 cases; the shared lock/shell/process suites pass 89 cases.
Six temporary ablations are caught: removing the cleanup bound, reissuing an old
successful unlink, dropping file cleanup Cause, cancelling the shared producer
with a reader, discarding the original failed recovery owner, and declaring failed
shell release successful. Original/restored lock and shell suites pass 28/18 cases.
Scripts remain outside product code. Formatting, all five boundary guards and docs
check pass. Validation children isolate Git/PATH/temp/lock inputs; global Git
configuration, original checkout HEAD and dirty submodule gitlinks remain unchanged.
During validation main advanced with unrelated changes; these fixes retain the
explicit tested snapshot, not a claim of integration with that later head.

## Bounded cleanup and complete failure

Correction of the two reviewed gaps: each cleanup lease retains one raw filesystem
operation, and an independently interruptible waiter bounds each join to 5 seconds
using the captured Clock. The raw unlink remains masked and explicitly owned by
the lease and service registry: timing out its waiter does not cancel an OS deletion.
Only a settled failed attempt may be retried; a pending or completed successful
attempt is joined, never issued again against a reused path. A pending generation
blocks later local holders. Successful completion removes it from the registry;
failed Scope disposal transfers all cleanup leases through FileLockCleanupFailed,
so recovery remains possible after that Scope closed. Service disposal joins its
retained leases concurrently; the bound applies to each wait, not all filesystem
acquisition or cross-process reclamation operations.

The retry/backoff loop now surrounds only metadata/publication acquisition.
The body runs exactly once, and all body/release Cause reasons survive.
squashFileLockFailure retains the primary process-aware projection, full native
Cause, and every file cleanup lease. Worktree compatibility projections and fallback
guards also preserve these owners rather than turning failed release into absence.
The previous pattern, interruptible unlink plus timeout, was rejected because a
late OS deletion could remove a successor after its local waiter disappeared.

The owning real-file suite adds blocked-unlink cancellation, blocked Layer disposal,
recovery after Scope closure, successor protection, and combined body/file-release
failure. Deferred readiness and TestClock drive deadlines; no real sleeps are used.
Temporary ablation scripts remain outside the repository. Application/session
ownership and non-cooperative cross-process path replacement remain separate limits.
