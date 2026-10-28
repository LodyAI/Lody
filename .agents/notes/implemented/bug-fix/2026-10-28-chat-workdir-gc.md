# Reclaim archived and deleted chat workdirs

Status: implemented
Translation: current

[中文](2026-10-28-chat-workdir-gc.zh.md)

## Abstract

No-project Sessions created working directories that survived archive and deletion
indefinitely. The existing worktree collector now also reconciles chat workdirs
against their root Session's state. Deletion removes recursively; archive uses
empty-only removal because these directories have no Git backup. Nonempty archived
directories remain on disk until the Session is deleted.

## Decision and evidence

- [Session](../../../../apps/cli/src/session/session.ts) derives its default workdir
  as `<getLodyDataDir()>/chats/<sessionId>`; child Tabs reuse their root's directory
  through [SessionManager](../../../../apps/cli/src/session/session-manager.ts).
  The [existing reconciliation decision](../architecture/2026-09-11-session-worktree-reconciliation.md)
  covered only repository worktrees. This extends its scope without changing Git cleanup.
- [GC](../../../../apps/cli/src/session/worktree/worktree-gc.ts) shares the complete-metadata
  gate, owner lookup, runtime deferral, in-flight exclusion and retry backoff. Only safe
  names with real directory entries qualify; symlinks are skipped. Active and unknown
  owners remain untouched, including directories owned by other workspaces.
- Archived directories use `rmdir`: `ENOTEMPTY` retains files without warning, failure
  or retry state. Deleted directories use recursive `rm`. Neither path runs scripts,
  records branches or invokes Git. Cleanup failures stay local to the directory and
  retry later; unreadable chats roots also back off, while absent roots return silently.
  Worktrees run before chat filesystem I/O. Chat retry/in-flight keys use directory paths,
  so even a worktree left by the same owner stays independent.
- [MessageHandler](../../../../apps/cli/src/lib/message-handler.ts) supplies the chats
  root from `getLodyDataDir()`. Existing Session and terminal resolvers recreate missing
  chat workdirs when needed. Contract: [lifecycle Spec](../../../../specs/session-worktree-lifecycle.md).

## Verification and limits

The [owning suite](../../../../apps/cli/tests/worktree-gc.test.ts) uses real temporary
directories and an injected clock to exercise retention/removal, metadata/runtime
gates, missing/unreadable roots, symlink/name filtering and recovery from injected
busy-directory or owner-read failures while an independent real worktree is removed.
All 22 GC cases and 24 terminal cleanup cases pass, along with CLI typechecking,
changed-file lint, formatting and documentation checks.
Full `pnpm check` passes in a subprocess using system Git without inherited
`GIT_*`/`LODY_GIT_*` variables.
Nonempty archived chat directories are deliberately not reclaimed before deletion;
there is no backup or recovery of files removed by permanent deletion. No live daemon
or cross-device acceptance is established by these tests.
