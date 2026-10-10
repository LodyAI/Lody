# Native Effect file locks and fair ownership handoff

Status: implemented
Translation: current
PR: [#1377](https://github.com/LodyAI/Lody/pull/1377)

[中文](2026-10-10-effect-file-lock-lifecycle.zh.md)

## Abstract

The shared file lock kept Promise tails, timer backoff and an async-context singleton, while swallowing release failures. This change gives a FileLocks Layer instance the local admission registry and makes each operation own a real file through Effect acquire-use-release. Ref and Deferred preserve strict FIFO and remove cancelled tickets; complete metadata is published by exclusive hard link. A single compatibility runtime serves existing Promise callers and native catalog writes. Contention deadlines and the existing stale-lock age policy are preserved, while I/O and release failures become observable; Windows and unsupported filesystems remain outside local verification.

## Decision and evidence

The dependency and delivery owner remains the [migration roadmap](../../proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.md). This is the first unit after the merged process foundation (#1065, #1069, #1348), using the existing native `probePid` rather than executing its synchronous compatibility API.

The official `FileSystem` service and `NodeFileSystem.layer` supply I/O. `FileLockHost` freezes profile directory and pid at composition; core tests inject services. Official sources checked against installed Effect and platform-node-shared 4.0.2 include `FileSystem.ts`, `NodeFileSystem.ts`, `Semaphore.ts`, `Deferred.ts` and `internal/effect.ts`.

Two tempting implementations failed inspection or experiments:

1. **Semaphore alone does not preserve strict admission order.** A retained behavioral test queues two callers, then has the holder immediately request the same lock again. On installed 4.0.2 it produced holder → newcomer → second → third. Ref atomically registers tickets and Deferred directly reserves the next owner's permission before a newcomer can register. Cancellation removes its own ticket without waiting on an earlier holder. The same test now requires holder → second → third → newcomer.
2. **Asynchronous `wx` plus metadata write exposes an empty file.** The old synchronous write did not yield in that window. Another process can classify the empty file as malformed and take over during an async write. A private scratch directory owns the fully written candidate; `FileSystem.link` exclusively publishes it at the unchanged `.lock` path. Failed preparation and interruption remove scratch. Metadata preparation stays interruptible under its candidate owner; only exclusive publication masks cancellation until its result and registered release can be joined. Behavioral tests cancel at both boundaries. No second spawn, collector or termination backend is introduced.

Each successful publication registers release before running the body. A release checks pid and token, reports `LockReleaseFailed` and retains the unresolved token in its owner. The next caller first retries that release. Failed scratch removal is retained too;
Layer finalization retries unresolved releases and surfaces an aggregate failure if
any remain. The acquisition timestamp is refreshed for each publication attempt,
so cross-process waiting does not shorten the existing stale-age window. Missing files are already gone; unreadable files fail rather than becoming stale. Malformed readable metadata and the 30-minute takeover policy remain unchanged. Reclamation rechecks observed content before removal; this preserves a cooperative file protocol, not a compare-and-unlink kernel primitive or an advisory-lock guarantee across expired-owner takeover.

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

## Verification

The owning suite exercises strict FIFO with immediate reacquisition, queued and cross-process waiter cancellation, failed/interrupted bodies, stale and foreign pid reclamation, reentry through sanitized aliases and child fibers, metadata write failure, release failure retention/retry, and replacement-token protection. A real Node child uses readiness IPC to verify mutual exclusion in both directions; it starts and stops through the existing process service. CLI adapter tests retain profile paths and naming; duplicate stale/live-lock cases move into the native suite. Catalog, worktree and cloudflared consumption retain behavioral coverage.

All thirteen ablations were caught by the retained behavior suite: admitting every ticket, retaining cancelled tickets, skipping release, swallowing release failure, removing the generation check, allowing reentry, overwriting publication, freezing publication age, dropping failed scratch ownership, rejecting confirmed scratch absence, making publication interruptible, masking metadata preparation, and skipping Layer cleanup. Restoring the kernel passed all 20 tests. Experiments ran only in a throwaway copy; scripts and source-string tests do not ship. Workspace typecheck and type-aware lint completed with no errors; 20 owning tests, 35 consumer tests, 25 environment-isolated native fixtures, format/format:check, docs check and platform/process/public/import/i18n guards passed. An earlier full pnpm check failed in unrelated Roost history coverage and environment-sensitive fixtures. Isolating only validation child-process Git/PATH and temporary package scope resolved the latter; the signed-prefix Roost timeout also reproduced on clean main 643222f2. The complete isolated rerun failed only that Roost timeout: CLI reported 3,687 passed, one failed and one skipped. pnpm check therefore does not pass; later guards were run separately. The validation clone used base 0561e9da; newer main changes are not claimed tested by that run. No coverage or global Git configuration was removed. Local Linux results do not establish real Windows, hard-link behavior on other filesystems, delegated cgroups, packaging, or end-to-end ACP/Session/Turn cancellation. The process backend's Windows root-exit limitation is unchanged.
