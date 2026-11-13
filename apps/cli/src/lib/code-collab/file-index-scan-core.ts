import {
  CODE_COLLAB_FILE_INDEX_LIMITS,
  resolveSessionFilePath,
  isSafeProjectPath,
} from '@lody/shared';
import ignore, { type Ignore } from 'ignore';
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import type {
  CodeCollabV2AllChangesState,
  CodeCollabV2AllChangesValue,
  CodeCollabV2FileTreeValue,
  SessionDiffStats,
} from '@lody/shared';

// The shared facade directly: the CLI one loads the daemon's winston logger.
import { runCommandTextLegacy } from '@lody/shared/node/process';

import { countTextLines } from './diff-line-counts';
import { isInCodeCollabIgnoredDirectory } from './workspace-watch-path-policy';
import { gitDiffBaseRefCandidates } from '../git/git-diff-base';

// Pure Git-backed scanning + All Changes computation shared by the file-index
// Tinypool worker (`file-index-scan-worker.ts`) and the main-thread fallback in
// `code-collab-v2-service.ts`. Keep this module dependency-light (node builtins,
// `@lody/shared` types and the shared process facade only) so the worker bundle stays
// free of wasm/top-level-await imports. The filesystem (`opendir`) directory-scan fallback is intentionally NOT
// here: its error classification differs between the worker and the service.

const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export type GitDirectoryScanInput = {
  readonly signal?: AbortSignal;
  readonly directoryAbsolutePath: string;
  readonly directoryWorkspacePath: string;
  readonly entryBudget: number;
  readonly recursive: boolean;
};

export async function isInsideGitWorktree(
  workspaceRoot: string,
  signal?: AbortSignal
): Promise<boolean> {
  const inside = await runGit(workspaceRoot, ['rev-parse', '--is-inside-work-tree'], signal);
  return inside.ok && inside.stdout.trim() === 'true';
}

export async function scanGitDirectoryEntries(
  options: GitDirectoryScanInput
): Promise<Map<string, CodeCollabV2FileTreeValue> | null> {
  if (!options.recursive) {
    return null;
  }
  const result = await runGitLsFiles(options.directoryAbsolutePath, options.signal);
  if (!result.ok) {
    return null;
  }
  return buildEntriesFromGitFilePaths({
    directoryWorkspacePath: options.directoryWorkspacePath,
    entryBudget: options.entryBudget,
    recursive: options.recursive,
    relativeFilePaths: result.paths,
  });
}

async function runGitLsFiles(
  cwd: string,
  signal?: AbortSignal
): Promise<{ readonly ok: true; readonly paths: readonly string[] } | { readonly ok: false }> {
  // `runGit` never rejects, so all children are joined before either outcome is used.
  // Returning on the first failure left the sibling `git` unawaited; with Tinypool's
  // `Atomics.wait` idle worker it could stay unreaped as a daemon zombie on macOS.
  const results = await Promise.allSettled([
    runGit(cwd, ['ls-files', '-z', '--cached', '--deduplicate', '--', '.'], signal),
    runGit(cwd, ['ls-files', '-z', '--others', '--exclude-standard', '--', '.'], signal),
    runGit(cwd, ['ls-files', '--deleted', '-z', '--', '.'], signal),
  ]);
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason;
  }
  const [trackedResult, untrackedResult, deletedResult] = results;
  if (
    trackedResult?.status !== 'fulfilled' ||
    untrackedResult?.status !== 'fulfilled' ||
    deletedResult?.status !== 'fulfilled'
  ) {
    throw new Error('Git listing did not settle');
  }
  const tracked = trackedResult.value;
  const untracked = untrackedResult.value;
  const deleted = deletedResult.value;
  if (!tracked.ok || !untracked.ok) {
    return { ok: false };
  }
  const deletedPaths = deleted.ok
    ? new Set(deleted.stdout.split('\0').map(normalizeGitPath).filter(isValidRelativeGitPath))
    : new Set<string>();
  const paths = new Set<string>();
  for (const filePath of tracked.stdout.split('\0').map(normalizeGitPath)) {
    if (isValidRelativeGitPath(filePath) && !deletedPaths.has(filePath)) paths.add(filePath);
  }
  // `.gitignore` only covers what the project declares; caches such as an
  // in-project `.pnpm-store` also go through the product policy. Tracked files
  // above stay visible even when they live under such a directory name.
  for (const filePath of untracked.stdout.split('\0').map(normalizeGitPath)) {
    if (isValidRelativeGitPath(filePath) && !isInCodeCollabIgnoredDirectory(filePath)) {
      paths.add(filePath);
    }
  }
  return { ok: true, paths: [...paths] };
}

