# apps/cli/src/session/worktree

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

Repo checkouts, worktrees, branch allocation, and setup scripts for sessions.
[../AGENTS.md](../AGENTS.md) and [apps/cli/AGENTS.md](../../../AGENTS.md) apply. Background
and file responsibilities: [../README.md](../README.md).

## Effect execution boundary

- Native Git commands/helper probes compose `WorktreeGit` / `WorktreeGitLive`.
  Layers supply official filesystem, host environment and the existing process
  spawner. Preserve full Cause; Legacy projection uses squashFileLockFailure.
  Pinned v4 mapError/catch can discard release defects beside a typed failure.
- `worktreeGitLegacy` is the temporary command facade; keep Legacy
  visible; delete it when the manager becomes native. Infrastructure,
  FileLockCleanupFailed/LockReleaseFailed escape fallback/forced-removal catches.
  `WorktreeObservations` uses owner-provided FileLocks: inspect/list acquire;
  info borrows the mutation lease. Preserve missing/unborn/corrupt and mixed Cause.
  `LocalWorktreePreparation.prepareLocked` borrows that lease; own scratch before
  writing, publish complete metadata exclusively, retain bounded recovery on
  failed release. `runWorktreeLegacy` executes both via fileLocksLegacy;
  runObservationLegacy only composes. Never add a second coordinator.
  Mutation/setup/GC remains unfinished.
  Decision: [worktree Git](../../../../../.agents/notes/implemented/architecture/2026-10-10-effect-worktree-git-execution.md).

## Git credential broker

- Local projects/worktrees and locally resolved Members use native Git/GitHub
  auth. Never enroll them on refresh; pin `repositoryCheckout` through archive/restore.

- Host clone/fetch must receive the prepared session's managed Git PATH/GIT_EXEC_PATH/config in
  `brokerAuth.transportEnv`, not just a helper: HTTP headers authenticate before
  helpers. Include the managed credential helper for checkout/LFS and scrub non-owner
  token env. Pin the per-call owner context; never read a mutable session file.

- INVARIANT: host-side git must receive its credential broker as an explicit argument
  (`WorktreeManager.ensureRepo({ brokerAuth })` or the per-call `createWorktree` argument),
  never from ambient `process.env`. Every
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
- `createWorktree` owns clone/fetch under its repo lock: callers must not pre-fetch
  separately. Clone a missing cache before validating a persisted restore branch.
  The same frozen auth must reach checkout and retries too (smudge/LFS can fetch).
  With no broker, use native Git credentials; never install a context-dependent
  helper or borrow the ambient workspace broker. Test actual worktree creation
  with the generated helper, not just the preliminary `ensureRepo` spawn.

## Worktrees, branches, and setup

- First-task branch naming is agent guidance for ordinary new independent GitHub/local
  worktree Sessions. The daemon verifies the actual branch
  after setup against this Session's allocation (numeric collisions included); unknown or
  descriptive refs receive no rename instruction. Exclude direct folders, child Tabs,
  prior/resumed ACP Sessions, later turns, and Fork; never restore a host prompt-to-ref
  generator. Contract: [workspace branches](../../../../../specs/workspace-branch-state.md).
- Turn finalization NEVER commits or pushes on the session's behalf, in any project shape.
  A PR-linked session that ends with unpublished work is reported through
  `SessionMeta.workspaceDirty` AND `workspaceUnpushed`, which raise the Info Bar's
  `Commit & Push` action; the agent is asked to keep the branch current by the Create PR
  prompt (`packages/shared/src/pr-prompts.ts`), which the user can override in
  conversation. Do not re-add an automatic post-turn commit/push.
- Publish BOTH flags or the signal has a hole: `git status` goes clean the moment the agent
  commits, so a commit whose push failed reads as "all clear" and the Info Bar offers Merge
  against a PR head that is a commit behind. The two probes are independent — one being
  inconclusive must not suppress the other, and an inconclusive probe contributes no key so
  the durable value survives instead of becoming a stale `false`.
- Because these flags are now the ONLY unpublished-work signal, BOTH cancellation routes must
  refresh them via `syncWorkspaceGitState`: the one in `finalizeTurn` (Stop raced finalization)
  and `finalizeCancelledTurn` (Stop during the prompt — the common one). That helper owns
  the GitHub-capability gate itself because those callers carry no `ProjectRef`; do not
  re-test it per call site. Single-project flags need a GitHub
  repository; Project groups publish the OR across members.
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
- Nothing writes speculative-worktree markers any more; `legacy-speculative-worktrees.ts`
  handles those older daemons left. Creation claims its marker before probing the directory
  and reruns setup before dropping it. NEVER destroy a worktree a Session adopted
  (`durable-pending-setup`, or a `restoreBranchName`) over a target mismatch: removal deletes
  the branch resume restores. Only unadopted mismatches rebuild. The sweep removes orphans of
  non-durable, inactive Sessions under the shared per-session lock, re-checking liveness.
- `worktree-config-resolver.ts` follows the durable launch-config rule in
  [../AGENTS.md](../AGENTS.md): do not write per-session `sessionLaunchConfig`.
- Worktree archive/delete keeps branches and requires a backup commit. `worktree-gc.ts`
  reconciles Session state (no command/acknowledgement): only archived/deleted root owners
  after complete metadata; unknown stays intact.
  Chat workdirs: delete recursively for deleted roots; archive uses empty-only `rmdir`.
  Contract: specs/session-worktree-lifecycle.md.

- Project roots use registrations. Repair links, never removing a correct one (tabs share
  it); archive unlinks without following targets.
  Submodule init uses actual gitlinks; backup requires its own checkout. Only complete,
  standalone, non-shallow repositories may lend objects.
