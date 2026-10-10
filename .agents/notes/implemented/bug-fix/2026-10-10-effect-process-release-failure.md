# Failed process Scope release retains a recovery lease

Status: implemented
Translation: current

PR: [#1379](https://github.com/LodyAI/Lody/pull/1379)

[中文](2026-10-10-effect-process-release-failure.zh.md)

## Abstract

A successful Effect body could report success after its process Scope failed to
terminate a tree: the finalizer logged and swallowed TerminationFailed. Native
Git migration exposed this lower-level gap. The finalizer now fails observably
and transfers the unresolved tree to a recovery lease carried by its defect;
Promise boundaries preserve all such leases alongside a simultaneous body error.
Recovery reuses the existing bounded backend and confirms absence before retiring
that generation. This repairs process-tree release reporting, while Session
shutdown coordination and drained-stdio guarantees remain separate work.

## Decision and ownership

The [official process service decision](../architecture/2026-10-09-effect-official-process-service.md)
retains the bounded Lody backend. That decision's failure reporting was incomplete:
its Scope finalizer's catch branch converted failure into a warning. Replacing
that backend or adding another termination loop would not repair ownership.

The finalizer still logs its target and ensures a ProcessReleaseFailed defect even if that diagnostic throws. Release
has no typed error channel in acquireRelease; the defect is present in the Scope
Exit instead of being returned as successful release. It privately retains the
original ManagedProcess and bounded policy. Its isAlive and retryTermination
Effects require no new OS service and remain usable after that Scope has closed.
The receiver keeps this lease until absence is established. Retry failure leaves
it live; a force policy may immediately converge with an ongoing graceful retry.
Once absence is observed, a Ref retires the lease; active retries consult that
state on every probe and signal, so they cannot signal a
reused numeric process identifier. This is not protection against identifier reuse
before absence has been observed.

Cause.squash chooses a primary error and can lose simultaneous cleanup defects.
The pure squashProcessFailure projection retains every ProcessReleaseFailed
reason in ProcessCleanupFailed when there is another primary failure or multiple
leases. runPromiseSquashedLegacy uses that projection; no extra runner or process
implementation is introduced. Existing ordinary command errors remain unchanged
when cleanup succeeds. Native Effect owners inspect the full Cause; compatibility
owners retain the projected failure. Repeating Scope.close is not recovery.

The [draft Spec](../../../../specs/process-scope-release.md) names the receiver's
responsibility. No root registry, automatic retry service or Session coordinator
is claimed by this unit. A caller discarding its failure can still abandon that
responsibility; upper-layer migration must replace such handling. Successful
commands continue preserving helpers deliberately left running.

## Validation and limits

The existing process suite covers a successful body with failed release, failed
retry retaining its lease, forced recovery during a graceful retry, observed-gone
identifier reuse, multiple leases crossing the Promise boundary and timeout plus
release failure. It uses injected process tables, Deferred readiness and TestClock.
Native Git's additional cancellation and failed-release cases exposed the bug and
remain in that later unit. The final owning suite passes 40 cases; shared passes all 113 files / 1376
cases and Electron passes 214 cases. Seven ablations are rejected by these behavioral
tests: swallowed Scope failure, dropped Promise leases, missing retirement,
pretend retry success, logger failure discarding the owner, an active retry ignoring retirement and
masked recovery wait. Baseline and restored source pass. The cancellation case uses an explicit
Clock wait plus TestClock: the latter's initial warning semaphore can make a
masked sleep interruptible, so plain sleep did not distinguish the mask mutant.

The full check uses main 339eede8592e237320e72f6f63c07aaa44591197. Publication refresh found main 385f1a7278ad8a461919981494836fbdc9c980e6; its intervening documentation/UI changes do not overlap this unit.

Final pnpm check passes, including the full CLI suite (317 files / 3694 cases,
one skipped), shared, Electron and all guards. Type-aware lint reports zero
errors; format, format:check and docs check pass. Validation child processes
isolate injected Git configuration, temporary-package type and lock-directory
overrides without changing user-global configuration. The previously reproduced
Roost signed-prefix timeout passed in the final complete runs. These results do not establish real Windows, delegated cgroups, packaging
or production behavior. Windows descendants after root exit still need separate
Job Object ownership work. Lease recovery establishes tree absence, not drained
stdio or complete external-resource release.
