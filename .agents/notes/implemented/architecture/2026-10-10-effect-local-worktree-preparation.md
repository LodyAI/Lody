# Native local worktree source preparation

Status: implemented
Translation: current

[中文](2026-10-10-effect-local-worktree-preparation.zh.md)

## Abstract

Local worktree preparation previously mixed synchronous filesystem operations,
Promise Git validation and a direct metadata write. LocalWorktreePreparation now
owns that sequence through official FileSystem, WorktreeGit and Clock, under its
caller's existing repo lease. A temporary directory is registered before writing;
a complete file is published exclusively, and bounded cleanup retains a recovery
owner on failure. Actual ensureRepo/create consumers use this kernel through the
existing Legacy runtime. Bare clone/fetch, mutations, setup, GC and daemon ownership
remain separate dependencies.

## Responsibilities and decision

The finite service captures FileSystem and WorktreeGit through Layer.effect. Its
prepareLocked operation requires the mutation caller to hold the existing repo
lease; it does not reacquire a lock, create a queue or own another ManagedRuntime.
The manager snapshots path/source fields per invocation and supplies its installation
root using getLodyDataDir. That root is created before a path reaches Git, preserving
LodyDataDirUnavailableError and the [path-root decision](../bug-fix/2026-09-14-lody-data-dir-path-root.md).
Source directories, Git validation argv, sourceGitDir and the metadata shape stay
compatible. Existing metadata is preserved byte-for-byte; user files and persistent
data directories are not compensation resources.

The acquisition owns an official temporary directory before any file write. In
installed 4.0.2, makeTempFileScoped performs its initial write during acquisition,
so failure there can precede registration of its directory release. Reusing the
primitive directory operation avoids this window without a second filesystem
backend. Metadata is written inside the registered directory, then hard-linked to
meta.json exclusively on the same filesystem. Only that publication is masked;
validation, Git and preparatory writing remain interruptible. AlreadyExists preserves
a concurrently installed metadata file; every other failure remains observable.
This prevents partial publication during local cancellation/failure, not power-loss
durability, a Git transaction or protection against hostile filesystem races.

Scratch release uses an explicitly interruptible removal with a five-second Clock
deadline, including inside the normally masked finalizer. LocalWorktreeScratchReleaseFailed
retains the unique directory, complete failure Cause and a bounded retryCleanup
Effect. Completion after timeout means failed cleanup with ownership retained, not
confirmed removal. Node filesystem I/O already submitted to the kernel may still
settle after local waiting ends; retries address only this unique scratch path.
A successful publication followed by failed removal still rejects the operation.
The [draft worktree contract](../../../../specs/session-worktree-lifecycle.md)
records this stronger publication and failure guarantee.

The single manager runWorktreeLegacy execution helper obtains Exit through the
existing fileLocksLegacy runtime. Process failures keep the shared projection;
scratch release defects are retained alongside the primary error and complete Cause
in an infrastructure AggregateError. Thus a preparatory write failure cannot hide
its unreleased directory. runObservationLegacy now only composes its observation
program and delegates to this same executor. Delete these helpers when the native
mutation owner receives its services; worktreeGitLegacy still serves unmigrated
Git command sequences. No public process Legacy export is removed by this unit.

## Validation and limits

Nine native ownership cases cover the injected Clock, partial write failure,
interruption before publication, concurrent publication, release failure, bounded
release timeout/retry, mixed Git/release Cause, the actual manager Legacy projection
and an unavailable installation root. Existing real ensureRepo/create suites also
exercise metadata preservation and recovery after an unavailable source. Eight
owning/consumer suites pass 126 cases. Seven isolated ablations are caught by
these behaviors: unowned scratch, swallowed release, partial publication, overwrite
of a competing metadata owner, wall-clock timestamps, discarded mixed Git/release
Cause and discarded scratch ownership at the actual Legacy manager boundary.
The restored native suite passes all nine cases; experiment scripts are outside
the repository.

Root pnpm check passes workspace types and lint (zero errors). CLI reports 3,742
passing tests, one skipped and one signed-prefix Roost timeout. That same case was
reproduced on the integrated base before this unit; no coverage is removed to make
the command green. Since test:ci stops there, Shared (113 files / 1,399 tests),
Electron (215 tests) and all five remaining i18n/import/platform/process/public
checks are run separately and pass. pnpm format, pnpm format:check and docs check
pass; no SHA-protected topic is changed. Git test configuration is isolated only
in validation child environments, without changing user global Git configuration.

Local Linux validation does not establish real Windows, delegated cgroups, packaged
installation or production behavior. Filesystem publication requires hard links,
as does the existing lock protocol. The finite service has no background task;
it does not migrate whole-worktree mutations, long-lived GC or session cancellation.
It complements [Git execution](2026-10-10-effect-worktree-git-execution.md) and
[observations](2026-10-10-effect-worktree-observations.md), whose native kernels are
independent dependencies of the later mutation owner.
