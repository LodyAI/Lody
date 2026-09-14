import type { FileDiff, LineChange, SessionDiffStats } from '@lody/shared';

export type GitRunner = (args: string[]) => Promise<string>;

export type GitDiffStats = {
  baseRef: string;
  mergeBase: string;
  commitFileDiff: FileDiff[];
  baseDiffStats: SessionDiffStats;
};

export type GitMergeBase = {
  baseRef: string;
  mergeBase: string;
};

export type GitWorkingTreeFileFingerprint = {
  status: string;
  objectHash: string | null;
};

export type GitWorkingTreeDiffBaseline = Record<string, GitWorkingTreeFileFingerprint>;

export type GitWorkingTreeLineCounter = (filePath: string) => Promise<number | null>;

const parseNumstatCount = (value: string): number => {
  if (value === '-') return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const parseGitNumstat = (output: string): FileDiff[] => {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  const diffs: FileDiff[] = [];
  for (const line of lines) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!match) continue;
    const add = parseNumstatCount(match[1] ?? '');
    const del = parseNumstatCount(match[2] ?? '');
    const filePath = match[3] ?? '';
    if (!filePath) continue;
    diffs.push({ filePath, add, del });
  }
  return diffs;
};

export const sumLineChange = (diffs: readonly FileDiff[]): LineChange => {
  return diffs.reduce<LineChange>(
    (acc, diff) => ({ add: acc.add + diff.add, del: acc.del + diff.del }),
    { add: 0, del: 0 }
  );
};

const buildUntrackedFileDiffs = async (
  filePaths: readonly string[],
  countWorkingTreeFileLines?: GitWorkingTreeLineCounter
): Promise<FileDiff[]> => {
  const diffs: FileDiff[] = [];
  for (const filePath of filePaths) {
    const add = (await countWorkingTreeFileLines?.(filePath)) ?? 0;
    diffs.push({ filePath, add, del: 0 });
  }
  return diffs;
};

const parseGitNameStatusZ = (output: string): Array<{ status: string; filePath: string }> => {
  const parts = output.split('\0').filter((part) => part.length > 0);
  const entries: Array<{ status: string; filePath: string }> = [];
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const status = parts[index];
    const filePath = parts[index + 1];
    if (status && filePath) {
      entries.push({ status, filePath });
    }
  }
  return entries;
};

const isInsideGitWorktree = async (runGit: GitRunner): Promise<boolean> => {
  try {
    const res = await runGit(['rev-parse', '--is-inside-work-tree']);
    return res.trim() === 'true';
  } catch {
    return false;
  }
};

const hasCommitish = async (runGit: GitRunner, rev: string): Promise<boolean> => {
  try {
    await runGit(['rev-parse', '--verify', `${rev}^{commit}`]);
    return true;
  } catch {
    return false;
  }
};

const resolveBaseRef = async (
  runGit: GitRunner,
  preferredBaseBranch: string
): Promise<string | null> => {
  const candidates: string[] = [
    `origin/${preferredBaseBranch}`,
    preferredBaseBranch,
    'origin/main',
    'main',
    'origin/master',
    'master',
    'origin/HEAD',
  ];

  for (const candidate of candidates) {
    if (await hasCommitish(runGit, candidate)) {
      return candidate;
    }
  }

  return null;
};