export type ProjectGitMember = { readonly path: string; readonly base: string };

/** Summarize the complete comparison before its file index is bounded for transport. */
export function summarizeAllChanges(changes: CodeCollabV2AllChangesState): SessionDiffStats | null {
  let add = 0;
  let del = 0;
  for (const change of Object.values(changes)) {
    if (change === true || change.diff === undefined) return null;
    add += change.diff[0];
    del += change.diff[1];
  }
  return { allChange: { add, del } };
}

export async function resolveProjectGitDirectory(
  root: string,
  memberPath: string
): Promise<string> {
  if (!isSafeProjectPath(memberPath)) throw new Error('Invalid project group member path');
  const canonicalRoot = await realpath(root);
  const directory = await realpath(path.join(canonicalRoot, memberPath));
  if (
    resolveSessionFilePath([{ id: 'main', absolutePath: canonicalRoot }], directory)
      ?.relativePath !== memberPath
  )
    throw new Error('Project group member escaped its directory');
  return directory;
}

export async function computeProjectAllChanges(
  root: string,
  members: readonly ProjectGitMember[]
): Promise<CodeCollabV2AllChangesState> {
  return (await computeProjectAllChangesSnapshot(root, members)).allChanges;
}

export async function computeProjectAllChangesSnapshot(
  root: string,
  members: readonly ProjectGitMember[]
) {
  const changes: CodeCollabV2AllChangesState = {};
  const gitMemberBases: Record<string, string> = {};
  for (const member of members) {
    const directory = await resolveProjectGitDirectory(root, member.path);
    const diffBase = (await resolveAllChangesDiffBase(directory, member.base)) ?? 'HEAD';
    gitMemberBases[member.path] = diffBase;
    const state = await computeAllChanges(directory, { diffBase });
    for (const [file, change] of Object.entries(state)) changes[`${member.path}/${file}`] = change;
  }
  return { allChanges: changes, gitMemberBases };
}

export async function computeAllChanges(
  workspaceRoot: string,
  options: {
    readonly preferredBaseBranch?: string;
    readonly diffBase?: string;
    readonly signal?: AbortSignal;
    /** Untracked files whose content may be read for line counts; later ones stay uncounted. */
    readonly untrackedLineCountBudget?: number;
  } = {}
): Promise<CodeCollabV2AllChangesState> {
  const diffBase =
    options.diffBase ??
    (await resolveAllChangesDiffBase(workspaceRoot, options.preferredBaseBranch, options.signal));
  const diffTarget = diffBase ?? 'HEAD';
  const results = await Promise.allSettled([
    // `--numstat` cannot use `-z`, so disable `core.quotePath` to keep non-ASCII paths
    // raw (matching the `-z` outputs below); otherwise they are mis-keyed and lose their
    // All Changes diff counts.
    runGit(
      workspaceRoot,
      [
        '-c',
        'core.quotePath=false',
        'diff',
        '--numstat',
        '--no-renames',
        '--relative',
        diffTarget,
        '--',
      ],
      options.signal
    ),
    runGit(
      workspaceRoot,
      ['diff', '--name-status', '--no-renames', '-z', '--relative', diffTarget, '--'],
      options.signal
    ),
    runGit(workspaceRoot, ['ls-files', '--others', '--exclude-standard', '-z'], options.signal),
  ]);
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason;
  }
  const [numstatResult, nameStatusResult, untrackedResult] = results;
  if (
    numstatResult?.status !== 'fulfilled' ||
    nameStatusResult?.status !== 'fulfilled' ||
    untrackedResult?.status !== 'fulfilled'
  ) {
    throw new Error('Git diff did not settle');
  }
  const numstat = numstatResult.value;
  const nameStatus = nameStatusResult.value;
  const untracked = untrackedResult.value;
  if (!numstat.ok && !nameStatus.ok && !untracked.ok) {
    throw new Error('Git workspace comparison could not be read.');
  }

  const deletedPaths = nameStatus.ok
    ? parseDeletedPathsFromNameStatus(nameStatus.stdout)
    : new Set<string>();
  const changes: CodeCollabV2AllChangesState = {};
  if (numstat.ok) {
    for (const line of numstat.stdout.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [addRaw, delRaw, ...pathParts] = trimmed.split('\t');
      const filePath = pathParts.join('\t').trim();
      if (!filePath) continue;
      const normalizedPath = normalizeGitPath(filePath);
      if (addRaw === '-' || delRaw === '-') {
        // Binary: no line counts, but a deletion must stay a deletion.
        changes[normalizedPath] = deletedPaths.has(normalizedPath) ? { del: true } : true;
        continue;
      }
      const add = Number(addRaw);
      const del = Number(delRaw);
      const diff: [number, number] = [
        Number.isFinite(add) && add >= 0 ? Math.trunc(add) : 0,
        Number.isFinite(del) && del >= 0 ? Math.trunc(del) : 0,
      ];
      changes[normalizedPath] = deletedPaths.has(normalizedPath)
        ? { diff: [0, diff[1]], del: true }
        : { diff };
    }
  }

  if (untracked.ok) {
    // Filter and bound BEFORE reading: each counted file is a full read, and the
    // published file index is bounded anyway (CODE_COLLAB_FILE_INDEX_LIMITS).
    let remainingLineCounts = Math.max(
      0,
      options.untrackedLineCountBudget ?? CODE_COLLAB_FILE_INDEX_LIMITS.maxEntries
    );
    for (const filePath of untracked.stdout.split('\0')) {
      options.signal?.throwIfAborted();
      if (!filePath) continue;
      const normalizedPath = normalizeGitPath(filePath);
      if (normalizedPath in changes || isInCodeCollabIgnoredDirectory(normalizedPath)) continue;
      if (remainingLineCounts === 0) {
        changes[normalizedPath] = true;
        continue;
      }
      remainingLineCounts -= 1;
      changes[normalizedPath] = await lineStatsForUntrackedFile(
        workspaceRoot,
        normalizedPath,
        options.signal
      );
    }
  }
  return changes;
}

