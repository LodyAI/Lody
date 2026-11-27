import fs from 'fs';
import path from 'path';

import { runCommandTextLegacy } from '@lody/shared/node/process';

import { toShared } from '@/platform/process-options';
import { formatErrorMessage } from '@/utils/format-error';

const GIT_CHECK_IGNORE_TIMEOUT_MS = 15_000;

/**
 * Conservative built-in build-artifact directory names adapted from `clean-my-code`
 * (https://github.com/zxch3n/clean-code) for unattended background cleanup of
 * settled worktrees. Candidates are only removed when:
 * 1. `git check-ignore` confirms they are ignored by their enclosing repository,
 * 2. no `.git` boundary exists at or inside the candidate directory, and
 * 3. every path component from the worktree root to the candidate is a real
 *    directory (no symlinks) whose canonical path stays inside the worktree root.
 *
 * Intentionally excludes stateful, recovery, or user-managed directories
 * (e.g. `.ipynb_checkpoints`, `.swiftpm`, `.vs`, `.terraform`, `.direnv`,
 * `.vercel`, `.serverless`, `.cache`, `public`, `packages`, `bin`, `env`,
 * `ENV`, `tmp`, `temp`, `.pulumi`, `.vagrant`).
 */
export const DEFAULT_ARTIFACT_DIR_NAMES: ReadonlySet<string> = new Set([
  // General build outputs.
  'target',
  'dist',
  'build',
  'out',
  'obj',
  'Debug',
  'Release',
  // Frontend / JS / Node.
  'node_modules',
  'bower_components',
  'elm-stuff',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.astro',
  'storybook-static',
  '_site',
  '.turbo',
  '.parcel-cache',
  '.vite',
  '.angular',
  // Python / tooling.
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.nox',
  '.venv',
  'venv',
  'htmlcov',
  '.pyre',
  '.pytype',
  // JVM / Haskell / build tools.
  '.gradle',
  'dist-newstyle',
  '.stack-work',
  // CMake (CLion).
  'CMakeFiles',
  'cmake-build-debug',
  'cmake-build-release',
  'cmake-build-relwithdebinfo',
  'cmake-build-minsizerel',
  // Apple platforms.
  'Pods',
  'Carthage',
  '.build',
  'DerivedData',
  // Mobile / Flutter.
  '.dart_tool',
  // Misc.
  'coverage',
]);

export type WorktreeArtifactCleanResult = {
  /** Candidate artifact directories discovered during scan. */
  scannedDirs: number;
  /** Gitignored artifact directories removed from disk. */
  deletedPaths: string[];
  /** Candidates skipped (not ignored, nested repo, not inside a git repo, vanished, or symlink). */
  skippedPaths: number;
  /** Non-fatal per-directory errors encountered during scan, verification, or removal. */
  errors: Array<{ path: string; message: string }>;
  /** True if cleanup stopped early because `shouldAbort` signaled active use or state change. */
  aborted: boolean;
};

export type CleanWorktreeArtifactsOptions = {
  artifactDirNames?: ReadonlySet<string>;
  shouldAbort?: () => boolean | Promise<boolean>;
  /** Override for deterministic tests; defaults to `git check-ignore --quiet`. */
  isGitIgnored?: (repoRoot: string, targetPath: string) => Promise<boolean>;
};

/**
 * Local marker path recording that a managed worktree had gitignored artifacts
 * removed by settled GC, so resuming that worktree re-runs worktree setup.
 * Stored as a sibling of `<reposDir>/<repoId>/worktrees` so `git status` and
 * worktree enumeration never see it.
 */
export function getWorktreeArtifactsCleanedMarkerPath(worktreePath: string): string {
  const resolved = path.resolve(worktreePath);
  const worktreesDir = path.dirname(resolved);
  const repoDir = path.dirname(worktreesDir);
  const sessionId = path.basename(resolved);
  return path.join(repoDir, 'artifact-cleaned', sessionId);
}

