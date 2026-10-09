# Official Effect process service with bounded Lody ownership

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1065

[中文](2026-10-09-effect-official-process-service.zh.md)

## Abstract

The first process migration unified OS calls but left an unscoped spawn API and
manual container ownership. The refactor adopts Effect 4.0.2's official
ChildProcessSpawner contract, derived execution helpers and Node Stream/Sink
adapters, with scoped acquisition and rollback during interrupted setup. Lody
retains its bounded process-tree backend because the default Node implementation
cannot meet its shutdown and raw ACP/IPC requirements. CLI logging composition
no longer exposes Promise wrappers; unmigrated entry points use the shared
compatibility functions directly and may supply an explicit cancellation signal.

## Official capability and backend boundary

`ChildProcess.make` describes work; `ChildProcessSpawner` is the injected
capability. `ProcessSpawnerLive` implements it using `ChildProcessSpawner.make`,
which derives `string`, `lines`, `streamString`, `streamLines` and `exitCode`.
Official NodeStream and NodeSink adapters handle stream reads, writes and
backpressure. `runCommand` now requires this service and collects its output
Streams concurrently, enforcing Lody's per-stream output ceiling.

This is adoption of the official interface and stream adapters, not use of the
default `NodeChildProcessSpawner.layer`. Reading the published
`@effect/platform-node-shared@4.0.2` source found:

- `terminateProcessGroup` performs bounded native-time polling but ends with an
  unconditional `Deferred.await(exitSignal)`. A root surviving SIGKILL can still
  prevent scope release from completing.
- Windows taskkill uses execFile without a deadline, and its completion is
  awaited in the finalizer. Lody retains its independently bounded taskkill.
- The backend exposes no raw ChildProcess needed by ACP stdio callbacks, IPC,
  immediate pid consumers and synchronous launcher/exit hooks.
- Default scoped release can kill descendants after a successful root exit.
  `runCommand` must preserve helpers deliberately left by a completed command.

The old v3 rejection based on missing escalation and compulsory environment
merging does not apply: v4 has `forceKillAfter` and `extendEnv`. These new concrete
constraints, not the v3 reasoning, justify the custom backend. No upstream source
is copied or patched. NodeProcess remains the single injectable OS seam, while
public Effect programs consume the official process service. Plain stdout/stderr
pipelines are supported; additional-fd and right-associated pipelines fail with a
typed BadArgument rather than silently performing different work. Existing raw
IPC callers retain their explicit compatibility entry point.

## Ownership and interruption

Both `spawnProcess` and `spawnScoped` require Scope. The backend registers its
release before awaiting start or running interruptible post-spawn work. An owner
hook failing after OS spawn is reported only after scoped release is registered.
Commands interrupted while collecting output release their process trees; failure
or cancellation during container configuration closes the newly forked child
Scope. Successful acquisition transfers ownership to the Session's parent Scope.
Container release ends tracked groups, including descendants whose leaders
exited, then releases host resources and stops monitor fibers. A closed native
container rejects new spawns. Only the reusable legacy noop sandbox opens a fresh
container and Scope for a later generation; a removed cgroup never reopens.

Containers share a process-tree registry, populated before configuration or
cgroup attachment. An attachment error (including ESRCH from an exited wrapper)
fails spawn and rolls back its child Scope. Groups that survive rollback remain
tracked; cgroup termination covers both the kernel subtree and those groups.
Cleanup removes only trees proven gone. Failed liveness probes retain ownership,
and the legacy noop adapter cannot replace a failed generation until its trees
are gone, even after its Scope has closed. Concurrent starts share the replacement
owner rather than each creating a new generation.

Cgroup membership reads are strict. Permission/I/O errors, missing control files
in an existing directory, and invalid populated state produce TerminationFailed.
Only confirmed directory absence (or a successful empty membership read) proves
absence. cgroup.events is a required initialization capability. Best-effort cleanup
logs failures and retains the directory and trees for retry instead of claiming
release. Optional accounting counters retain their existing best-effort policy.

The shared Promise runner forwards an explicit AbortSignal to runPromiseExit.
It still starts a separate root fiber: wrapping it in tryPromise without forwarding
that signal cannot propagate cancellation, and even forwarding a signal does not
make an outer Promise wrapper await the nested finalizers automatically. Effect
callers must yield the service. Synchronous legacy startProcess remains manually
owned and supports an explicit signal; callers needing proof of termination await
its terminate method. It is not represented as a scoped Effect acquisition.

## CLI composition and stack ownership

The redundant CLI promise-facade.ts is deleted. process-options.ts only composes
logger and injected services; it executes no program. Existing Promise consumers
import shared compatibility APIs directly with these options. The process core,
ACP callers, containers and this decision belong to #1065. Remaining CLI import
changes and guard guidance belong to #1069; cross-runtime consumers inherit the
service through #1348 without another implementation.

## Validation and limits

Behavioral tests cover official output helpers and a pipeline, replacement
environments, scoped interruption, orphaned descendants, owner-hook failure,
container setup cancellation and explicit Promise-entry cancellation. Existing
termination, output, timeout, failed-spawn and real isolated process cases remain.
Tests use readiness signals and TestClock; there are no new real sleeps. The fake
process table now uses Node streams so it exercises the official adapters.
Regression cases cover ESRCH with a live descendant, failed rollback and retry,
failed noop cleanup/reuse, and EACCES/EIO/ENOENT membership reads. Restoring the
original container implementations makes the corresponding regression cases fail.

Real Windows, delegated Linux cgroups and signed desktop packaging remain outside
local verification. Job Objects are still needed to retain Windows descendants
whose root exited. The Session/ACP/Turn layers remain under migration; this work
does not claim end-to-end structured cancellation through their Promise APIs.