export async function resolveAllChangesDiffBase(
  workspaceRoot: string,
  preferredBaseBranch?: string,
  signal?: AbortSignal
): Promise<string | null> {
  if (!(await isInsideGitWorktree(workspaceRoot, signal))) {
    return null;
  }

  const baseRef = await resolveAllChangesBaseRef(workspaceRoot, preferredBaseBranch, signal);
  if (baseRef) {
    const mergeBase = await runGit(workspaceRoot, ['merge-base', baseRef, 'HEAD'], signal);
    const trimmed = mergeBase.ok ? mergeBase.stdout.trim() : '';
    if (trimmed) {
      return trimmed;
    }
  }

  const head = await resolveGitHeadCommit(workspaceRoot, signal);
  return head;
}

export async function resolveGitHeadCommit(
  workspaceRoot: string,
  signal?: AbortSignal
): Promise<string | null> {
  const head = await runGit(workspaceRoot, ['rev-parse', '--verify', 'HEAD^{commit}'], signal);
  return head.ok && head.stdout.trim() ? head.stdout.trim() : null;
}

async function resolveAllChangesBaseRef(
  workspaceRoot: string,
  preferredBaseBranch?: string,
  signal?: AbortSignal
): Promise<string | null> {
  const candidates = gitDiffBaseRefCandidates(preferredBaseBranch);
  for (const candidate of candidates) {
    const exists = await runGit(
      workspaceRoot,
      ['rev-parse', '--verify', `${candidate}^{commit}`],
      signal
    );
    if (exists.ok) {
      return candidate;
    }
  }
  return null;
}

async function lineStatsForUntrackedFile(
  workspaceRoot: string,
  workspacePath: string,
  signal?: AbortSignal
): Promise<CodeCollabV2AllChangesValue> {
  try {
    const absolutePath = path.resolve(workspaceRoot, workspacePath);
    const bytes = await readFile(absolutePath, { signal });
    if (hasBinaryNul(bytes)) return true;
    const text = decodeUtf8(bytes);
    return { diff: [countTextLines(text), 0] };
  } catch {
    signal?.throwIfAborted();
    return true;
  }
}

