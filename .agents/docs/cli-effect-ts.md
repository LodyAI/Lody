# Effect TS in the CLI

How `apps/cli` code uses [Effect](https://effect.website) and how Effect code
meets the Promise code it has not replaced yet. Binding rules live in each module's `AGENTS.md`. This guide describes the existing Effect consumers and the
workspace v4 API choices; process ownership is implemented in a later PR.
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
  `FiberFailure` wrapper `Effect.runPromise` rejects with.
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

## Promise entry points

Existing Promise entry points may run an Effect with the runtime APIs above.
New lifecycle services and process facades are introduced by later PRs; this
migration only updates the existing Effect consumers.

## Testing

- Use `@effect/vitest` (`it.effect`, `it.live`) with `TestClock` from
  `effect/testing`. `it.effect` supplies a Scope and test services; v4 has no
  separate `it.scoped`. Use `TestClock.adjust` to drive time. Fork the program, adjust the clock, then
  join or await the fiber.
- Replace services with test Layers or `Effect.provideService`, and assert the
  resulting state (what was written, which work remains alive), not how often a
  mock was called.
- `vi.useFakeTimers()` with default options also fakes the timers Effect's
  clock uses. It drives Effect sleeps only when the test advances timers
  (`vi.advanceTimersByTimeAsync`); prefer `TestClock` for Effect-first code.

## v4 API choices

- Define capabilities with `Context.Service<Self, Api>()(id)`. `Layer.effect`
  builds both ordinary and scoped implementations; acquisition can require Scope.
- Use `Effect.forkChild` for child-owned work, `Effect.forkIn` for an explicit
  Scope, and `Effect.forkDetach` only when ownership is managed explicitly. Detached work must be explicitly
  interrupted and awaited by its owner.
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
