import path from 'node:path';
import { Effect } from 'effect';
import { isSafeProjectPath, projectRepositoryUrlIdentity } from '@lody/shared';
import { WorktreeGit, WorktreeGitExecutionFailed } from './git-execution';
import {
  getAllocatedSessionBranchName,
  resolveAvailableBranchName,
} from './branch-name-allocation';

/** Validates a configured Member against the parent's actual gitlink before any checkout. */
export const inspectProjectSubmodule = Effect.fn('inspectProjectSubmodule')(function* (options: {
  parentPath: string;
  submodulePath: string;
  expectedRepositoryUrl: string;
  env?: NodeJS.ProcessEnv;
}) {
  const git = yield* WorktreeGit;
  const fail = (message: string) =>
    Effect.fail(new WorktreeGitExecutionFailed({ message, cause: undefined }));
  if (!isSafeProjectPath(options.submodulePath))
    return yield* fail('Invalid Project submodule path');
  const run = (args: readonly string[]) =>
    git.run({ args, cwd: options.parentPath, env: options.env });
  const tree = yield* run(['ls-tree', '-z', 'HEAD', '--', options.submodulePath]);
  const rows = tree.split('\0').filter(Boolean);
  const match =
    rows.length === 1 ? /^160000 commit ([0-9a-f]{40,64})\t(.+)$/.exec(rows[0] ?? '') : null;
  if (!match || match[2] !== options.submodulePath)
    return yield* fail('Project Member is not a gitlink in the parent revision');
  const committedModules = yield* run(['rev-parse', 'HEAD:.gitmodules']);
  const workingModules = yield* run(['hash-object', '.gitmodules']);
  if (committedModules !== workingModules)
    return yield* fail('Project submodule configuration differs from the parent revision');
  const entries = yield* run([
    'config',
    '--file',
    '.gitmodules',
    '--get-regexp',
    '^submodule\\..*\\.path$',
  ]);
  const entry = entries
    .split('\n')
    .map((line) => /^(submodule\..*)\.path\s+(.+)$/.exec(line))
    .find((row) => row?.[2] === options.submodulePath);
  if (!entry?.[1]) return yield* fail('Project Member is absent from .gitmodules');
  // Git itself resolves relative URLs against the parent remote without fetching.
  yield* run(['submodule', 'sync', '--', options.submodulePath]);
  yield* run(['submodule', 'init', '--', options.submodulePath]);
  const url = yield* run(['config', '--get', `${entry[1]}.url`]);
  if (
    projectRepositoryUrlIdentity(url) !==
    projectRepositoryUrlIdentity(options.expectedRepositoryUrl)
  ) {
    return yield* fail('Project submodule repository no longer matches the frozen Member');
  }
  return {
    commit: match[1] as string,
    path: path.join(options.parentPath, options.submodulePath),
    configKey: entry[1],
  };
});