export async function markWorktreeArtifactsCleaned(worktreePath: string): Promise<void> {
  const markerPath = getWorktreeArtifactsCleanedMarkerPath(worktreePath);
  await fs.promises.mkdir(path.dirname(markerPath), { recursive: true });
  await fs.promises.writeFile(markerPath, `${Date.now()}\n`, 'utf8');
}

export function hasWorktreeArtifactsCleaned(worktreePath: string): boolean {
  return fs.existsSync(getWorktreeArtifactsCleanedMarkerPath(worktreePath));
}

export async function clearWorktreeArtifactsCleaned(worktreePath: string): Promise<void> {
  try {
    await fs.promises.rm(getWorktreeArtifactsCleanedMarkerPath(worktreePath), { force: true });
  } catch {
    // Best-effort cleanup of local marker file.
  }
}

const isBlockedPath = (targetPath: string): boolean => path.basename(targetPath) === '.git';

const isWithinBoundary = (boundaryRoot: string, candidatePath: string): boolean => {
  const rel = path.relative(boundaryRoot, candidatePath);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
};

const isStrictDescendant = (parentPath: string, candidatePath: string): boolean => {
  const rel = path.relative(parentPath, candidatePath);
  return rel !== '' && !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`);
};

const isEnoent = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

const hasDotGit = async (dir: string): Promise<boolean> => {
  try {
    await fs.promises.lstat(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
};

/**
 * Verifies every path segment from `boundaryRoot` to `targetPath` is a real
 * directory (never a symlink) and that `realpath(targetPath)` stays strictly
 * inside `realBoundaryRoot`.
 */
async function verifyRealDirectoryWithinBoundary(
  boundaryRoot: string,
  realBoundaryRoot: string,
  targetPath: string
): Promise<'ok' | 'missing' | 'unsafe'> {
  if (!isStrictDescendant(boundaryRoot, targetPath)) {
    return 'unsafe';
  }
  const rel = path.relative(boundaryRoot, targetPath);
  const parts = rel.split(path.sep).filter(Boolean);
  let cursor = boundaryRoot;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(cursor);
    } catch (error) {
      if (isEnoent(error)) return 'missing';
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return 'unsafe';
    }
  }
  let realTarget: string;
  try {
    realTarget = await fs.promises.realpath(targetPath);
  } catch (error) {
    if (isEnoent(error)) return 'missing';
    throw error;
  }
  return isStrictDescendant(realBoundaryRoot, realTarget) ? 'ok' : 'unsafe';
}

/**
 * Checks whether `dirPath` itself or any non-symlink descendant contains a
 * `.git` entry (nested repository or submodule), so cleanup never deletes
 * across an independent Git repository boundary.
 */
async function containsNestedGitRepo(
  dirPath: string,
  shouldAbort?: () => boolean | Promise<boolean>
): Promise<{ hasGit: boolean; aborted: boolean }> {
  const stack: string[] = [dirPath];
  while (stack.length > 0) {
    if (await shouldAbort?.()) {
      return { hasGit: false, aborted: true };
    }
    const current = stack.pop();
    if (!current) continue;

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name === '.git') {
        return { hasGit: true, aborted: false };
      }
      if (!entry.isSymbolicLink() && entry.isDirectory()) {
        stack.push(path.join(current, entry.name));
      }
    }
  }
  return { hasGit: false, aborted: false };
}

/**
 * Finds the nearest directory containing `.git` (file or directory) walking
 * upward from `startDir`, strictly bounded by `boundaryRoot`.
 */
export async function findGitRootWithinBoundary(
  startDir: string,
  boundaryRoot: string
): Promise<string | null> {
  const resolvedBoundary = path.resolve(boundaryRoot);
  let current = path.resolve(startDir);
  while (isWithinBoundary(resolvedBoundary, current)) {
    if (await hasDotGit(current)) {
      return current;
    }
    if (current === resolvedBoundary) {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

type ScanArtifactDirsResult = {
  candidates: string[];
  errors: Array<{ path: string; message: string }>;
  aborted: boolean;
};

/**
 * Recursively scans `rootPath` for directories whose basename matches
 * `artifactDirNames`, skipping symlinks and `.git`. If a directory matching
 * `artifactDirNames` is itself a Git repo root (contains `.git`), we descend
 * into it rather than treating the repository itself as an artifact.
 */
export async function scanArtifactDirs(
  rootPath: string,
  artifactDirNames: ReadonlySet<string> = DEFAULT_ARTIFACT_DIR_NAMES,
  shouldAbort?: () => boolean | Promise<boolean>
): Promise<ScanArtifactDirsResult> {
  const resolvedRoot = path.resolve(rootPath);
  const results: string[] = [];
  const errors: Array<{ path: string; message: string }> = [];
  const stack: string[] = [resolvedRoot];

  while (stack.length > 0) {
    if (await shouldAbort?.()) {
      return { candidates: [], errors, aborted: true };
    }
    const dir = stack.pop();
    if (!dir) continue;

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) continue;
      errors.push({ path: dir, message: formatErrorMessage(error) });
      continue;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        continue;
      }
      if (entry.name === '.git') {
        continue;
      }
      const entryPath = path.join(dir, entry.name);
      if (artifactDirNames.has(entry.name)) {
        if (await hasDotGit(entryPath)) {
          stack.push(entryPath);
          continue;
        }
        results.push(entryPath);
        continue;
      }
      stack.push(entryPath);
    }
  }

  results.sort();
  return { candidates: Array.from(new Set(results)), errors, aborted: false };
}

/**
 * Verifies whether `targetPath` is ignored by Git in `repoRoot` using
 * `git check-ignore --quiet -- <relative-path>`.
 */
export async function isGitIgnored(repoRoot: string, targetPath: string): Promise<boolean> {
  const resolvedRoot = path.resolve(repoRoot);
  const resolvedTarget = path.resolve(targetPath);
  if (!isStrictDescendant(resolvedRoot, resolvedTarget)) {
    throw new Error(`Path is not under repo root: repo=${resolvedRoot}, path=${resolvedTarget}`);
  }
  const rel = path.relative(resolvedRoot, resolvedTarget).split(path.sep).join('/');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
  );
  const output = await runCommandTextLegacy(
    {
      command: 'git',
      args: ['--no-optional-locks', '-C', resolvedRoot, 'check-ignore', '--quiet', '--', rel],
      env,
      timeout: GIT_CHECK_IGNORE_TIMEOUT_MS,
      check: 'none',
    },
    toShared()
  );
  if (output.code === 0) return true;
  if (output.code === 1) return false;
  throw new Error(
    output.code !== null
      ? `git check-ignore failed with exit code ${output.code}${output.stderr.trim() ? `: ${output.stderr.trim()}` : ''}`
      : `git check-ignore terminated by signal ${output.signal ?? 'unknown'}`
  );
}

/**
 * Removes gitignored build-artifact directories inside a managed worktree.
 * Supports single-repo worktrees as well as multi-repo project-group worktrees
 * and submodules by resolving the nearest `.git` root within `worktreeRoot`,
 * refusing to delete across nested `.git` boundaries or symlinked parents.
 */
export async function cleanWorktreeArtifacts(
  worktreeRoot: string,
  options: CleanWorktreeArtifactsOptions = {}
): Promise<WorktreeArtifactCleanResult> {
  const artifactDirNames = options.artifactDirNames ?? DEFAULT_ARTIFACT_DIR_NAMES;
  const checkIgnored = options.isGitIgnored ?? isGitIgnored;
  const shouldAbort = options.shouldAbort;
  const resolvedRoot = path.resolve(worktreeRoot);

  const result: WorktreeArtifactCleanResult = {
    scannedDirs: 0,
    deletedPaths: [],
    skippedPaths: 0,
    errors: [],
    aborted: false,
  };

  if (await shouldAbort?.()) {
    result.aborted = true;
    return result;
  }

  let rootStat: fs.Stats;
  try {
    rootStat = await fs.promises.lstat(resolvedRoot);
  } catch (error) {
    if (isEnoent(error)) {
      return result;
    }
    result.errors.push({ path: resolvedRoot, message: formatErrorMessage(error) });
    return result;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return result;
  }

  let realRoot: string;
  try {
    realRoot = await fs.promises.realpath(resolvedRoot);
  } catch (error) {
    if (isEnoent(error)) return result;
    result.errors.push({ path: resolvedRoot, message: formatErrorMessage(error) });
    return result;
  }

  const scan = await scanArtifactDirs(resolvedRoot, artifactDirNames, shouldAbort);
  result.errors.push(...scan.errors);
  if (scan.aborted || (await shouldAbort?.())) {
    result.aborted = true;
    return result;
  }

  // Defensive deduplication: skip any path nested under an earlier candidate.
  const planned: string[] = [];
  for (const candidate of scan.candidates) {
    if (planned.some((selected) => isStrictDescendant(selected, candidate))) {
      continue;
    }
    planned.push(candidate);
  }
  result.scannedDirs = planned.length;

  for (const targetPath of planned) {
    if (await shouldAbort?.()) {
      result.aborted = true;
      break;
    }
    if (isBlockedPath(targetPath)) {
      result.skippedPaths += 1;
      continue;
    }

    let boundaryCheck: 'ok' | 'missing' | 'unsafe';
    try {
      boundaryCheck = await verifyRealDirectoryWithinBoundary(resolvedRoot, realRoot, targetPath);
    } catch (error) {
      result.errors.push({ path: targetPath, message: formatErrorMessage(error) });
      continue;
    }
    if (boundaryCheck !== 'ok') {
      result.skippedPaths += 1;
      continue;
    }

    const repoRoot = await findGitRootWithinBoundary(path.dirname(targetPath), resolvedRoot);
    if (!repoRoot) {
      result.skippedPaths += 1;
      continue;
    }

    let ignored: boolean;
    try {
      ignored = await checkIgnored(repoRoot, targetPath);
    } catch (error) {
      result.skippedPaths += 1;
      result.errors.push({ path: targetPath, message: formatErrorMessage(error) });
      continue;
    }
    if (!ignored) {
      result.skippedPaths += 1;
      continue;
    }

    // Never delete across an independent nested Git repository / submodule boundary.
    let nestedGit: { hasGit: boolean; aborted: boolean };
    try {
      nestedGit = await containsNestedGitRepo(targetPath, shouldAbort);
    } catch (error) {
      result.skippedPaths += 1;
      result.errors.push({ path: targetPath, message: formatErrorMessage(error) });
      continue;
    }
    if (nestedGit.aborted) {
      result.aborted = true;
      break;
    }
    if (nestedGit.hasGit) {
      result.skippedPaths += 1;
      continue;
    }

    if (await shouldAbort?.()) {
      result.aborted = true;
      break;
    }

    // Re-verify the entire real path chain right before removal to guard against parent/leaf symlink swaps.
    try {
      const freshCheck = await verifyRealDirectoryWithinBoundary(
        resolvedRoot,
        realRoot,
        targetPath
      );
      if (freshCheck !== 'ok') {
        result.skippedPaths += 1;
        continue;
      }
    } catch (error) {
      result.errors.push({ path: targetPath, message: formatErrorMessage(error) });
      continue;
    }

    try {
      await fs.promises.rm(targetPath, { recursive: true, force: true });
      result.deletedPaths.push(targetPath);
    } catch (error) {
      if (isEnoent(error)) {
        result.skippedPaths += 1;
        continue;
      }
      result.errors.push({ path: targetPath, message: formatErrorMessage(error) });
    }
  }

  return result;
}
