# Reconcile session worktrees from archived state instead of machine commands

Status: implemented
Translation: pending

## Abstract

Archiving a local-project Session left its worktree and skipped the cleanup script
([#377](https://github.com/LodyAI/Lody/issues/377)): the daemon resolved the project root
from legacy machine metadata while, since CLI 0.71.0, the catalog lived only in Machine
Flock. The fix replaces the archive and delete command queues with reconciliation: the
daemon scans the Lody-managed worktree tree and removes any directory whose root Session
is archived or deleted, after a backup commit and without deleting the branch. Nothing is
acknowledged, so a wrong read cannot lose a cleanup; a directory that still exists is the
only evidence that work remains. Unknown Sessions are never touched, and the sweep waits
for complete workspace metadata.

## Problem

`archiveSessionResources` passed only legacy `machineMeta.localProjects` to
`resolveWorktreeCleanupTarget`; the Flock `localProject` rows were an optional parameter
that defaulted to an empty map, so the omission was type-correct and silent. The
permanent-delete path did not expose the gap because its command carried
`originalRootPath` from the requester. Community PR
[#382](https://github.com/LodyAI/Lody/pull/382) fixed the missing parameter and then
added readiness gates and fail-closed reads for the races the fix exposed: a command
could be consumed before the data it needed arrived, and a transient Flock read failure
acknowledged a cleanup that never ran.

## Decision

- Archive and delete are state, not commands. The UI and `lody session archive|delete`
  write `isArchived: true` or delete the Session doc and nothing else. The daemon
  observes `isArchived` (releases the runtime) and doc deletion (deletion barrier,
  operation-store cleanup), then schedules a worktree sweep.
- `WorktreeGarbageCollector` (`apps/cli/src/session/worktree/worktree-gc.ts`) enumerates
  `<data>/repos/<repoId>/worktrees/<sessionId>` and asks the workspace about each owner.
  `archived` and `deleted` (loro-repo's soft-delete marker) remove; `active` and
  `unknown` skip. `unknown` is not evidence: one data directory serves every workspace
  the machine joins. The repository source is read from `<repoDir>/meta.json` (local)
  or the presence of `bare.git` (GitHub); a worktree whose repository is gone is removed
  with a plain directory delete.
- The sweep runs only once `hasCompletedInitialMetaSync()` is true (local mode is
  always complete), on archive and delete events, and every ten minutes. Failures back
  off per directory (30 s doubling to 1 h) and are never final.
- Branches are never deleted by archive or delete. `removeWorktree` gained a
  `preserveBranch` option, used by local-project removal; `archiveWorktree` already kept
  the branch.
- Cleanup scripts run once before removal; a failing script is logged and recorded in
  Session history but does not keep the directory.
- Legacy `cmd/archiveSession`, `cmd/deleteSession` rows and the legacy
  `needToArchiveSessions` / `needToDeleteSessions` maps are discarded at daemon start
  without processing. Their Sessions carry the same archived or deleted state.
- The shared command builders (`buildMachineArchiveSessionCommand`,
  `buildMachineDeleteSessionCommand`, `session-delete-queue.ts`) are removed; the row
  types and parsers stay so old rows can be read and discarded.

## Alternatives

- Keep the command queue and fix the missing parameter (#382). Rejected: every race it
  then had to handle came from consuming a command whose supporting data syncs
  separately; the readiness gate also blocked runtime release for unrelated Sessions.
- Make the archive command self-describing (carry `originalRootPath` like delete).
  Rejected as the primary fix: the legacy boolean queue cannot carry a payload, and the
  ack problem remains.
- Treat `unknown` owners as orphans after metadata sync. Rejected: a machine in several
  workspaces would delete another workspace's live worktree.

## Evidence and limits

`worktree-gc.test.ts` uses real git repositories (local-shared and bare GitHub layouts)
and an injected clock to cover removal with backup commit and preserved branch, unknown
and active owners, the metadata-complete gate, runtime-release deferral, a vanished
repository, a failing cleanup script, retry backoff, and sweep coalescing.
`message-handler-terminal-cleanup.test.ts` covers runtime release on archive, deletion
barrier, legacy record discard, and an end-to-end archive of a local-project Session
with no project catalog at all. UI and CLI suites assert that no machine command or
queue is written.

Not verified here: a live desktop run across a cloud reconnect; whether loro-repo's
deletion marker survives long-term compaction. The local-project removal dialog still
promises to keep dirty worktrees, which the archive rule later removes after a backup
commit; that dialog is a follow-up. Contract:
[`specs/session-worktree-lifecycle.md`](../../../../specs/session-worktree-lifecycle.md).
