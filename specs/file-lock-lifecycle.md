# File lock lifecycle

Status: draft
Translation: current

[中文](file-lock-lifecycle.zh.md)

A worktree operation or runtime installation must hold its named lock until its work and cleanup settle. Independent daemon processes coordinate through a real file; callers sharing the FileLocks service queue in admission order.

## Ownership and cancellation

`FileLocks` is provided once per application owner through a Layer. The operation owns the acquired file and publishes fully written metadata using an exclusive hard link. The lock directory must support hard links; unsupported filesystems fail visibly. Metadata preparation is interruptible under the candidate owner. Only exclusive publication masks cancellation until its result can register release; callers await that cleanup. An acquire-use-release boundary registers release before running the body. Cancellation removes a local waiting ticket immediately; cancelling cross-process retry stops that waiter permanently. A cancelled or failed native body releases before the caller completes and before the next admitted body starts.

A failed release is `LockReleaseFailed`, even after a successful body. The service retains the unresolved generation and retries its release before a later operation can run. Release verifies both pid and acquisition token, so an old owner cannot remove a replacement. Read/permission errors are `LockIoError`, not evidence that a lock is stale. Missing files are already released. Failed scratch cleanup is retained and retried too;
Layer finalization reports unresolved cleanup as failure, never successful disposal.

The single `fileLocksLegacy` facade owns a process-lifetime compatibility runtime. Its `withLock` accepts Promise callbacks and forwards the caller's AbortSignal; the body retains its lease until the original Promise settles. A callback that ignores cancellation can delay the result. This boundary does not provide native structured cancellation to an unmigrated workflow. Its `runPromise` supplies the same service to native programs executed by existing Promise application entrypoints. Remove the facade after worktree, installation and catalog entrypoints use the application runtime.

## Preserved policy

- Directory precedence: explicit `locksDir`, `LODY_LOCKS_DIR`, then the installation profile's `locks` directory.
- Names replace characters outside letters, digits, underscore and hyphen with underscore, followed by `.lock`.
- Same-context acquisition of the same resolved path fails immediately, including sanitized aliases and child fibers. Different names may nest; locks are not reentrant.
- A fresh pid belonging to this user keeps its lock. Missing or foreign-user pids, malformed metadata, and age over 30 minutes make a lock stale. There is no heartbeat; operations must stay below the existing age limit. Expired live holders are subject to takeover as before.
- The default `timeout` is 30 seconds and starts after local admission. It bounds only contention on another file owner, not local FIFO waiting, body execution or filesystem I/O. Retry delays begin at 100 ms, grow by 1.5 and cap at 2 seconds. A configured first delay is used unchanged even above the cap; only subsequent delays are capped. Negative or non-finite delays fail with LockIoError before admission. As before, a failed attempt checks elapsed time and the next retry can overshoot the deadline by its delay; this is not a strict wall-clock deadline on I/O.
- Stale cleanup inspects `.lock` files without opening documents or starting work. Filesystem failures now surface rather than disappearing as success.

## Evidence and limits

Implementation: `packages/shared/src/node/file-lock.ts`. Native tests use real local files, Deferred readiness and TestClock; a real child process verifies mutual exclusion in both directions. CLI tests cover adapter paths, catalog writes and installation consumption. These checks do not establish Windows, network filesystem, delegated cgroup or packaged installer behavior. Age-based reclamation is a cooperative stale-lock policy, not a kernel advisory lock or a crash transaction.
