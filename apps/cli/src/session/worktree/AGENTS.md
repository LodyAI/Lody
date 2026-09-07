# apps/cli/src/session/worktree

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

Repo checkouts, worktrees, branch allocation, and setup scripts for sessions.
[../AGENTS.md](../AGENTS.md) and [apps/cli/AGENTS.md](../../../AGENTS.md) apply. Background
and file responsibilities: [../README.md](../README.md).

## Git credential broker

- INVARIANT: host-side git must receive its credential broker as an explicit argument
  (`WorktreeManager.ensureRepo({ brokerAuth })`), never from ambient `process.env`. Every
  workspace's `GitCredentialBroker` writes the same process-global `LODY_GIT_CRED_BROKER_*`
  pair and the shared `~/.lody/broker.json`, and `ensureStarted()` early-returns, so the
  ambient value belongs to whichever workspace started or recovered its broker LAST and the
  correct workspace never takes the pointer back. A session in workspace A would then
  authenticate through B's token manager and fail with `repo_not_linked` →
  `terminal prompts disabled`.
- Keep `brokerAuth` a per-call argument: `getWorktreeManager` caches by `repoId` alone, so two
  workspaces sharing a repo share one manager instance. The helper's connection-refused
  fallback is scoped by `LODY_GIT_CRED_BROKER_STATE_FILE`
  (per-workspace `broker-<workspaceId>.json`) for the same reason. Diagnostics must probe the
  same broker the failing command used, or they report a misroute as the caller's workspace
  lacking the repo link. Regression test: `worktree-manager-broker-auth.test.ts`.

## Worktrees, branches, and setup

- Post-turn automatic commit/push is allowed for GitHub worktrees and local projects with
  `ProjectRef.useWorktree === true`. Never run it against a local project's original directory,
  even when that project has a `githubRepoFullName` or associated PR.
- Resume a Session on a local project with the workspace's current branch as-is, worktree mode
  included: a persisted `acpSessionId` proves prior execution, so the stored `project.branch` is
  historical state, not a checkout request. A legacy direct local Session may re-enter
  `session/create` when no ACP session is resumable; initial `session/create` writes `project`
  metadata before dispatch, has no ACP session id, and must retain an explicitly requested branch.
  ACP restore and legacy direct-session reinitialization must never switch back to the Session's
  recorded branch.
- A fresh local/GitHub worktree always owns a newly allocated branch from its selected base
  ref; suffix collisions instead of attaching to an existing ref. Reattaching an existing
  branch is reserved for an explicit `restoreBranchName` from the same Session.
- Worktree setup scripts are per worktree-directory lifetime: session runtime restore after
  idle GC must skip setup when the session's worktree directory already exists, but setup still
  runs when a missing worktree directory is materialized again.
- INVARIANT: speculative-worktree marker mutations are read-check-act on one file and are
  serialized per session (`withSessionMarkerLock` in `speculative-worktree.ts`) — a superseded
  preparation's dispose racing its replacement's materialization must never delete the
  replacement's directory.
- A prepared worktree may be adopted only when the durable claim did not return `mismatch` AND
  its directory still exists on disk; otherwise discard the prepared runtime (its ACP process
  cwd points at a dead inode) and let the cold path rebuild via `createWorktree`. A `mismatch`
  claim deletes the mismatched directory, so adoption after it hands the session a path that is
  not on disk.
- `worktree-config-resolver.ts` follows the durable launch-config rule in
  [../AGENTS.md](../AGENTS.md): do not write per-session `sessionLaunchConfig`.