/** Caller owns the Project mutation lease and must retain partial materialization on failure. */
export const checkoutProjectSubmodule = Effect.fn('checkoutProjectSubmodule')(function* (options: {
  parentPath: string;
  submodulePath: string;
  expectedRepositoryUrl: string;
  sessionId: string;
  local: boolean;
  repositoryPath: string;
  restore?: { repositoryPath: string; branch: string };
  env?: NodeJS.ProcessEnv;
}) {
  const git = yield* WorktreeGit;
  if (options.restore && !path.isAbsolute(options.restore.repositoryPath))
    return yield* Effect.fail(
      new WorktreeGitExecutionFailed({
        message: 'Submodule restore requires a machine-resolved repository path',
        cause: undefined,
      })
    );
  const inspected = yield* inspectProjectSubmodule(options);
  yield* git.run({
    // Restore unpublished gitlinks from the durable local store before contacting the remote.
    // Nested selected members are restored separately before recursive initialization.
    args: options.restore
      ? [
          '-c',
          'protocol.file.allow=always',
          '-c',
          `${inspected.configKey}.url=${options.restore.repositoryPath}`,
          'submodule',
          'update',
          '--init',
          '--',
          options.submodulePath,
        ]
      : ['submodule', 'update', '--init', '--recursive', '--', options.submodulePath],
    cwd: options.parentPath,
    env: options.env,
  });
  const run = (args: readonly string[]) => git.run({ args, cwd: inspected.path, env: options.env });
  const branches = (yield* run(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])).split(
    '\n'
  );
  if (options.restore) {
    yield* run(['remote', 'set-url', 'origin', options.expectedRepositoryUrl]);
    yield* run(['check-ref-format', '--branch', options.restore.branch]);
    if (!path.isAbsolute(options.restore.repositoryPath))
      return yield* Effect.fail(
        new WorktreeGitExecutionFailed({
          message: 'Submodule restore requires a machine-resolved repository path',
          cause: undefined,
        })
      );
    yield* run([
      'fetch',
      '--no-tags',
      options.restore.repositoryPath,
      `refs/heads/${options.restore.branch}`,
    ]);
    // Never replace a branch: a same-name ref left by an interrupted restore must agree.
    if (branches.includes(options.restore.branch)) {
      const old = yield* run(['rev-parse', `refs/heads/${options.restore.branch}`]);
      const saved = yield* run(['rev-parse', 'FETCH_HEAD']);
      if (old !== saved)
        return yield* Effect.fail(
          new WorktreeGitExecutionFailed({
            message: 'Submodule restore branch differs from saved branch',
            cause: undefined,
          })
        );
      yield* run(['checkout', options.restore.branch]);
    } else yield* run(['checkout', '-b', options.restore.branch, 'FETCH_HEAD']);
    return { ...inspected, branch: options.restore.branch };
  }
  if (!path.isAbsolute(options.repositoryPath))
    return yield* Effect.fail(
      new WorktreeGitExecutionFailed({
        message: 'Submodule allocation requires a machine-resolved repository path',
        cause: undefined,
      })
    );
  const persistedBranches = (yield* git.run({
    cwd: options.repositoryPath,
    args: ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'],
  })).split('\n');
  const branch = resolveAvailableBranchName(
    getAllocatedSessionBranchName(options.sessionId, options.local),
    [...branches, ...persistedBranches]
  );
  yield* run(['checkout', '-b', branch, inspected.commit]);
  return { ...inspected, branch };
});

/** Save the task branch before deinitializing the parent, which owns submodule Git storage. */
export const persistProjectSubmoduleBranch = Effect.fn('persistProjectSubmoduleBranch')(
  function* (options: { memberPath: string; repositoryPath: string; sessionId: string }) {
    const git = yield* WorktreeGit;
    const run = (args: readonly string[]) => git.run({ args, cwd: options.memberPath });
    if (!path.isAbsolute(options.repositoryPath))
      return yield* Effect.fail(
        new WorktreeGitExecutionFailed({
          message: 'Submodule backup requires a machine-resolved repository path',
          cause: undefined,
        })
      );
    const branch = yield* run(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    yield* run(['add', '-A']);
    const changed = yield* run(['diff', '--cached', '--name-only']);
    if (changed)
      yield* git.run({
        cwd: options.memberPath,
        args: [
          '-c',
          'commit.gpgsign=false',
          'commit',
          '-m',
          `chore: archive backup for session ${options.sessionId.slice(0, 8)}`,
        ],
        env: {
          GIT_AUTHOR_NAME: 'Lody',
          GIT_AUTHOR_EMAIL: 'noreply@lody.ai',
          GIT_COMMITTER_NAME: 'Lody',
          GIT_COMMITTER_EMAIL: 'noreply@lody.ai',
        },
      });
    // A local fetch preserves objects and the branch without remote pushes. A conflicting
    // non-fast-forward destination fails closed, retaining the entire Project directory.
    yield* git.run({
      cwd: options.repositoryPath,
      args: ['fetch', '--no-tags', options.memberPath, `refs/heads/${branch}:refs/heads/${branch}`],
    });
    return branch;
  }
);