function parseDeletedPathsFromNameStatus(stdout: string): Set<string> {
  const deleted = new Set<string>();
  const tokens = stdout.split('\0').filter(Boolean);
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index] ?? '';
    index += 1;
    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = tokens[index];
      const newPath = tokens[index + 1];
      index += 2;
      if (oldPath) deleted.add(normalizeGitPath(oldPath));
      if (newPath) deleted.delete(normalizeGitPath(newPath));
      continue;
    }
    const filePath = tokens[index];
    index += 1;
    if (status.startsWith('D') && filePath) {
      deleted.add(normalizeGitPath(filePath));
    }
  }
  return deleted;
}

async function runGit(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
  input?: string
): Promise<{ readonly ok: true; readonly stdout: string } | { readonly ok: false }> {
  try {
    signal?.throwIfAborted();
    const { stdout } = await runCommandTextLegacy(
      {
        command: 'git',
        args: ['-C', cwd, ...args],
        ...(input === undefined ? {} : { input }),
        maxOutputBytes: GIT_MAX_BUFFER_BYTES,
        check: 'exit-0',
      },
      { signal }
    );
    return { ok: true, stdout };
  } catch {
    signal?.throwIfAborted();
    return { ok: false };
  }
}

type GitIgnoreSource = { readonly baseDirectory: string; readonly rules: Ignore };

export type GitIgnoreScanFilter = {
  /**
   * Names in `relativeDirectory` (POSIX, relative to the scan root; `''` is the
   * root) that the worktree's ignore rules exclude and that hold no tracked file.
   * Callers skip them before classifying, counting or descending.
   */
  ignoredEntryNames(
    relativeDirectory: string,
    entries: ReadonlyArray<{ readonly name: string; readonly isDirectory: boolean }>
  ): Promise<ReadonlySet<string>>;
};

const NO_IGNORED_ENTRIES: ReadonlySet<string> = new Set();

/** `directoryWorkspacePath` relative to a scan rooted at `scanWorkspacePath`. */
export function relativeScanDirectory(scanWorkspacePath: string, directoryWorkspacePath: string) {
  if (directoryWorkspacePath === scanWorkspacePath) return '';
  return scanWorkspacePath
    ? directoryWorkspacePath.slice(scanWorkspacePath.length + 1)
    : directoryWorkspacePath;
}

/**
 * Git ignore rules for a filesystem scan, evaluated in-process with `ignore`
 * so ignored directories are pruned instead of walked. Filesystem scans run
 * inside Git worktrees for non-recursive directory refreshes (Git does not
 * record empty directories) and when `git ls-files` fails.
 *
 * Precedence follows gitignore(5): the deepest `.gitignore` decides first, then
 * parents, then `$GIT_DIR/info/exclude`, then `core.excludesFile`. Nested
 * `.gitignore` files load lazily as the scan reaches their directory. An ignored
 * entry that still contains a tracked file stays visible (one `git ls-files`
 * call per directory that has ignored entries).
 *
 * Outside a Git worktree the scan root acts as the top level: its `.gitignore`
 * files still prune the walk, without `info/exclude`, global excludes or a
 * tracked-file check. Returns `null` only when the scan root cannot be resolved.
 */
