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

## Version-matched reference

Use the repository [Effect skill](../skills/effect-ts/SKILL.md) before Effect work.
Resolve the dependency from the consuming package, read its `effect/AGENTS.md`
completely once per resolved version in the current context, then follow task-relevant
links and search `ai-docs`/`src` as needed. Re-read when the version or context is lost.
A root `node_modules/effect` path is not guaranteed in this pnpm workspace.
Use the [migration skill](../skills/effect-v3-to-v4/SKILL.md) for an explicit v3
migration. Both retain Lody's locked-version and behavioral acceptance rules.
The [reference decision](../notes/implemented/process/2026-10-11-effect-reference-skills.md)
explains why a tracked Effect subtree is not currently recommended.

Use applicable Specs/scoped rules for intended behavior, installed source and
behavioral evidence for actual API semantics. If they disagree, identify a bug,
stale explanation or unimplemented intent; do not change a Spec to fit the code.
Read the relevant guide sections, ledger rows and owning Notes for the task rather
than repeatedly loading the entire migration roadmap.

## When to use Effect

- Injectable capabilities and shared resources: `Context.Service` contracts and
  `Layer` implementations, with `Effect.provide` at the composition point.
  Ordinary arguments and local Effect composition need no new Service.
- Errors: `Data.TaggedError` values and `Effect.catchTag`, not `try`/`catch`
  on unknown exceptions.
- Resources with a lifetime: `Effect.acquireRelease`, `Scope`, `RcMap`.
- Concurrency: fibers, `Semaphore`, `Deferred`, `FiberMap`/`FiberSet`, not
  promise chains, `Map`s of in-flight promises, or `AbortController`s.
- Retries, polling and deadlines: `Schedule`, `Effect.timeout*`, `Effect.sleep`,
  not `setTimeout`/`setInterval` loops.

Keep Promise glue at registered application/compatibility entries and genuine
external adapters. Pure synchronous calculations and measured hot-path computation
remain ordinary functions; hot paths do not justify unmanaged lifecycle work.

## Small migrations during feature and fix work

