# packages/shared/src/node

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

CLI, desktop main and supervisor helpers. Rules: [shared](../../AGENTS.md).

## Local-project Git (`local-project.ts`)

- Native workflows require `LocalProjects`, provided by `LocalProjectsLive` with
  filesystem paths, host environment and the official process spawner. Compose
  their Effects directly; do not call a Promise facade from an Effect workflow.
- Expected Git statuses may represent absence. Startup, deadline, corruption,
  filesystem and release failures must remain observable; parallel probe failure
  interrupts and joins its siblings. Preserve exact-ref and canonical project
  identity behavior.
- `localProjectsLegacy` is the single deprecated execution facade for remaining
  CLI entrypoints. Keep Legacy visible in calls; remove it after those owners
  receive the native service. Its synchronous path/identity methods remain
  explicitly blocking. Worktree setup/GC still need their own lifecycle migration.

## Process layer (`process.ts`)

The sole OS process implementation. Effect and boundary rules: [cli-effect-ts](../../../../.agents/docs/cli-effect-ts.md). Decision
record: [process tree layer](../../../../.agents/notes/implemented/architecture/2026-09-27-effect-process-tree-layer.md).

- Effect callers use `effect/process` commands and `ChildProcessSpawner`,
  provided by `ProcessSpawnerLive` with Lody's bounded backend. Process acquisition
  requires Scope; only legacy Promise entry points use raw handle compatibility.
  Temporary execution entry points carry the `Legacy` suffix and `@deprecated`;
  keep it visible in imports and calls. New Effect workflows compose core APIs
  and execute once at their owning application entry point.
  Use the workspace Effect v4 catalog and `Context.Service` / `Layer.effect`;
  follow the pinned-version APIs in cli-effect-ts, not v3 compatibility helpers.
- Only `process.ts` imports `child_process`, a process library (`cross-spawn`,
  `execa`, `shell-env`, ...) or signals the OS (`process.kill`, Node `child.kill`).
  Everything else uses the official process service or shared legacy facades;
  never put an Effect through a Promise facade and wrap it back into Effect.
  `pnpm check:cli-process-boundary` enforces this across `apps/cli`,
  `apps/electron/src/main`, `packages/cli-supervisor`,
  `packages/code-review-helper` and this directory; its allowlist names each
  exception and its reason.
- Login-shell probes use `LoginShellEnvironment`; the shared `LoginShellCache`
  Layer owns one producer in the application's Scope. Reader cancellation/timeout
  does not stop siblings; application shutdown interrupts and joins the producer.
  `makeApplicationRuntime` joins concurrent disposal and retains recovery owners
  after failed Scope close. Only named Legacy application boundaries execute.
  Preserve timeout/release failure owners; never cache failure as empty success. Read [the decision](../../../../.agents/notes/implemented/architecture/2026-10-10-effect-login-shell-probe.md)
  before changing the probe or either cache consumer.
- `process.ts` stays one module with no relative imports: Electron's
  `node --test` cannot resolve extensionless relative imports.
- Missing a capability (a new spawn shape, a pid-only kill)? Add it to
  `process.ts` with a test and a facade; never work around the layer in a caller.
- End processes through the official Effect handle or `terminateTree`; never add another
  SIGTERM→wait→SIGKILL loop. Every wait is bounded, and a tree that cannot be
  proven gone fails with `TerminationFailed`, never success. Scope release failure
  is a `ProcessReleaseFailed` defect carrying the unresolved tree's recovery lease;
  retain it until `isAlive` proves absence or `retryTermination` succeeds. Logging
  alone cannot turn that failure into success. Promise boundaries must use
  `squashProcessFailure` to preserve every lease alongside the primary failure.
  Acquisition error conversions preserve the full Cause, including release
  defects from the spawner's failed child Scope, before reaching that boundary.
- Termination often runs in a finalizer, where nothing is interruptible: bound
  its waits by the clock (`waitUntilGone`), never by `timeout*` or a race.
- Never signal a child without a pid (pid 0 is the caller's own group), and
  never resolve a Windows command from the working directory.
- Liveness covers the whole tree (process group, cgroup), not just the root.
  A group left with only zombies is gone; only an exact member scan proves it.
- A command that exits on its own keeps what it deliberately left running; only
  a caller that stops waiting (timeout, interruption, output limit) ends the tree.
- Scope owns process acquisition before configuration or other interruptible
  post-spawn work. Failed owner hooks also release the acquired process.
- Subscribe to a child's events in the same synchronous step as the spawn
  (`SpawnSpec.onSpawned`, an `Effect.callback` register).
- The Effect core has no Promise APIs, timers, `AbortController`s or mutable
  module state; the facade section at the end of `process.ts` is the only
  Promise door. Tests use `@effect/vitest` with `TestClock` and
  `process-testing.ts` (the fake process table); a real-process test waits on
  explicit readiness output, never on elapsed time.

## File locks (`file-lock.ts`)

- Native workflows compose `withFileLock` through one owner-provided `FileLocks`
  service. Only unmigrated application entrypoints use `fileLocksLegacy`; keep
  Legacy visible and never execute it inside a native Effect workflow.
- Resolve each operation using explicit locksDir, current LODY_LOCKS_DIR, then
  current profile locks; production composition must not freeze environment paths.
- Keep strict FIFO, fail-fast same-context reentry, profile paths and the deadline
  that starts after local admission. A plain Semaphore does not preserve FIFO
  on immediate reacquisition in 4.0.2. Use the owned Ref/Deferred handoff.
- Publish complete metadata exclusively; register release before the body. Cancelled
  tickets leave the queue immediately. Retain failed release generations, verify
  pid plus token, and surface unreadable-lock/cleanup errors. Changed stale
  generations must return to backoff/deadline checks. Stale cleanup also collects
  crash-orphan scratch using ownership/age checks, preserving fresh live
  candidates and giving unidentified preparation a 30-minute grace period. Decision and limits:
  [file lock lifecycle](../../../../.agents/notes/implemented/architecture/2026-10-10-effect-file-lock-lifecycle.md).

- The holder waits once (5 seconds) for its file and scratch. A slow or failed
  deletion never fails that holder: the service retains it, and successors join
  it within their acquisition deadline, charged once per attempt (later ones fail fast).
  Only `LockOwnershipLost` fails the holder.
  Only settled failures permit a new deletion attempt.
- Retry acquisition only. Use `squashFileLockFailure` at Legacy boundaries
  ([holder release](../../../../.agents/notes/implemented/architecture/2026-10-16-file-lock-holder-release.md)).

## Supervised Inbox compatibility

Supervisor launch contract v3 requires Inbox protocol v2. TS and CJS constants agree.
A mismatched supervised worker exits 45 before host ownership/storage; do not downgrade
to an earlier worker contract. Foreground arbitrary old binaries are unsupported.

## Local Loro writer boundary

`local-loro-writer.ts` owns the real Node turn and socket write/drain adapters.
Applications provide one process-wide writer; never add a workspace scheduler.
Native workflow and release rules: [writer](../local-loro-writer/AGENTS.md).

## Local session control

Keep history requests and receipts aligned in the Zod protocol and both lightweight
TS/CJS guards. The declared-operation suite must admit each supported operation;
advertising a capability alone does not prove the local IPC path accepts it.

E2EE pairing (`../e2ee-local-pairing.ts`) stays on the same-user socket; no secrets
or network listener.
