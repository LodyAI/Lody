# Effect TS in the CLI

How `apps/cli` code uses [Effect](https://effect.website) and how Effect code
meets the Promise code it has not replaced yet. The migration order and the
layer map live in the
[lifecycle migration roadmap](../notes/proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.md);
binding rules for already-migrated directories live in their `AGENTS.md`
(for example [`apps/cli/src/platform`](../../apps/cli/src/platform/AGENTS.md)).
The pinned version is `effect` 3.18 (`pnpm-workspace.yaml` catalog).

## When to use Effect

- New modules and services: a `Context.Tag` for the capability, a `Layer` for
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
  `FiberFailure` wrapper `Effect.runPromise` rejects with.
- An interrupt is owned by a scope or awaited. `void Effect.runPromise(Fiber.interrupt(f))`
  returns before the fiber's finalizers run.
- Put a timeout on the waiter, not on uninterruptible work:
  `Fiber.await(raw).pipe(Effect.timeoutTo(...))`. `Effect.timeout` around an
  uninterruptible region waits for that region to finish anyway.
- Bound every wait inside a finalizer. Finalizers are uninterruptible, so an
  unbounded wait there can hang shutdown.
- `FiberMap.run` with an existing key interrupts the old fiber without waiting
  for its finalizers; interrupt and await it yourself when the two must not
  overlap.
- A second `Scope.close` returns without waiting for the first close's
  finalizers; share one memoized close when several callers can end a scope.
- Subscribe to Node events in the same synchronous step as the call that
  produces them (inside an `Effect.async` register function, or a synchronous
  `onSpawned` hook). A listener attached after a fiber yield can miss an event
  that already fired.

## Temporary Promise facades

A migrated layer is consumed by callers that are still Promise-based. Such a
caller reaches the new service through a facade built on
`makePlatformRunner` (`apps/cli/src/platform/promise-facade.ts`), which provides
the service Layers and applies the failure rule above. A facade is temporary:
it is deleted when its caller migrates, and it never appears inside an already
migrated layer. Current facades:

| Facade | Used by | Replaced when |
| --- | --- | --- |
| `apps/cli/src/session/session-sandbox.ts` (`SessionSandbox`) | `Session`, `TerminalManager` | the session resource layer owns process containers directly |
| `terminateAcpProcessTree` in `apps/cli/src/agent/acp-runner.ts` | auxiliary ACP agents | auxiliary ACP agents become scoped processes |
| `runCommandText` / `runCommandTextSync` / `startProcess` / `isPidAliveSync` in `apps/cli/src/platform/promise-facade.ts` | every other CLI process caller (git, gh, daemon/worker/MCP children, tunnels, setup scripts) | each caller's own layer migrates |
| `terminatePtyProcessGroup` in `apps/cli/src/lib/terminal-pty-service.ts` | local terminal PTYs | terminal/PTY ownership becomes an Effect layer |

`pnpm check:cli-process-boundary` fails when CLI code bypasses these and reaches
`child_process`, `cross-spawn`, `node-pty` or `process.kill` directly.

## Testing

- Use `@effect/vitest` (`it.effect`, `it.scoped`, `it.live`) with
  `TestClock.adjust` to drive time. Fork the program, adjust the clock, then
  join or await the fiber.
- Replace services with test Layers or `Effect.provideService`, and assert the
  resulting state (which processes are alive, what was written), not how often a
  mock was called. `apps/cli/tests/fake-process-table.ts` models the OS process
  table for the process layer.
- `vi.useFakeTimers()` with default options also fakes the timers Effect's
  clock uses. It drives Effect sleeps only when the test advances timers
  (`vi.advanceTimersByTimeAsync`); prefer `TestClock` for Effect-first code.