The root [Effect rule](../../AGENTS.md#effect-reference) requires assessing a small
native migration when a feature or fix touches an effectful module. Prefer it in
the same PR when it directly improves the requested behavior: for example,
replacing the Promise queue or timer lifecycle responsible for a cancellation bug.
Select feature/fix mode in the [Effect skill](../skills/effect-ts/SKILL.md) and follow
the version-matched reading policy above. Review and diagnosis do not initiate a
migration; an explicit v3 migration additionally uses the
[migration skill](../skills/effect-v3-to-v4/SKILL.md).
Use existing Effect primitives for ownership, coordination, retry and local
observability where they simplify that work. Preserve existing telemetry policy.

Choose a complete unit using the [actual dependency graph](../notes/proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.md#delivery-dependency-graph).
Its dependencies must already offer native Effect capabilities, or be genuine
external I/O boundaries adapted once. Independent leaves can migrate without
waiting for unrelated layers. Wrapping Lody's unfinished Promise orchestration
does not complete a native unit; registered upstream adapters retain their existing
deletion conditions and incomplete status.

Estimate the extra migration diff as additions plus deletions, including necessary
callers, tests and documentation. Around 500 changed lines is a useful budget,
not a hard limit or permission threshold. Dependency breadth, lifecycle complexity
and verification effort matter more than line count. Keep meaningful coverage;
an oversized rewrite split into partial kernels does not meet this budget's purpose.

Acceptance follows the roadmap's [definition of done](../notes/proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.md#definition-of-done):
connect real consumers, provide dependencies through services/Layers, own resources
and background work, await cancellation and bounded cleanup, and preserve failures.
Use one explicitly deprecated Legacy facade if callers still need it, recording
its consumers and deletion condition. Extend the owning behavioral suite for
failure, interruption and release paths with explicit signals and injected clocks.
Pure reducers, CRDT codecs and synchronous calculations remain ordinary functions.

When migration would pull in unfinished dependencies or substantially expand the
task, complete the requested feature/fix and schedule that migration separately.
Record the chosen boundary and remaining work in the owning Note when updating it;
follow existing Spec selection rules rather than creating a Spec for each migration.
The [roadmap decision](../notes/proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.md#small-migrations-alongside-features-and-fixes)
explains why this selection complements the dedicated migration series.

## Behavior contract

For a lifecycle change, answer these questions briefly in the existing owning Note
before choosing primitives. Omit inapplicable questions and link existing contracts
instead of creating a new checklist document for every edit.

| Question         | Observable contract                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| Trigger          | Which input/state starts work, and what ordering or reentry is allowed?                                  |
| Owner            | Who owns each resource/producer, and who may release it?                                                 |
| Cancellation     | Does cancellation end one wait, the producer, or raw external work? How is actual termination confirmed? |
| Handoff          | What observable release condition allows a successor or replacement to start?                            |
| Failure recovery | Who retains unresolved resources and the complete failure, and who can retry cleanup?                    |

Map applicable answers to behavioral acceptance cases. A cancelled reader must not
stop a shared producer needed by other readers; a cleanup timeout must not permit
replacement while the old resource is still owned. Review/debug can use the same
questions to assess existing evidence without editing the Note.

## Choosing a native unit and its structure

Use the [Effect skill](../skills/effect-ts/SKILL.md) to decide the implementation,
the roadmap's [unit ledger](../notes/proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.md#unit-ledger)
to identify prerequisites and progress, and the owning Note for behavior and evidence.
Before choosing primitives, list the unit's inputs, raw work, local waiters, resources,
background tasks, release order and failure/recovery owner. Follow injected callbacks
and resource handles as well as imports: a Promise callback supplied by another Lody
module can contain an unfinished dependency chain.

Classify each capability as native Lody, a real third-party I/O adapter, or unfinished
Lody orchestration. Prefer official capabilities and primitives, then verify the
installed signatures and relevant semantics. Primitive names are not lifecycle
guarantees: the file-lock FIFO experiment and the Scope/FiberMap boundary rules below
show why admission, replacement and release need behavioral evidence. Record any
necessary custom coordination and its justification in the owning Note.

Keep small cohesive modules simple. When a large module mixes responsibilities
enough to obstruct understanding, testing or independent migration, consider separating:

| Responsibility | Contents                                                         | Dependency boundary                                                               |
| -------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| pure           | Deterministic planners, reducers, codecs and calculations        | Ordinary functions; no Effect/Promise, external state reads or input mutation     |
| workflow       | Effect composition, domain coordination, retry and cancellation  | Pure helpers and abstract Service contracts; no production implementation imports |
| platform       | Concrete filesystem, process, network, database and SDK adapters | Implements contracts and owns technical I/O/resources                             |

These are responsibilities, not mandatory directories or a line-count threshold.
A domain service implemented entirely by composing injected capabilities belongs in
workflow; using `Layer.effect` does not make it a platform adapter. A workflow describes
managed effects and can require services; its runtime execution can perform I/O.
No-Promise and `R=never` types alone do not establish purity. Time, environment,
randomness and captured mutable state still need the appropriate boundary.
Keep production Layer selection in composition and execution at registered entries;
reuse official abstractions instead of adding interfaces that only rename them.
Preserve existing scoped file-layout constraints, including the single process module.

## Keeping native boundaries native

For a completed unit, keep its nearest AGENTS.md boundary, behavioral suite and
applicable checks together. Update the ledger row only when migration facts change;
ordinary unrelated work does not need a ledger edit. Native consumers compose the
core service, with no Legacy import or internal runtime execution. Remove a
compatibility door when its recorded consumers migrate; any new unfinished
dependency changes the status.

Use static import/execution checks for boundaries that can be expressed accurately,
with explicit adapter/entry exceptions. They complement lifecycle behavior tests.
The existing `check:cli-process-boundary` protects process access and process Legacy
names/aliases; it is not an all-module native-workflow validator. Add or extend a
guard when a unit's new boundary warrants it, recording uncovered limits rather than
claiming an absent guard already enforces them. Do not globally prohibit every Map,
Promise or callback in adapters and unmigrated code.

## Rules at the Promise boundary

- Launch programs with `Effect.run*` or `ManagedRuntime.run*` only at registered
  application entries or temporary facades (below), never inside native composition.
  `yield* Stream.runCollect(stream)` and `Stream.runDrain` return Effects and remain
  valid composition; the restriction is not a ban on every name starting with `run`.
- Wrap promises that can reject with `Effect.tryPromise({ try: (signal) => ...,
catch })`. Construct the Promise inside the thunk and pass the signal to the I/O.
  Interruption stops raw work only if the implementation cooperates; otherwise it
  stops the Effect wait while raw work can continue. Retain the raw-work owner
  until completion or confirmed termination; do not release its lease prematurely.
  `Effect.promise` turns a rejection into a defect.
- In pinned v4.0.2, `Effect.runPromise` already rejects with `Cause.squash(cause)`;
  a single typed failure is the original error, not a `FiberFailure` wrapper.
  Use `runPromiseExit` when the adapter must inspect the complete Cause before
  projection. Squashing can discard simultaneous failures and recovery ownership.
  Process-owning programs use `squashProcessFailure`; retain other domains' existing
  recovery-aware projections instead of replacing them with plain `Cause.squash`.
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

## Login-shell probes and application-owned cache

`LoginShellEnvironmentLive` injects host selection and the existing official
process service. Candidate shells share one Clock deadline; core composition
never executes. `LoginShellCacheLive` owns one producer in a child Scope and
retains its complete Exit for later readers. CLI readers retain their 3-second
pending-overlay behavior; cancellation and timeout affect only that local reader.
Application shutdown rejects new readers, interrupts and joins the producer, then
closes its child Scope. Process cleanup keeps its own bounded backend and recovery
leases. There is no Promise cache, cache timer or independent shell-probe runner.

CLI index and Electron startApplication each compose the application's first
long-lived native service through makeApplicationRuntime. Concurrent disposal joins
one receipt; failed disposal retains the original ownership Cause and subsequent
recovery Causes in its receipts. Recovery retries the original transferred owners.
Replacement is allowed only after release is confirmed.
CLI graceful/one-shot/fatal exits await that owner; failed graceful cleanup exits
with a failure code. Electron stops it inside the existing quit barrier after
renderer unload approval, and a later quit retries unresolved resources.
Remaining launchers use the visible getLoginShellEnvLegacy,
getCachedLoginShellEnvSyncLegacy and getUserShellEnvCachedLegacy accessors.
probeLoginShellEnvLegacy and the test-only reset facade are deleted. Remove the
remaining accessors/binding bridge once launchers receive LoginShellCache directly.
This first application runtime does not migrate the remaining Session/Turn/Loro
owners or establish end-to-end daemon shutdown. See the
[decision and limits](../notes/implemented/architecture/2026-10-10-effect-login-shell-probe.md).

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

In pinned 4.0.2, `Effect.mapError` selects a typed failure and can discard other
reasons in a mixed Cause. Resource-owning error conversions use `catchCause` and
`failCause(Cause.map(...))` to retain defects and interruptions. In particular,
failed process acquisition can already have closed its child Scope: its release
lease must reach the caller alongside the setup failure.

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

## Local-project Git

`LocalProjects` / `LocalProjectsLive` own native repository observation and branch
workflows. Their dependencies are `LocalProjectPaths` (official FileSystem),
`LocalProjectHost` (an Effect reading each command's environment), and the official
process spawner. `localProjectLayer` only composes Layers. Existing CLI command,
control, session and worktree-observation entrypoints execute this same kernel
through the one deprecated `localProjectsLegacy` facade. Keep that name visible;
new Effect callers yield native methods. Remove the facade when those application
owners provide LocalProjects. Its synchronous identity methods remain blocking.
Expected Git absence remains a domain result; process, deadline, corruption,
filesystem and release failures propagate. This does not complete worktree
setup/GC or the daemon's root runtime. Decision and limits:
[local-project Git](../notes/implemented/architecture/2026-10-10-effect-local-project-git.md).

## File locks

`withFileLock(name, body, options)` requires `FileLocks`. `FileLocksLive` captures
official FileSystem, native NodeProcess and FileLockHost dependencies. The host
fixes pid and resolves the default lock directory on each operation; tests may
inject a fixed directory.
`fileLockLayer` supplies Node implementations at composition. One service instance
owns local Ref/Deferred admission and unresolved releases; each operation owns its
candidate and acquired file. Release waits have their own 5-second Clock bound;
`LockReleaseFailed.cleanup` retains the original OS deletion for awaited retry.
A still-pending deletion blocks replacement. Body and release run outside acquisition
retry; `squashFileLockFailure` preserves their full Cause, file cleanup owners and
process recovery leases at compatibility boundaries. See the [decision and preserved lock policy](../notes/implemented/architecture/2026-10-10-effect-file-lock-lifecycle.md).

Catalog mutations compose the native API and require FileLocks. Existing Promise
application entrypoints execute them through `fileLocksLegacy.runPromise`; worktree,
cloudflared and Baguette use its `withLock` callback adapter. This one deprecated
facade shares a process-lifetime ManagedRuntime so local queue waiting retains its
old deadline meaning. Remove it when those entrypoints use the daemon runtime.
Catalog read caching, worktree setup/GC and downloads are still under migration.
Local-project Git is native as described above; full worktree ownership is separate.

## Worktree Git execution

`WorktreeGit` / `WorktreeGitLive` own native command execution, status checking and
bounded credential-helper protocol. Layers provide official FileSystem, the process
spawner and a per-command environment Effect. Each command owns its process Scope;
the service has no background work. `worktreeGitLayer` only composes dependencies.
The Promise manager uses the one deprecated `worktreeGitLegacy` facade; remove it
when the manager composes this service. That facade uses the shared complete-Cause
projection. Transport, cancellation and unresolved releases escape manager fallback
catches. Preserve mixed Fail/Die Cause when mapping commands on pinned v4; ordinary
mapError can select only the Fail reason. This is not native manager/setup/GC or
daemon runtime completion. Decision:
[worktree Git](../notes/implemented/architecture/2026-10-10-effect-worktree-git-execution.md).

## Worktree observations

`WorktreeObservations` composes official FileSystem, WorktreeGit and the owning
FileLocks instance. Inspection/listing acquire the repo lease; information reads
inside mutations reuse their caller's lock. Failed Git observations do not become
phantom dirty records or null HEAD. Queued cancellation and command cleanup remain
structured inside this kernel. The Promise manager's `runObservationLegacy` composes through `runWorktreeLegacy`,
which executes in the existing `fileLocksLegacy` runtime, with no second lock coordinator.
Delete it when the mutation owner receives native services. Synchronous manager
path/existence methods, setup, GC and the daemon runtime still need migration. See
[the decision](../notes/implemented/architecture/2026-10-10-effect-worktree-observations.md).

## Streams token refresh

`LoroStreamsTokens` / `LoroStreamsTokensLive` own native credential admission,
shared refresh leases and encrypted-cache publication. Each provider has its own
ports and Scope. Waiter deadlines retire only that waiter; last-lease release and
replacement/close abort and join actual I/O. Failed joins retain raw/provider
owners and the full Cause, and require explicit recovery before handoff.

The official CLI cloud root supplies the native platform token port. Remaining
renderer and Machine RPC callers use the sole
`createLoroStreamsTokenProviderLegacy` facade and visible
`createTokenProviderLegacy` port/type. Renderer teardown and CLI cloud-port
shutdown await provider close. CLI durable transport and machine monitor borrow the
workspace-native provider through `{provider, executor}` in that same facade,
creating no extra runtime/cache. This is token ownership, not completion of upper
Loro/daemon lifecycles. [API and decision](../../packages/shared/src/loro-streams-token/README.md).

Native getToken/auth preserve terminal typed failure; only the explicit Legacy
old-protocol callback projects a nonempty all-auth Cause to undefined. Mixed Causes
retain non-auth reasons. Native `health` and `describeLoroStreamsTokenCause` expose
safe state/counts and failure kinds without tokens, credentials or raw error payloads;
keep the original Cause separately for recovery.

## Workspace presence

The CLI root provides `WorkspacePresenceOwners` alongside its shell cache. Product
`doc.ts` and bridge readers use `createCliPresenceRuntimeLegacy`; its execution
borrows that application runtime. `workspace-presence.ts` owns heartbeat and remote
generation Scopes, while `presence-replica.ts` keeps CRDT state synchronous.
`platform/presence.ts` supplies the published native SDK without a Promise transport
coordinator. Delete the sole Legacy door when doc/Session/reader consumers directly
compose the service. Full Causes and retained cleanup owners survive root disposal;
explicit retry proves actual SDK and token cleanup before handoff. Session-active
leases and local relay pacing remain P6/P7. See the
[decision](../notes/implemented/architecture/2026-10-12-effect-workspace-presence.md).

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

Session credential acquisition also has a temporary `acquireSessionCredentialsLegacy`
facade (`session/session-credentials.ts`): the Effect broker lease's scope follows
preparation into the live Session and closes on failure/termination. The separate
`makePreparationControlLegacy` facade owns only the preparation TTL and its awaited
close receipt. Claim stops that control without closing runtime resources. These
are bounded resource migrations; Session/ACP/worktree Promise orchestration has
not become Effect-native merely by using these facades.

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

For lifecycle changes, select the applicable behaviors from this acceptance matrix:

| Mechanism         | Observable acceptance                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| Queue/admission   | Cancelled waiters cannot acquire later; preserve ordering and reentry policy                    |
| Resource/body     | Failure or interruption releases acquired resources before a successor proceeds                 |
| Shared work       | One reader's cancellation preserves other leases; the last release awaits producer cleanup      |
| Close/replacement | Concurrent close joins one receipt; a new generation waits for confirmed old release            |
| Deadline/retry    | Clock-driven expiry is observable; body/release failures do not become acquisition retries      |
| Release failure   | Retain the unresolved owner and full Cause, including simultaneous body/release failure         |
| Composition       | Real consumers use the kernel; applicable filesystem/process/protocol boundaries remain covered |

Confirm readiness with an explicit signal before advancing time or cancelling. Await
the affected fiber and cleanup, then inspect resulting resource/data state. Pure
helpers use ordinary tests; workflows substitute service Layers; platform adapters
retain real-boundary regressions. Do not replace coverage with source-string or
mock-call-only assertions. Use temporary ablations for important coordination
mechanisms to confirm that removing them makes behavior tests fail; restore and
recheck the baseline, keeping experiment scripts outside tracked product code.
Link the tested revision and limits from the owning Note. Passing local checks does
not establish untested platforms, packaged installation or production behavior.

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

## Local worktree preparation

`LocalWorktreePreparation` composes official FileSystem, WorktreeGit and Clock under
an already-held mutation lease. It owns the metadata scratch directory before
writing and publishes only a complete file. Failed five-second cleanup retains a
bounded recovery Effect. The manager's `runWorktreeLegacy` preserves primary and
scratch release failures through the existing fileLocksLegacy runtime. Delete the
executor when native mutations receive services; bare clone/fetch, setup and GC
remain outside this finite unit. See the [decision](../notes/implemented/architecture/2026-10-10-effect-local-worktree-preparation.md).