export async function createGitIgnoreScanFilter(
  scanRootAbsolutePath: string,
  signal?: AbortSignal
): Promise<GitIgnoreScanFilter | null> {
  const [described, configuredExcludes] = await Promise.all([
    runGit(
      scanRootAbsolutePath,
      ['rev-parse', '--show-toplevel', '--git-path', 'info/exclude'],
      signal
    ),
    runGit(scanRootAbsolutePath, ['config', '--path', '--get', 'core.excludesFile'], signal),
  ]);
  const [reportedTopLevel, gitPathExclude] = described.ok ? described.stdout.split(/\r?\n/u) : [];
  const inWorktree = Boolean(reportedTopLevel && gitPathExclude);
  const [topLevel, scanRoot] = await Promise.all([
    realpath(inWorktree && reportedTopLevel ? reportedTopLevel : scanRootAbsolutePath).catch(
      () => null
    ),
    realpath(scanRootAbsolutePath).catch(() => null),
  ]);
  if (topLevel === null || scanRoot === null) return null;
  const scanRootFromTop = path.relative(topLevel, scanRoot).split(path.sep).join('/');
  if (scanRootFromTop.startsWith('..') || path.isAbsolute(scanRootFromTop)) return null;

  const globalExcludes =
    configuredExcludes.ok && configuredExcludes.stdout.trim()
      ? configuredExcludes.stdout.trim()
      : path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'git', 'ignore');
  const readRules = async (file: string): Promise<Ignore | null> => {
    const text = await readFile(file, 'utf8').catch(() => null);
    return text === null ? null : ignore().add(text);
  };
  const fallbackSources: GitIgnoreSource[] = [];
  const fallbackFiles =
    inWorktree && gitPathExclude
      ? // `--git-path` is relative to the working directory unless the Git dir is elsewhere.
        [path.resolve(scanRootAbsolutePath, gitPathExclude), globalExcludes]
      : [];
  for (const file of fallbackFiles) {
    const rules = await readRules(file);
    if (rules) fallbackSources.push({ baseDirectory: '', rules });
  }

  // Keyed by directory relative to the top level; the promise is shared so a
  // directory's `.gitignore` is read once per scan.
  const directoryRules = new Map<string, Promise<Ignore | null>>();
  const rulesFor = (directoryFromTop: string): Promise<Ignore | null> => {
    let rules = directoryRules.get(directoryFromTop);
    if (!rules) {
      rules = readRules(path.join(topLevel, ...directoryFromTop.split('/'), '.gitignore'));
      directoryRules.set(directoryFromTop, rules);
    }
    return rules;
  };
  // Sources that can decide for entries of one directory, highest precedence first.
  const sourcesFor = async (directoryFromTop: string): Promise<GitIgnoreSource[]> => {
    const segments = directoryFromTop ? directoryFromTop.split('/') : [];
    const sources: GitIgnoreSource[] = [];
    for (let depth = segments.length; depth >= 0; depth -= 1) {
      const baseDirectory = segments.slice(0, depth).join('/');
      const rules = await rulesFor(baseDirectory);
      if (rules) sources.push({ baseDirectory, rules });
    }
    return [...sources, ...fallbackSources];
  };
  const isIgnored = (
    sources: readonly GitIgnoreSource[],
    pathFromTop: string,
    isDirectory: boolean
  ): boolean => {
    for (const source of sources) {
      const relative = source.baseDirectory
        ? pathFromTop.slice(source.baseDirectory.length + 1)
        : pathFromTop;
      const result = source.rules.test(isDirectory ? `${relative}/` : relative);
      if (result.ignored) return true;
      if (result.unignored) return false;
    }
    return false;
  };

  return {
    async ignoredEntryNames(relativeDirectory, entries) {
      const directoryFromTop = [scanRootFromTop, relativeDirectory].filter(Boolean).join('/');
      const sources = await sourcesFor(directoryFromTop);
      if (sources.length === 0) return NO_IGNORED_ENTRIES;
      const candidates: string[] = [];
      for (const entry of entries) {
        const pathFromTop = directoryFromTop ? `${directoryFromTop}/${entry.name}` : entry.name;
        if (isIgnored(sources, pathFromTop, entry.isDirectory)) candidates.push(entry.name);
      }
      if (candidates.length === 0) return NO_IGNORED_ENTRIES;
      if (!inWorktree) return new Set(candidates);
      // `git add -f` keeps a matching path tracked; Git listings show it, so must we.
      const tracked = await runGit(
        topLevel,
        [
          'ls-files',
          '-z',
          '--cached',
          '--',
          ...candidates.map(
            (name) => `:(literal)${directoryFromTop ? `${directoryFromTop}/` : ''}${name}`
          ),
        ],
        signal
      );
      const ignored = new Set(candidates);
      if (!tracked.ok) return ignored;
      const prefixLength = directoryFromTop ? directoryFromTop.length + 1 : 0;
      for (const trackedPath of tracked.stdout.split('\0')) {
        if (!trackedPath) continue;
        ignored.delete(normalizeGitPath(trackedPath).slice(prefixLength).split('/')[0] ?? '');
      }
      return ignored;
    },
  };
}

/**
 * Which of `relativePaths` (relative to `cwd`; a trailing `/` marks a directory)
 * the worktree's Git rules ignore. Tracked files are never reported. Returns
 * `null` when Git cannot answer (not a worktree, failure); an empty set when
 * nothing is ignored (`check-ignore` exit 1).
 */
