import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type {
  CodeCollabV2AllChangesState,
  CodeCollabV2AllChangesValue,
  CodeCollabV2FileTreeValue,
} from '@lody/shared';

import { countTextLines } from './diff-line-counts';

// Pure Git-backed scanning + All Changes computation shared by the file-index
// Tinypool worker (`file-index-scan-worker.ts`) and the main-thread fallback in
// `code-collab-v2-service.ts`. Keep this module dependency-light (node builtins +
// `@lody/shared` types only) so the worker bundle stays free of wasm/top-level-await
// imports. The filesystem (`opendir`) directory-scan fallback is intentionally NOT
// here: its error classification differs between the worker and the service.

const execFileAsync = promisify(execFile);

const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export type GitDirectoryScanInput = {
  readonly directoryAbsolutePath: string;
  readonly directoryWorkspacePath: string;
  readonly entryBudget: number;
  readonly recursive: boolean;
};

export async function isInsideGitWorktree(workspaceRoot: string): Promise<boolean> {
  const inside = await runGit(workspaceRoot, ['rev-parse', '--is-inside-work-tree']);
  return inside.ok && inside.stdout.trim() === 'true';
}

export async function scanGitDirectoryEntries(
  options: GitDirectoryScanInput
): Promise<Map<string, CodeCollabV2FileTreeValue> | null> {
  if (!options.recursive) {
    return null;
  }
  const result = await runGitLsFiles(options.directoryAbsolutePath);
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
  cwd: string
): Promise<{ readonly ok: true; readonly paths: readonly string[] } | { readonly ok: false }> {
  try {
    const [{ stdout }, deleted] = await Promise.all([
      execFileAsync(
        'git',
        [
          '-C',
          cwd,
          'ls-files',
          '-z',
          '--cached',
          '--others',
          '--exclude-standard',
          '--deduplicate',
          '--',
          '.',
        ],
        { maxBuffer: GIT_MAX_BUFFER_BYTES }
      ),
      runGit(cwd, ['ls-files', '--deleted', '-z', '--', '.']),
    ]);
    const deletedPaths = deleted.ok
      ? new Set(deleted.stdout.split('\0').map(normalizeGitPath).filter(isValidRelativeGitPath))
      : new Set<string>();
    return {
      ok: true,
      paths: stdout
        .split('\0')
        .map(normalizeGitPath)
        .filter((filePath) => isValidRelativeGitPath(filePath) && !deletedPaths.has(filePath)),
    };
  } catch {
    return { ok: false };
  }
}

export async function computeAllChanges(
  workspaceRoot: string,
  options: { readonly preferredBaseBranch?: string } = {}
): Promise<CodeCollabV2AllChangesState> {
  const diffBase = await resolveAllChangesDiffBase(workspaceRoot, options.preferredBaseBranch);
  const diffTarget = diffBase ?? 'HEAD';
  const [numstat, nameStatus, untracked] = await Promise.all([
    // `--numstat` cannot use `-z`, so disable `core.quotePath` to keep non-ASCII paths
    // raw (matching the `-z` outputs below); otherwise they are mis-keyed and lose their
    // All Changes diff counts.
    runGit(workspaceRoot, [
      '-c',
      'core.quotePath=false',
      'diff',
      '--numstat',
      '--no-renames',
      '--relative',
      diffTarget,
      '--',
    ]),
    runGit(workspaceRoot, [
      'diff',
      '--name-status',
      '--no-renames',
      '-z',
      '--relative',
      diffTarget,
      '--',
    ]),
    runGit(workspaceRoot, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  if (!numstat.ok && !nameStatus.ok && !untracked.ok) {
    return {};
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
        changes[normalizedPath] = true;
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
    for (const filePath of untracked.stdout.split('\0')) {
      if (!filePath) continue;
      const normalizedPath = normalizeGitPath(filePath);
      if (!(normalizedPath in changes)) {
        changes[normalizedPath] = await lineStatsForUntrackedFile(workspaceRoot, normalizedPath);
      }
    }
  }
  return changes;
}

async function resolveAllChangesDiffBase(
  workspaceRoot: string,
  preferredBaseBranch?: string
): Promise<string | null> {
  if (!(await isInsideGitWorktree(workspaceRoot))) {
    return null;
  }

  const baseRef = await resolveAllChangesBaseRef(workspaceRoot, preferredBaseBranch);
  if (baseRef) {
    const mergeBase = await runGit(workspaceRoot, ['merge-base', baseRef, 'HEAD']);
    const trimmed = mergeBase.ok ? mergeBase.stdout.trim() : '';
    if (trimmed) {
      return trimmed;
    }
  }

  const head = await runGit(workspaceRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
  return head.ok && head.stdout.trim() ? 'HEAD' : null;
}

async function resolveAllChangesBaseRef(
  workspaceRoot: string,
  preferredBaseBranch?: string
): Promise<string | null> {
  const candidates = [
    ...(preferredBaseBranch ? [`origin/${preferredBaseBranch}`, preferredBaseBranch] : []),
    'origin/main',
    'main',
    'origin/master',
    'master',
    'origin/HEAD',
  ];
  for (const candidate of candidates) {
    const exists = await runGit(workspaceRoot, ['rev-parse', '--verify', `${candidate}^{commit}`]);
    if (exists.ok) {
      return candidate;
    }
  }
  return null;
}

async function lineStatsForUntrackedFile(
  workspaceRoot: string,
  workspacePath: string
): Promise<CodeCollabV2AllChangesValue> {
  try {
    const absolutePath = path.resolve(workspaceRoot, workspacePath);
    const bytes = await readFile(absolutePath);
    if (hasBinaryNul(bytes)) return true;
    const text = decodeUtf8(bytes);
    return { diff: [countTextLines(text), 0] };
  } catch {
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
  args: readonly string[]
): Promise<{ readonly ok: true; readonly stdout: string } | { readonly ok: false }> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      maxBuffer: GIT_MAX_BUFFER_BYTES,
    });
    return { ok: true, stdout };
  } catch {
    return { ok: false };
  }
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
