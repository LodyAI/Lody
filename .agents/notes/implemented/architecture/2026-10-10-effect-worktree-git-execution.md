# Native worktree Git execution and failure preservation

Status: implemented
Translation: current

[中文](2026-10-10-effect-worktree-git-execution.zh.md)

## Abstract

Worktree Git commands already used the shared process backend, but their Promise
boundary erased exit status and broad manager catches could turn process startup,
timeout or unresolved release into successful fallback. Credential-helper probes
also had no deadline. WorktreeGit now owns command execution, environment lookup,
status checking and helper protocol in native Effect, with dependencies supplied
through Layers and each command owning its process Scope. Its one Legacy facade
preserves recovery leases and distinguishes infrastructure failure from Git exits.
This is the execution prerequisite for a native manager; worktree/setup/GC and
HTTP diagnostics remain Promise orchestration and are not completed by this unit.

## Ownership and dependencies

WorktreeGitLive captures official FileSystem, ChildProcessSpawner and WorktreeGitHost.
The host provides an Effect reading environment per command; the explicit per-call
overlay wins, and Git remains noninteractive. worktreeGitLayer only composes the
fixed official Node filesystem adapter, host and existing CLI process/logger Layer.
Default composition retains logger references in its Layer output so command
diagnostics reach the supplied daemon sink. The service owns no cache, background
fiber or long-lived acquisition. Commands
compose runCommand directly, retaining the bounded Lody process backend and its
normal-completion policy for intentional helpers. Cancellation/deadline/output
failure waits for tree cleanup; unresolved release remains observable and owned.
This adds neither another spawn/output/termination implementation nor a daemon runtime.

The manager consumes this kernel through the one deprecated worktreeGitLegacy
object. Only this boundary executes Effect, delegates AbortSignal and projects
complete failure with squashProcessFailure. Delete it when WorktreeManager itself
composes WorktreeGit. The previous synchronous mapGitSpawnError is removed after
its production caller migrates; the stable unavailable-Git error/classifier remains.
Native ENOENT classification checks cwd through injected official filesystem:
a missing cwd is not missing Git, and permission failure does not imply absence.

This unit is stacked on [native local-project Git](2026-10-10-effect-local-project-git.md)
and its [process release prerequisite](../bug-fix/2026-10-10-effect-process-release-failure.md).
It does not depend on FileLocks internally. The native manager must integrate it,
LocalProjects and [FileLocks](https://github.com/LodyAI/Lody/pull/1377) before setup/GC
or Session can claim structured cancellation. The existing
[roadmap](../../proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.md)
owns those separate dependency units.

## Failure contract and pinned-version evidence

WorktreeGitCommandFailed retains a completed command's code, signal, stdout and
stderr. WorktreeGitExecutionFailed identifies startup, filesystem classification,
timeout, output or stream failure. Existing manager catches rethrow infrastructure
and unresolved release rather than interpreting them as missing refs, default
identity, best-effort fetch success or permission to forcibly remove a directory.
Ordinary helper diagnostic failure can be recorded while the original failed Git
operation still fails; a diagnostic's unreleased process cannot be swallowed.
Git exit fallback policy remains for the manager migration to classify precisely.
Git's ten-minute deadline and 64 MiB output ceiling are unchanged. Helper probing
now has a five-second deadline and retains the shared one MiB output ceiling.
The [worktree lifecycle Spec](../../../../specs/session-worktree-lifecycle.md)
remains draft and records this failure guarantee.

Installed Effect 4.0.2 source shows mapError implemented through catch, which
selects a Fail reason. With a command timeout plus a release defect, using that
operator on the full completed command loses the ProcessReleaseFailed owner.
A failing resource-state test reproduced the loss. The service uses catchCause
and Cause.map to preserve all reasons; asynchronous ENOENT classification occurs
only for a single typed failure. Recovery tests cover both Git and helper and
verify projected ProcessCleanupFailed leases remain usable after failure.
Official [service/Layer documentation](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Layer.ts)
and [FileSystem documentation](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/FileSystem.ts)
were checked against installed v4 source; v3 examples are not the implementation.

## Validation and limits

Native tests use Deferred and TestClock for deadlines, interruption and recovery.
Existing real-Git creation/query/removal/GC suites retain their behavioral coverage;
manager regressions observe rejected operations and retained uncommitted files.
The owning suites pass 32 cases, and seven related consumer suites pass 99.
Eleven ablations are caught: removed Git/helper deadlines, lost Git/helper release
owners, frozen host environment, dropped caller overlay, accepted failed exit,
missing cwd classified as unavailable Git, swallowed cwd permission, swallowed
manager infrastructure failure and lost logger context. Baseline and restored
source pass. Initial experiment setup lacked a public ACP relative path and failed
suite loading; correcting only the experiment layout restored the baseline.
Experiments stay outside product code; no source-string or mock-count tests are introduced.
Final CLI types and formatting/docs checks pass. Full pnpm check passes types
and lint (zero errors), then stops at the Roost signed-prefix thirty-second timeout
previously reproduced on clean main: CLI has 3707 pass, one fail and one skipped.
The independent FileLocks/LocalProjects integration foundation has a green complete
check; that is evidence for those dependencies, not a green check for this revision.
Supplemental shared testing passes 113 files / 1386 cases, Electron passes 214
cases, and process/platform/public/import/i18n guards pass. The isolated full CLI
rerun is still pending. Git contamination is isolated only in validation children;
no global Git configuration or original dirty submodule gitlinks are changed.

Local Linux tests cannot establish real Windows descendant ownership after root
exit, delegated cgroups, packaged installation or production behavior. This does
not provide Git rollback, a crash transaction or end-to-end Session cancellation.
The manager's mutable configuration/cache, synchronous filesystem work, Promise
parallelism, HTTP diagnostic timer and setup/GC background owners remain to migrate.
A failed cleanup transfers recovery ownership through Cause/Legacy failure; it does
not install a repository quarantine or root owner registry. The daemon root runtime
still belongs with actual long-lived service integration.