export async function listGitIgnoredPaths(
  cwd: string,
  relativePaths: readonly string[],
  signal?: AbortSignal
): Promise<Set<string> | null> {
  if (relativePaths.length === 0) return new Set();
  const result = await runGit(
    cwd,
    ['check-ignore', '-z', '--stdin'],
    signal,
    `${relativePaths.join('\0')}\0`
  );
  if (result.ok) return new Set(result.stdout.split('\0').filter(Boolean));
  // Exit 1 also lands here; distinguish it from "not a worktree".
  return (await isInsideGitWorktree(cwd, signal)) ? new Set() : null;
}

function buildEntriesFromGitFilePaths(options: {
  readonly directoryWorkspacePath: string;
  readonly entryBudget: number;
  readonly recursive: boolean;
  readonly relativeFilePaths: readonly string[];
}): Map<string, CodeCollabV2FileTreeValue> {
  const candidates = new Map<string, CodeCollabV2FileTreeValue>();
  const conflicts = buildGitPathConflictIndex(options.relativeFilePaths);
  for (const relativeFilePath of options.relativeFilePaths) {
    const segments = relativeFilePath.split('/').filter((segment) => segment.length > 0);
    const maxSegmentIndex = options.recursive ? segments.length - 1 : 0;
    for (let index = 0; index <= maxSegmentIndex; index += 1) {
      const segment = segments[index];
      if (!segment) {
        break;
      }
      const relativePath = segments.slice(0, index + 1).join('/');
      const workspacePath = joinWorkspacePath(options.directoryWorkspacePath, relativePath);
      if (conflicts.has(relativePath)) {
        candidates.set(workspacePath, { kind: 'skipped', reason: 'path_conflict' });
        break;
      }
      if (index < segments.length - 1) {
        if (!candidates.has(workspacePath)) {
          candidates.set(workspacePath, { kind: 'lazy' });
        }
      } else {
        candidates.set(workspacePath, true);
      }
    }
  }

  const sortedCandidates = [...candidates.entries()].sort(([leftPath], [rightPath]) => {
    const depthOrder = pathDepth(leftPath) - pathDepth(rightPath);
    return depthOrder === 0 ? leftPath.localeCompare(rightPath) : depthOrder;
  });
  return new Map(sortedCandidates.slice(0, Math.max(0, options.entryBudget)));
}

function buildGitPathConflictIndex(relativeFilePaths: readonly string[]): Set<string> {
  const namesByDirectoryAndKey = new Map<string, Map<string, Set<string>>>();
  for (const relativeFilePath of relativeFilePaths) {
    const segments = relativeFilePath.split('/').filter((segment) => segment.length > 0);
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (!segment) {
        continue;
      }
      const parent = segments.slice(0, index).join('/');
      const comparisonKey = pathSegmentComparisonKey(segment);
      let namesByKey = namesByDirectoryAndKey.get(parent);
      if (!namesByKey) {
        namesByKey = new Map();
        namesByDirectoryAndKey.set(parent, namesByKey);
      }
      let names = namesByKey.get(comparisonKey);
      if (!names) {
        names = new Set();
        namesByKey.set(comparisonKey, names);
      }
      names.add(segment);
    }
  }

  const conflicts = new Set<string>();
  for (const [parent, namesByKey] of namesByDirectoryAndKey) {
    for (const names of namesByKey.values()) {
      if (names.size <= 1) {
        continue;
      }
      for (const name of names) {
        conflicts.add(parent ? `${parent}/${name}` : name);
      }
    }
  }
  return conflicts;
}

export function normalizeGitPath(filePath: string): string {
  return filePath.replace(/\\/gu, '/').normalize('NFC');
}

function isValidRelativeGitPath(filePath: string): boolean {
  return (
    filePath.length > 0 &&
    filePath !== '.' &&
    !path.isAbsolute(filePath) &&
    !filePath.split('/').some((segment) => segment.length === 0 || segment === '..')
  );
}

export function joinWorkspacePath(parent: string, child: string): string {
  return (parent ? `${parent}/${child}` : child).normalize('NFC');
}

export function pathSegmentComparisonKey(segment: string): string {
  return segment.normalize('NFC').toLocaleLowerCase('en-US');
}

export function pathDepth(workspacePath: string): number {
  return workspacePath ? workspacePath.split('/').length : 0;
}

function hasBinaryNul(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.byteLength, 8 * 1024);
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 0) {
      return true;
    }
  }
  return false;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}
