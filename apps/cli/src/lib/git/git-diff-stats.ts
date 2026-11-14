export type GitRunner = (args: string[]) => Promise<string>;

const isInsideGitWorktree = async (runGit: GitRunner): Promise<boolean> => {
  try {
    const res = await runGit(['rev-parse', '--is-inside-work-tree']);
    return res.trim() === 'true';
  } catch {
    return false;
  }
};

/**
 * Check if workspace has uncommitted changes (staged or unstaged).
 *
 * Returns `true`/`false` only when `git status --porcelain` completes. Returns
 * `undefined` when the state cannot be determined — the command threw (a
 * transient sub-process spawn failure under load, or the path is not a git
 * worktree, in which case `git status` errors cleanly on its own).
 *
 * Callers MUST treat `undefined` as "unknown" and NEVER coerce it to "clean":
 * a transient failure previously masqueraded as `false`, overwrote the durable
 * `SessionMeta.workspaceDirty`, and hid the Create PR / Commit & Push actions on
 * sessions that actually had uncommitted changes until the next turn recomputed.
 *
 * The separate `isInsideGitWorktree` pre-probe is intentionally omitted here: it
 * only added a second spawn (a second transient-failure surface) whose failure
 * was being misread as "clean".
 */
export const isWorkspaceDirty = async (runGit: GitRunner): Promise<boolean | undefined> => {
  try {
    const status = await runGit(['status', '--porcelain']);
    return status.trim().length > 0;
  } catch {
    return undefined;
  }
};

/**
 * Whether the branch carries local commits its upstream does not have.
 *
 * The companion to `isWorkspaceDirty`, and NOT redundant with it: `git status`
 * goes clean the instant the agent commits, so a commit whose push failed or
 * was skipped leaves a clean worktree while the PR head still points at the
 * previous commit. Without this probe the Info Bar would offer Merge on a PR
 * that is missing the work sitting in the local branch.
 *
 * Same `undefined` contract as `isWorkspaceDirty`, and for the same reason. It
 * also covers the no-upstream case: `@{u}` fails when the branch never got a
 * tracking ref, and reporting that as "nothing to push" is the exact false
 * all-clear this probe exists to prevent.
 */
export const hasUnpushedCommits = async (runGit: GitRunner): Promise<boolean | undefined> => {
  try {
    const count = await runGit(['rev-list', '@{u}..HEAD', '--count']);
    const parsed = Number.parseInt(count.trim(), 10);
    return Number.isFinite(parsed) ? parsed > 0 : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Get the current HEAD commit hash.
 * Returns null if not in a git worktree or if there are no commits.
 */
export const getCurrentCommitHash = async (runGit: GitRunner): Promise<string | null> => {
  if (!(await isInsideGitWorktree(runGit))) {
    return null;
  }

  try {
    const hash = await runGit(['rev-parse', 'HEAD']);
    const trimmed = hash.trim();
    return trimmed || null;
  } catch {
    return null;
  }
};
