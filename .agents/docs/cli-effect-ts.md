# Effect TS in the CLI

How `apps/cli` code uses [Effect](https://effect.website) and how Effect code
meets the Promise code it has not replaced yet. The migration order and the
layer map live in the
[lifecycle migration roadmap](../notes/proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.md);
binding rules for already-migrated directories live in their `AGENTS.md`
(for example [the shared process layer](../../packages/shared/src/node/AGENTS.md)).
The catalog pins `effect` and `@effect/vitest` to 4.0.2. The [v4 migration
record](../notes/implemented/architecture/2026-10-09-effect-v4-migration.md)
explains version selection and the preserved lifecycle behavior.

## When to use Effect

- New modules and services: a `Context.Service` for the capability, a `Layer` for
  each implementation, `Effect.provide` at the composition point.
- Errors: `Data.TaggedError` values and `Effect.catchTag`, not `try`/`catch`
  on unknown exceptions.
- Resources with a lifetime: `Effect.acquireRelease`, `Scope`, `RcMap`.
- Concurrency: fibers, `Semaphore`, `Deferred`, `FiberMap`/`FiberSet`, not
  promise chains, `Map`s of in-flight promises, or `AbortController`s.
- Retries, polling and deadlines: `Schedule`, `Effect.timeout*`, `Effect.sleep`,
  not `setTimeout`/`setInterval` loops.

Raw `async`/`await` remains fine for thin glue at process entry points,
synchronous code without error handling, and hot paths where a measurement shows
Effect overhead matters (the per-token ACP update path, CRDT import/export).

## Rules at the Promise boundary

- Never call `Effect.run*` inside an Effect. Run programs only at an entry point
  or in a temporary facade (below).
- Wrap promises that can reject with `Effect.tryPromise({ try: (signal) => ...,
catch })` and pass the signal on, so interruption aborts the work.
  `Effect.promise` turns a rejection into a defect.
- Surface failures to Promise callers as the typed error itself: run with
  `Effect.runPromiseExit` and throw `Cause.squash(exit.cause)`, not the
  `FiberFailure` wrapper `Effect.runPromise` rejects with. For programs owning
  processes, use `squashProcessFailure`: plain `Cause.squash` can discard a
  simultaneous release defect and its recovery lease.
- An interrupt is owned by a scope or awaited. `void Effect.runPromise(Fiber.interrupt(f))`
  returns before the fiber's finalizers run.
- Put a timeout on the waiter, not on uninterruptible work:
  `Fiber.await(raw).pipe(Effect.timeoutOrElse(...))`. `Effect.timeout` around an
  uninterruptible region waits for that region to finish anyway.
- Bound every wait inside a finalizer. Finalizers are uninterruptible, so an
  unbounded wait there can hang shutdown.
- `FiberMap.run` with an existing key interrupts the old fiber without waiting
  for its finalizers; interrupt and await it yourself when the two must not
  overlap.
- A second `Scope.close` returns without waiting for the first close's
  finalizers; share one memoized close when several callers can end a scope.
- Subscribe to Node events in the same synchronous step as the call that
  produces them (inside an `Effect.callback` register function, or a synchronous
  `onSpawned` hook). A listener attached after a fiber yield can miss an event
  that already fired.

## Process service and resource ownership

Use `ChildProcess` and `ChildProcessSpawner` from `effect/process`. The shared
`ProcessSpawnerLive` implements the official service with Lody's bounded tree
policy and official Node Stream/Sink adapters. `processLayer` composes it with
`NodeProcess`; the CLI's `platformLayer` also supplies its logger. `runCommand`
requires the official spawner, and `spawnProcess` requires Scope. See the
[backend decision](../notes/implemented/architecture/2026-10-09-effect-official-process-service.md)
for why the default Node spawner is not used unchanged.

If bounded Scope termination fails, its Exit contains a `ProcessReleaseFailed`
defect with a recovery lease for the unresolved tree. The owner retains that
lease, observes `isAlive` and retries `retryTermination` before declaring the tree
gone. Scope closure itself is already finished and cannot perform that retry.
`squashProcessFailure` preserves all these leases when an unmigrated Promise
boundary also has a body error. This tree recovery does not certify drained stdio
or complete Session shutdown. See the
[release decision](../notes/implemented/bug-fix/2026-10-10-effect-process-release-failure.md).

Never wrap the shared Promise functions back into an Effect. A runner creates a
separate root fiber. For an unmigrated entry point, the shared facade accepts an
explicit AbortSignal; pass it when the entry point supports cancellation. This
neither supplies structured Effect ownership nor automatically makes its parent
wait for cleanup. Native Effect callers yield the service directly.

A Session owns a container Scope. Each spawn uses a child Scope: failed or
interrupted setup closes it before returning; successful setup retains it until
whole-group exit and drained stdio. Closing the container Scope terminates its trees and stops its
monitor fibers, then removes cgroup resources. `startProcessLegacy` is reserved for
legacy synchronous/raw Node handles (including IPC and explicit detach), whose
owner must await `terminate`; it is not a scoped Effect API.

## Temporary Promise facades

A migrated layer is consumed by callers that are still Promise-based. Such a
caller reaches the new service through a facade: the process layer's own
facades at the end of `packages/shared/src/node/process.ts`, which the CLI
uses directly with options composed by `apps/cli/src/platform/process-options.ts`.
They provide the service Layers and apply the failure rule above. A facade is temporary:
it is deleted when its caller migrates, and it never appears inside an already
migrated layer. Current facades:

| Facade                                                                                                                                                                                                                                                                                                                                                                         | Used by                                                                                                 | Replaced when                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `apps/cli/src/session/session-sandbox.ts` (`SessionSandbox`)                                                                                                                                                                                                                                                                                                                   | `Session`, `TerminalManager`                                                                            | the session resource layer owns process containers directly |
| `terminateAcpProcessTree` in `apps/cli/src/agent/acp-runner.ts`                                                                                                                                                                                                                                                                                                                | auxiliary ACP agents                                                                                    | auxiliary ACP agents become scoped processes                |
| `runCommandTextLegacy` / `runCommandTextSyncLegacy` / `startProcessLegacy` / `terminateChildTreeLegacy` / `signalChildTreeNowLegacy` / `isPidAliveSyncLegacy` / `probePidSyncLegacy` and the runners `makeProcessRunnerLegacy` / `runPromiseSquashedLegacy` in `@lody/shared/node/process` (CLI: `process-options.ts` composes its logger; worker bundles use shared defaults) | every other process caller in the CLI, Electron main, the CLI supervisor and `packages/shared/src/node` | each caller's own layer migrates                            |
| `terminatePtyProcessGroup` in `apps/cli/src/lib/terminal-pty-service.ts`                                                                                                                                                                                                                                                                                                       | local terminal PTYs                                                                                     | terminal/PTY ownership becomes an Effect layer              |

`pnpm check:cli-process-boundary` fails when code in those packages bypasses
these and reaches `child_process`, `cross-spawn`, `node-pty`, `process.kill` or
a child's `kill` directly.

Execution facades carry a `Legacy` suffix and `@deprecated`; keep that suffix
visible in imports and calls. New Effect workflows compose core APIs and leave
execution to their owning application entry point. Layer builders and pure error
conversions retain their names because they do not execute a program. Current
shared execution facades are:

- `runCommandTextLegacy` and `runCommandTextSyncLegacy`: text output for Promise
  and blocking callers, respectively.
- `startProcessLegacy`: raw Node handle with manual ownership
  (`ProcessHandleLegacy`).
- `terminateChildTreeLegacy` and `signalChildTreeNowLegacy`: awaited tree cleanup
  and synchronous exit-hook signalling, respectively.
- `isPidAliveSyncLegacy` and `probePidSyncLegacy`: synchronous process probes.
- `makeProcessRunnerLegacy` (`ProcessRunnerLegacy`) and `runPromiseSquashedLegacy`:
  temporary execution and error conversion for Promise entry points.

`runCommand`, `runCommandOk`, their Effect-returning Sync variants, `spawnProcess`,
`terminateTree`, `childProcessTree`, `isPidAlive` and `probePid` retain their names.
The guard rejects retired facade imports/exports and aliases that hide Legacy.

## Testing

- Use `@effect/vitest` (`it.effect`, `it.live`) with `TestClock` from
  `effect/testing`. `it.effect` supplies a Scope and test services; v4 has no
  separate `it.scoped`. Use `TestClock.adjust` to drive time. Fork the program, adjust the clock, then
  join or await the fiber.
- Replace services with test Layers or `Effect.provideService`, and assert the
  resulting state (which processes are alive, what was written), not how often a
  mock was called. `@lody/shared/node/process-testing` models the OS process
  table for the process layer.
- `vi.useFakeTimers()` with default options also fakes the timers Effect's
  clock uses. It drives Effect sleeps only when the test advances timers
  (`vi.advanceTimersByTimeAsync`); prefer `TestClock` for Effect-first code.

## v4 API choices

- Define capabilities with `Context.Service<Self, Api>()(id)`. `Layer.effect`
  builds both ordinary and scoped implementations; acquisition can require Scope.
- Use `Effect.forkChild` for child-owned work, `Effect.forkIn` for an explicit
  Scope, and `Effect.forkDetach` only when ownership is managed explicitly. The
  taskkill deadline uses the last form and always interrupts and awaits it.
- Use `Scope.provide(program, scope)` when an existing scope owns a program.
  Context-based runners are `Effect.runForkWith(services)`, not a v3 Runtime.
- `Effect.result` returns `Result` (`Success.success` / `Failure.failure`);
  `Effect.catch` handles typed errors. Timeout errors use the tag `TimeoutError`.
- `Cause` contains a flat `reasons` array. Use `findErrorOption`,
  `hasInterrupts` or `hasInterruptsOnly` according to the intended check.
- `Schedule.min([exponential, spaced])` caps a backoff; `Schedule.while` receives
  schedule metadata, whose `input` is the failure being retried.
- `Effect.yieldNow` is an Effect value, not a function. Use `Effect.sleep` and
  `Duration.Input` / `Duration.fromInputUnsafe` for delays.
- ScopedCache operations are module functions. In 4.0.2 bulk disposal joins
  finalizer Exits without propagating their failures; owners that promise to
  report cleanup failures must collect them explicitly.

API reference: [official migration guide](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md).
Use the pinned package's declarations to verify details: the upstream guide can
advance beyond the installed release.
