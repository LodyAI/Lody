# Effect v4 foundation for the lifecycle migration

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1070

[中文](2026-10-09-effect-v4-migration.zh.md)

## Abstract

The lifecycle refactor needs a common Effect v4 base before new services are
introduced. This bottom PR pins the workspace runtime and test helper to 4.0.2
and migrates the already-existing consumers in the CLI, renderer and ignore
package. It preserves cache cleanup errors and send preparation timing despite
v4 scheduler and disposal differences. Process creation, sandbox ownership and
consumer rewrites belong to the subsequent PRs, not this migration.

## Scope and version choice

#1070 targets main and is the base of the lifecycle stack. The plan PR #1057
builds on it, followed by the process foundation #1065, CLI consumer migration
#1069, and the cross-runtime consumer PR. Existing process code remains unchanged
in this bottom PR; each later service is introduced directly with v4 APIs.
The bottom layer integrates current main so that the v4 baseline is mergeable;
subsequent layers inherit that update without adding it to their own scope.

The initial baseline used exact 4.0.0 pins because that release satisfied the
workspace's seven-day minimum release age. The user subsequently authorized an
upgrade and release-age exemption for the lifecycle fixes in 4.0.2, published on
October 7. The catalog now pins `effect: 4.0.2` and `@effect/vitest: 4.0.2`, with
exact-version exceptions for both packages; future releases still wait seven days.
The matching helper requires Effect `^4.0.2` and Vitest 5; only CLI and shared, which consume that
helper, move to Vitest 5.0.2, together with CLI's matching coverage provider. Vitest 5 supports Node 22.12+,
24.x and 26+; validation uses Node 24, and CI uses Node 22. The production
runtime floor is unchanged.

An optional transitive `effect@3.18.4` remains inside `@prisma/config`. It is not an
owned service dependency and is not overridden: forcing a third-party v3 consumer
onto v4 would bypass its compatibility contract. All six direct workspace consumers
resolve 4.0.2, so service contexts do not cross the two versions.

The patch upgrade includes the [4.0.1 shared-cache cancellation fix](https://github.com/Effect-TS/effect/pull/8719)
and the 4.0.2 fixes for [scope finalizer interruption](https://github.com/Effect-TS/effect/pull/8779),
[queue delivery during interruption](https://github.com/Effect-TS/effect/pull/8819)
and [repeat/retry failure preservation](https://github.com/Effect-TS/effect/pull/8799).
These primitives are used by existing workspace consumers. Upstream reproductions
justify the upgrade; they do not establish that Lody has reproduced every defect.
The version and lockfile changes belong only to this bottom PR and are merged
upward so each later PR retains its own service or consumer scope.

## Primitive changes

| v3                                               | v4 used here                                                   |
| ------------------------------------------------ | -------------------------------------------------------------- |
| `Context.Tag`                                    | `Context.Service<Self, Api>()(id)`                             |
| `Layer.scoped`                                   | `Layer.effect`, with scoped acquisition                        |
| `Scope.extend`, `CloseableScope`                 | `Scope.provide`, `Closeable`                                   |
| `Effect.fork`, `forkDaemon`, `RuntimeFiber`      | `forkChild`, `forkDetach`, `Fiber.Fiber`                       |
| `Runtime.runFork(runtime)`                       | `Effect.runForkWith(services)`                                 |
| `Effect.async`, `catchAll`, `either`, `zipRight` | `callback`, `catch`, `result`, `andThen`                       |
| `Either.Left/Right`                              | `Result.Failure.failure` / `Success.success`                   |
| `failureOption`, `isInterrupted`, empty Cause    | `findErrorOption`, `hasInterrupts`, flat `reasons`             |
| `timeoutFail`, `TimeoutException`                | `timeoutOrElse`, `TimeoutError`                                |
| `Schedule.union`, `whileInput`                   | `Schedule.min([...])`, `Schedule.while(({ input }) => ...)`    |
| `DurationInput`, `decode`, `Clock.sleep`         | `Duration.Input`, `fromInputUnsafe`, `Effect.sleep`            |
| logger replacement and level objects             | `Logger.layer`, string levels and `References.MinimumLogLevel` |
| `TestContext`, root `TestClock`, `it.scoped`     | `TestClock.layer()` from `effect/testing`, scoped `it.effect`  |

The standalone Semaphore module and module-level ScopedCache operations replace
v3 instance methods. Unsafe Deferred/Queue completions use the pinned v4 names.
`Effect.yieldNow` is an Effect value rather than a function.

## Preserved semantics

- v4 forks start lazily by default. The send-resource scope uses
  `forkIn(..., { startImmediately: true })` to preserve immediate owned I/O
  after the UI debounce; existing tests retain the 650 ms boundary.
- In 4.0.0 `ScopedCache.invalidateAll` joins finalizer Exits without propagating
  failures. File-index cache disposal records them at release and reports them
  after all resources are cleaned up; the failing-unsubscribe test is unchanged.
- Existing reconnect, timeout, retry and session behavior is preserved. No
  process-tree abstraction or process boundary guard is introduced here.

## Testing and evidence

The installed 4.0.0 declarations and implementation were checked against the
[official migration index](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md)
and [API map](https://github.com/Effect-TS/effect/blob/main/migration/v3-to-v4.md).
Upstream main can advance beyond the pinned release; it is not a substitute for
version-specific validation.

Vitest 5 config removes `poolOptions`, using `execArgv` for the WASM flag.
Inlining `@effect/vitest` keeps it on the runner's Vitest instance. The CLI's `src`
alias mirrors its tsconfig, and constructor mocks use constructible functions.
Asynchronous assertions await completed observable work rather than an assumed
number of scheduler turns; no assertion is weakened to accept missing work.
The disposal test drains v4 completion notifications at zero virtual time before
checking for remaining retry timers; the existing later checks still verify
that a disposed runtime performs no further attach work.

Validation is recorded per PR after the restack. The earlier combined v4
snapshot passed `pnpm check`, format/document checks, frozen installation and
CLI/Electron builds. Those results do not prove intermediate layers; each layer
must be checked independently. Validation removes only the authoring session's
injected `GIT_CONFIG_*`, `GIT_EXEC_PATH` and `LODY_GIT_*` settings so native Git
fixtures do not run through the authoring wrapper.

Initial 4.0.0 bottom-layer validation: typecheck and lint passed; CLI 3244 passed / 4 skipped,
shared 1258, components 4554, supervisor 49 and Electron 199. The first full
check reached Electron with a missing locally installed binary after an
ignore-scripts install. Restoring that pinned binary and rerunning Electron
passed; the remaining static boundary checks also passed. Frozen installation,
format checks and docs checks passed. No product fix was made for that local
installation failure.

The 4.0.2 bottom layer passed frozen installation, `pnpm check`,
`pnpm format:check` and `pnpm run docs check`. Runtime resolution was checked from
all six direct consumers and both test-helper consumers; they use the same 4.0.2
runtime. This validates the bottom layer, not the later process implementations.
