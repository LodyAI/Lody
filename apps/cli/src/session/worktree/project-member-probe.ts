import path from 'node:path';
import { Effect, FileSystem } from 'effect';
import {
  getProjectRepositoryFullName,
  isSafeProjectPath,
  resolveSessionFilePath,
  type ProjectLocalMemberProbe,
} from '@lody/shared';
import { WorktreeGit, WorktreeGitExecutionFailed } from './git-execution';

/** Read the registered repository's working .gitmodules. No init, sync, fetch or config writes. */
export const probeLocalProjectMember = Effect.fn('probeLocalProjectMember')(function* (
  rootPath: string
) {
  const git = yield* WorktreeGit;
  const fs = yield* FileSystem.FileSystem;
  const registeredRoot = yield* fs.realPath(rootPath);
  const registeredStat = yield* fs.stat(registeredRoot);
  if (registeredStat.type !== 'Directory')
    return yield* Effect.fail(
      new WorktreeGitExecutionFailed({
        message: 'Project group member is not a directory',
        cause: undefined,
      })
    );
  const gitRoot = yield* git
    .run({ cwd: registeredRoot, args: ['rev-parse', '--show-toplevel'] })
    .pipe(
      Effect.catchTag('WorktreeGitCommandFailed', (error) =>
        error.code === 128 &&
        (error.stderr.includes('not a git repository (or any of the parent directories)') ||
          error.stderr.includes('not a git repository (or any parent up to mount point '))
          ? Effect.succeed(null)
          : Effect.fail(error)
      )
    );
  if (gitRoot === null) return { isGit: false, submodules: [] } satisfies ProjectLocalMemberProbe;
  const root = yield* fs.realPath(gitRoot);
  const run = (args: readonly string[]) => git.run({ cwd: root, args });
  const optionalConfig = (args: readonly string[]) =>
    run(args).pipe(
      Effect.catchTag('WorktreeGitCommandFailed', (error) =>
        error.code === 1 ? Effect.succeed('') : Effect.fail(error)
      )
    );
  const origin = yield* optionalConfig(['config', '--get', 'remote.origin.url']);
  const repoFullName = getProjectRepositoryFullName(origin);
  const result: ProjectLocalMemberProbe = {
    isGit: true,
    ...(repoFullName ? { repoFullName } : {}),
    submodules: [],
  };
  const modules = path.join(root, '.gitmodules');
  if (!(yield* fs.exists(modules))) return result;
  const resolved = yield* fs.realPath(modules);
  const stat = yield* fs.stat(modules);
  if (
    resolveSessionFilePath([{ id: 'main', absolutePath: root }], resolved)?.relativePath !==
      '.gitmodules' ||
    Number(stat.size) > 256 * 1024
  )
    return yield* Effect.fail(
      new WorktreeGitExecutionFailed({
        message: 'Invalid project group submodule configuration',
        cause: undefined,
      })
    );
  const config = yield* optionalConfig([
    'config',
    '--no-includes',
    '--file',
    modules,
    '--null',
    '--get-regexp',
    '^submodule\\..*\\.(path|url)$',
  ]);
  const entries = new Map<string, { path?: string; url?: string }>();
  for (const record of config.split('\0')) {
    const newline = record.indexOf('\n');
    if (newline < 0) continue;
    const key = /^(submodule\..*)\.(path|url)$/.exec(record.slice(0, newline));
    if (!key) continue;
    const entry = entries.get(key[1]!) ?? {};
    entry[key[2] as 'path' | 'url'] = record.slice(newline + 1);
    entries.set(key[1]!, entry);
  }
  for (const entry of entries.values()) {
    if (!entry.path || !isSafeProjectPath(entry.path) || !entry.url) continue;
    const url = entry.url.trim();
    const identity = getProjectRepositoryFullName(url, repoFullName);
    // Relative .gitmodules URLs remain portable. Machine-local absolute/file URLs do not.
    const localUrl = /^(?:\/|[A-Za-z]:[\\/]|\\\\|file:|~)/i.test(url);
    result.submodules.push({
      path: entry.path,
      url: localUrl ? '' : url,
      ...(identity ? { repoFullName: identity } : {}),
    });
  }
  return result;
});