const resolveMergeBase = async (runGit: GitRunner, baseRef: string): Promise<string | null> => {
  try {
    const mergeBase = await runGit(['merge-base', baseRef, 'HEAD']);
    const trimmed = mergeBase.trim();
    if (trimmed) return trimmed;
  } catch {
    return null;
  }

  return null;
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
 * List untracked, non-ignored files (relative paths). `git diff <base>` does NOT report
 * untracked files, so callers that need the full working-tree delta (e.g. bash/codegen-created
 * new files) must enumerate them separately. Uses NUL separation to stay correct for paths
 * containing spaces or newlines. Returns [] outside a worktree or on error.
 */
export const listUntrackedFiles = async (
  runGit: GitRunner,
  filePaths?: readonly string[]
): Promise<string[]> => {
  if (!(await isInsideGitWorktree(runGit))) {
    return [];
  }
  try {
    const args = ['ls-files', '--others', '--exclude-standard', '-z'];
    if (filePaths && filePaths.length > 0) {
      args.push('--', ...filePaths);
    }
    const out = await runGit(args);
    return out.split('\0').filter((entry) => entry.length > 0);
  } catch {
    return [];
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

const hashObjectPaths = async (
  runGit: GitRunner,
  filePaths: readonly string[]
): Promise<Map<string, string>> => {
  const hashesByPath = new Map<string, string>();
  const chunkSize = 100;
  for (let start = 0; start < filePaths.length; start += chunkSize) {
    const chunk = filePaths.slice(start, start + chunkSize);
    try {
      const output = await runGit(['hash-object', '--', ...chunk]);
      const hashes = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      chunk.forEach((filePath, index) => {
        const hash = hashes[index];
        if (hash && /^[0-9a-f]{40,64}$/i.test(hash)) {
          hashesByPath.set(filePath, hash);
        }
      });
    } catch {
      for (const filePath of chunk) {
        try {
          const hash = (await runGit(['hash-object', '--', filePath])).trim();
          if (/^[0-9a-f]{40,64}$/i.test(hash)) {
            hashesByPath.set(filePath, hash);
          }
        } catch {
          // Leave the path untracked in the baseline. Filtering an unknown hash would hide real edits.
        }
      }
    }
  }
  return hashesByPath;
};

const captureGitWorkingTreeDiffFingerprints = async (
  runGit: GitRunner,
  filePaths?: readonly string[]
): Promise<GitWorkingTreeDiffBaseline> => {
  const args =
    filePaths && filePaths.length > 0
      ? ['diff', '--name-status', '--no-renames', '-z', 'HEAD', '--', ...filePaths]
      : ['diff', '--name-status', '--no-renames', '-z', 'HEAD'];
  const entries = parseGitNameStatusZ(await runGit(args));
  const untrackedPaths = await listUntrackedFiles(runGit, filePaths);
  const nonDeletedPaths = entries
    .filter((entry) => !entry.status.startsWith('D'))
    .map((entry) => entry.filePath);
  const hashesByPath = await hashObjectPaths(runGit, [
    ...new Set([...nonDeletedPaths, ...untrackedPaths]),
  ]);

  const baseline: GitWorkingTreeDiffBaseline = {};
  for (const entry of entries) {
    if (entry.status.startsWith('D')) {
      baseline[entry.filePath] = { status: entry.status, objectHash: null };
      continue;
    }

    const objectHash = hashesByPath.get(entry.filePath);
    if (objectHash) {
      baseline[entry.filePath] = { status: entry.status, objectHash };
    }
  }
  for (const filePath of untrackedPaths) {
    const objectHash = hashesByPath.get(filePath);
    if (objectHash) {
      baseline[filePath] = { status: '??', objectHash };
    }
  }
  return baseline;
};

const captureGitWorkingTreePathStateFingerprints = async (
  runGit: GitRunner,
  filePaths: readonly string[]
): Promise<GitWorkingTreeDiffBaseline> => {
  const hashesByPath = await hashObjectPaths(runGit, filePaths);
  const baseline: GitWorkingTreeDiffBaseline = {};
  for (const filePath of filePaths) {
    const objectHash = hashesByPath.get(filePath);
    baseline[filePath] = {
      status: objectHash === undefined ? 'missing' : 'present',
      objectHash: objectHash ?? null,
    };
  }
  return baseline;
};

export const captureGitWorkingTreeDiffBaseline = async (
  runGit: GitRunner
): Promise<GitWorkingTreeDiffBaseline | null> => {
  if (!(await isInsideGitWorktree(runGit))) {
    return null;
  }

  try {
    return await captureGitWorkingTreeDiffFingerprints(runGit);
  } catch {
    return null;
  }
};

export const resolveGitMergeBase = async (
  runGit: GitRunner,
  preferredBaseBranch = 'main'
): Promise<GitMergeBase | null> => {
  if (!(await isInsideGitWorktree(runGit))) {
    return null;
  }

  const baseRef = await resolveBaseRef(runGit, preferredBaseBranch);
  if (baseRef === null) return null;
  const mergeBase = await resolveMergeBase(runGit, baseRef);
  if (mergeBase === null) return null;
  return { baseRef, mergeBase };
};

export const getGitDiffStats = async (
  runGit: GitRunner,
  options?: {
    preferredBaseBranch?: string;
    /**
     * If provided, calculate commitFileDiff as the diff between this commit and HEAD.
     * This is useful for calculating file changes across multiple commits in a single conversation.
     */
    baseCommitHash?: string;
    turnStartWorkingTreeDiff?: GitWorkingTreeDiffBaseline | null;
    countWorkingTreeFileLines?: GitWorkingTreeLineCounter;
  }
): Promise<GitDiffStats | null> => {
  const preferredBaseBranch = options?.preferredBaseBranch ?? 'main';
  const mergeBaseResult = await resolveGitMergeBase(runGit, preferredBaseBranch);
  if (!mergeBaseResult) return null;
  const { baseRef, mergeBase } = mergeBaseResult;

  // Session-level all-change stats must match GitHub PR compare totals, which are
  // calculated from committed content, not from uncommitted working-tree changes.
  const baseNumstat = await runGit(['diff', '--numstat', '--no-renames', mergeBase, 'HEAD']);
  const baseDiff = parseGitNumstat(baseNumstat);
  const baseDiffStats: SessionDiffStats = {
    allChange: sumLineChange(baseDiff),
  };

  let commitFileDiff: FileDiff[];
  if (options?.baseCommitHash) {
    // Calculate diff between the recorded base commit and current working tree
    // This includes both committed changes and uncommitted modifications
    const diffNumstat = await runGit(['diff', '--numstat', '--no-renames', options.baseCommitHash]);
    commitFileDiff = parseGitNumstat(diffNumstat);
    const turnStartWorkingTreeDiff = options.turnStartWorkingTreeDiff;
    const baselinePaths = commitFileDiff
      .map((diff) => diff.filePath)
      .filter((filePath) => turnStartWorkingTreeDiff?.[filePath] !== undefined);
    if (turnStartWorkingTreeDiff && baselinePaths.length > 0) {
      const currentFingerprints = await captureGitWorkingTreePathStateFingerprints(
        runGit,
        baselinePaths
      );
      commitFileDiff = commitFileDiff.filter((diff) => {
        const before = turnStartWorkingTreeDiff[diff.filePath];
        if (!before) return true;
        const after = currentFingerprints[diff.filePath];
        if (!after) return true;
        return before.objectHash !== after.objectHash;
      });
    }
    const commitFileDiffPaths = new Set(commitFileDiff.map((diff) => diff.filePath));
    const untrackedPaths = await listUntrackedFiles(runGit);
    const untrackedFileDiff = await buildUntrackedFileDiffs(
      untrackedPaths,
      options?.countWorkingTreeFileLines
    );
    const untrackedFileDiffByPath = new Map(
      untrackedFileDiff.map((diff) => [diff.filePath, diff] as const)
    );
    let turnUntrackedPaths = untrackedPaths.filter(
      (filePath) => !commitFileDiffPaths.has(filePath)
    );
    if (turnStartWorkingTreeDiff && turnUntrackedPaths.length > 0) {
      const currentHashes = await hashObjectPaths(runGit, turnUntrackedPaths);
      turnUntrackedPaths = turnUntrackedPaths.filter((filePath) => {
        const before = turnStartWorkingTreeDiff[filePath];
        if (!before) return true;
        const afterHash = currentHashes.get(filePath);
        if (!afterHash) return true;
        return before.objectHash !== afterHash;
      });
    }
    commitFileDiff = [
      ...commitFileDiff,
      ...turnUntrackedPaths.map(
        (filePath) => untrackedFileDiffByPath.get(filePath) ?? { filePath, add: 0, del: 0 }
      ),
    ];
  } else {
    // Without a turn-start baseline, git cannot attribute files to this assistant turn.
    // Do not fall back to `git show HEAD`: that reports unrelated last-commit files as
    // phantom per-message edits.
    commitFileDiff = [];
  }

  return { baseRef, mergeBase, commitFileDiff, baseDiffStats };
};
