import type { Dir, Dirent } from 'node:fs';
import { opendir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Effect } from 'effect';
import { runPromiseEffect, tryPromiseEffect as promiseEffect } from './effect-utils';
import { isIgnoredByGitignoreRules, parseGitignoreRules, type GitignoreRule } from './gitignore';
import { isInsideWorkspace, isMissingPathError, toWorkspacePath } from './workspace-paths';

/**
 * Directory names always skipped, regardless of `.gitignore` contents.
 * Watching these is the dominant cost of a recursive workspace watch (a
 * typical repo is ~98% `node_modules`/`.git`), so they are excluded up front.
 */
export const DEFAULT_IGNORED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  '.git',
  '.hg',
  '.svn',
  // Lody's own workspace state (e.g. .lody/attachments); must not appear in
  // code-collab change tracking even when the workspace is not a git repo.
  '.lody',
  'node_modules',
]);

/**
 * Ceiling on how many directories a walk/watcher will enumerate. A
 * non-ignored source tree is normally far below this; the cap only guards
 * pathological trees from exhausting the inotify watch budget.
 */
export const DEFAULT_MAX_WATCHED_DIRECTORIES = 50_000;

interface PendingWorkspaceDirectory {
  readonly activeRules: readonly GitignoreRule[];
  readonly dir: string;
  readonly relativePath: string;
}

export interface ListNonIgnoredWorkspaceDirectoriesOptions {
  readonly workspaceRoot: string;
  /**
   * Relative POSIX directory to start the walk from (`''` = workspace
   * root). Used for incremental subtree discovery when a new directory
   * appears on disk; ancestor `.gitignore` rules are loaded so the
   * subtree is filtered exactly as a full walk would filter it.
   */
  readonly startDirectory?: string;
  readonly ignoredDirectoryNames?: ReadonlySet<string>;
  readonly maxDirectories?: number;
}

/**
 * Walk the workspace and return every directory that is NOT excluded by
 * the default ignored names or `.gitignore`, as relative POSIX paths (the
 * start directory is included; the workspace root is `''`). Unlike a file
 * scan, this includes directories with no tracked files (e.g. empty dirs),
 * because a watcher must place a watch on them to detect files later
 * created inside.
 *
 * Symlinked directories are not descended into (Dirent.isDirectory() is
 * false for symlinks), which keeps the walk acyclic and avoids escaping
 * the workspace.
 */
export function listNonIgnoredWorkspaceDirectoriesEffect(
  options: ListNonIgnoredWorkspaceDirectoriesOptions
): Effect.Effect<readonly string[], unknown> {
  return Effect.gen(function* () {
    const workspaceRoot = path.resolve(options.workspaceRoot);
    const ignored = options.ignoredDirectoryNames ?? DEFAULT_IGNORED_DIRECTORY_NAMES;
    const maxDirectories = options.maxDirectories ?? DEFAULT_MAX_WATCHED_DIRECTORIES;
    const startDirectory = options.startDirectory ?? '';
    const startAbsolute =
      startDirectory === '' ? workspaceRoot : path.resolve(workspaceRoot, startDirectory);
    if (!isInsideWorkspace(workspaceRoot, startAbsolute)) return [];

    const ancestorGitignoreFiles: string[] = [];
    const ancestorRules =
      startDirectory === ''
        ? []
        : yield* readAncestorGitignoreRulesEffect({
            directoryPath: startDirectory,
            gitignoreFiles: ancestorGitignoreFiles,
            workspaceRoot,
          });

    // A subtree walk (`startDirectory` set, e.g. dynamic discovery of a
    // freshly created directory) must refuse to list the start directory
    // itself when it is ignored — otherwise a newly created `dist/` /
    // `node_modules/` would get watched and reintroduce the churn the
    // ignore filtering exists to remove. A full walk (`startDirectory ===
    // ''`) never hits this: the root is always watched.
    if (startDirectory !== '') {
      const startBasename = startDirectory.split('/').filter(Boolean).pop();
      if (startBasename !== undefined && ignored.has(startBasename)) return [];
      if (isIgnoredByGitignoreRules(startDirectory, true, ancestorRules)) return [];
    }

    const directories: string[] = [];
    const queue: PendingWorkspaceDirectory[] = [
      { activeRules: ancestorRules, dir: startAbsolute, relativePath: startDirectory },
    ];
    for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
      if (directories.length >= maxDirectories) break;
      const current = queue[queueIndex]!;
      directories.push(current.relativePath);

      const localRules = yield* readGitignoreRulesEffect(workspaceRoot, current.dir).pipe(
        Effect.catch(() => Effect.succeed({ rules: [], sources: [] }))
      );
      const activeRules = [...current.activeRules, ...localRules.rules];

      const entriesResult = yield* Effect.result(readDirectoryEntriesEffect(current.dir));
      if (entriesResult._tag === 'Failure') continue;
      for (const entry of entriesResult.success) {
        if (!entry.isDirectory()) continue;
        if (ignored.has(entry.name)) continue;
        const absolutePath = path.join(current.dir, entry.name);
        const relativePath = toWorkspacePath(workspaceRoot, absolutePath);
        if (isIgnoredByGitignoreRules(relativePath, true, activeRules)) continue;
        queue.push({ activeRules, dir: absolutePath, relativePath });
      }
    }
    return directories;
  });
}

