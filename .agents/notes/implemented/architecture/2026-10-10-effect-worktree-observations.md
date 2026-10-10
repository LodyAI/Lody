# Native worktree observations

Status: implemented
Translation: current

PR: [#1392](https://github.com/LodyAI/Lody/pull/1392)

[中文](2026-10-10-effect-worktree-observations.zh.md)

## Abstract

Worktree queries previously ran Promise sequences under callback locks and could
represent a broken repository as a dirty worktree with a missing HEAD. The native
WorktreeObservations service now composes official filesystem operations, WorktreeGit
and the owning FileLocks instance. Inspection and listing own their repo lease until
command cleanup completes, and cancellation removes queued queries permanently.
Existing manager callers execute this kernel through a named Legacy boundary;
mutation, setup, GC and daemon ownership remain separate work.

## Responsibilities and decisions

The service captures FileSystem, WorktreeGit and FileLocks through Layer.effect. It
owns no background work or cache. `inspect` and `list` acquire the existing repo lock
with the existing 120-second cross-process timeout; local admission remains unbounded
as defined by the [file-lock contract](../../../../specs/file-lock-lifecycle.md).
`info` deliberately does not acquire another repo lock: creation and rename callers
already hold it. `currentBranch` preserves the previous unlocked read boundary.
A failed bounded process release retains its recovery lease in the error; releasing
the file lease does not assert that the external process is gone or quarantine the repo.
Each Git command owns its process Scope through [WorktreeGit](2026-10-10-effect-worktree-git-execution.md).

Official stat follows symbolic links in installed 4.0.2. Listing preserves the former
Dirent policy using readLink before stat; only an original EINVAL means a non-link.
NotFound can represent a disappeared entry/root, but permission and other failures
remain errors. This is an observation policy, not protection against filesystem races
or a transaction across Git invocations.

A completed Git exit can produce an explicit failed inspection. It cannot silently
produce a dirty record, null HEAD or incomplete successful list. Only a named branch
with a missing exact ref is unborn; an existing invalid ref remains a failure. Mapping
and recovery preserve a mixed Cause so a release defect cannot disappear alongside a
Git exit. This strengthens failure visibility in the existing draft
[worktree contract](../../../../specs/session-worktree-lifecycle.md).

The Promise manager freezes source fields for each invocation and calls
`runObservationLegacy`, which executes through the existing `fileLocksLegacy` runtime.
It does not create another lock coordinator, queue or ManagedRuntime. Unknown defects
are infrastructure failures at this boundary; complete process recovery leases retain
the shared failure projection. Delete this helper when the mutation owner receives the
native services. `worktreeGitLegacy` remains needed by mutations and diagnostics;
no shared process Legacy API is removed in this unit.

## Evidence and limits

The owning query suite covers real repositories, renamed/detached branches, dirty
files, unborn/corrupt refs, missing directories and symbolic-link filtering. Injected
Effect ports and explicit Deferred signals cover cancelled queue admission, awaited
cleanup before lease handoff, failure release, immediate reentry rejection, filesystem
denial and mixed Cause preservation. Native integration also composes the real WorktreeGit kernel and FileLocks with the
controlled process backend, checking descendant cleanup and retained recovery leases.
Behavioral ablations run only in temporary copies.

The owning query suite has 19 passing behaviors. Eight related CLI suites pass
115 tests on the foundation containing main 6de54b66b1a1cf812cd6f5c6fda40a3e0284c94e,
including the actual local-project removal workflow and runtime credential leases.
Six ablations are caught; their baseline/restored query suite passes 16 tests, before
three additional process/removal integration cases were added. Workspace type checks and type-aware lint pass (zero errors). The full pnpm check
stops at two 30-second Roost timeouts: signed-prefix reuse and active-goal cache rebuild;
CLI has 3730 passing tests and one skip. Both timeouts reproduce when run together
on the unmodified integration baseline 864cfa67; active-goal passes on this branch
in the same isolated comparison, while signed-prefix still times out. Shared tests
pass 113 files/1399 tests, Electron passes 215, and all i18n/import/process/platform/
public guards pass separately. pnpm format, format:check and docs check pass; protected
review topics are empty. These results do not assert a green full-workspace check.
Linux local execution does not establish Windows behavior, delegated cgroups, packaged
installation or production operation. Synchronous manager path/existence methods remain
blocking; mutation/setup/GC orchestration and end-to-end Session cancellation are not
completed by these observations.

The dependency graph remains in the original
[roadmap](../../proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.md).
Prerequisites are [#1377](https://github.com/LodyAI/Lody/pull/1377),
[#1379](https://github.com/LodyAI/Lody/pull/1379),
[#1381](https://github.com/LodyAI/Lody/pull/1381) and
[#1389](https://github.com/LodyAI/Lody/pull/1389); they are draft reviews, not merged work.