export async function listNonIgnoredWorkspaceDirectories(
  options: ListNonIgnoredWorkspaceDirectoriesOptions
): Promise<readonly string[]> {
  return runPromiseEffect(listNonIgnoredWorkspaceDirectoriesEffect(options));
}

export function readAncestorGitignoreRulesEffect(input: {
  readonly directoryPath: string;
  readonly gitignoreFiles: string[];
  readonly workspaceRoot: string;
}): Effect.Effect<readonly GitignoreRule[], unknown> {
  return Effect.gen(function* () {
    const activeRules: GitignoreRule[] = [];
    const segments = input.directoryPath.split('/').filter(Boolean);
    let currentRelativePath = '';
    for (let index = 0; index < segments.length; index += 1) {
      const dir =
        currentRelativePath === ''
          ? input.workspaceRoot
          : path.resolve(input.workspaceRoot, currentRelativePath);
      const localRules = yield* readGitignoreRulesEffect(input.workspaceRoot, dir);
      activeRules.push(...localRules.rules);
      input.gitignoreFiles.push(...localRules.sources);
      currentRelativePath =
        currentRelativePath === ''
          ? segments[index]!
          : `${currentRelativePath}/${segments[index]!}`;
    }
    return activeRules;
  });
}

export function readGitignoreRulesEffect(
  workspaceRoot: string,
  dir: string
): Effect.Effect<
  {
    readonly rules: readonly GitignoreRule[];
    readonly sources: readonly string[];
  },
  unknown
> {
  const absolutePath = path.join(dir, '.gitignore');
  return promiseEffect(() => readFile(absolutePath, 'utf8')).pipe(
    Effect.map((text) => {
      const source = toWorkspacePath(workspaceRoot, absolutePath);
      const basePath = toWorkspacePath(workspaceRoot, dir);
      return {
        rules: parseGitignoreRules(text, basePath === '' ? '' : basePath),
        sources: [source],
      };
    }),
    Effect.catch((error) => {
      if (isMissingPathError(error)) {
        return Effect.succeed({ rules: [], sources: [] });
      }
      return Effect.fail(error);
    })
  );
}

export function readDirectoryEntriesEffect(dir: string): Effect.Effect<readonly Dirent[], unknown> {
  return Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        promiseEffect(() => opendir(dir)),
        (handle) => promiseEffect(() => handle.close()).pipe(Effect.catch(() => Effect.void))
      );
      const entries = yield* readAllDirectoryEntriesEffect(directory);
      entries.sort((a, b) => a.name.localeCompare(b.name));
      return entries;
    })
  );
}

function readAllDirectoryEntriesEffect(directory: Dir): Effect.Effect<Dirent[], unknown> {
  return Effect.gen(function* () {
    const entries: Dirent[] = [];
    for (;;) {
      const entry = yield* promiseEffect(() => directory.read());
      if (!entry) break;
      entries.push(entry);
    }
    return entries;
  });
}
