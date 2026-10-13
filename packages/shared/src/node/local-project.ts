import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type {
  LocalProjectGitState,
  LocalProjectId,
  LocalProjectWorkingTreeState,
} from '../project';
import { parseGitHubRepo } from '../worktree-paths';
import { Context, Data, Effect, Exit, FileSystem, Layer, ManagedRuntime } from 'effect';
import { NodeFileSystem } from '@effect/platform-node-shared';
import { ChildProcessSpawner } from 'effect/process';
import { runCommand, processLayer, squashProcessFailure, type RunCommandError } from './process';

export class LocalProjectGitError extends Data.TaggedError('LocalProjectGitError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
export type LocalProjectError = LocalProjectGitError | RunCommandError;

/** Small path capability also supplied synchronously at the Legacy boundary. */
export class LocalProjectPaths extends Context.Service<
  LocalProjectPaths,
  {
    readonly realPath: (path: string) => Effect.Effect<string, LocalProjectGitError>;
    readonly isDirectory: (path: string) => Effect.Effect<boolean, LocalProjectGitError>;
  }
>()('lody/LocalProjectPaths') {}
export class LocalProjectHost extends Context.Service<
  LocalProjectHost,
  {
    readonly env: Effect.Effect<NodeJS.ProcessEnv>;
  }
>()('lody/LocalProjectHost') {}
type NativeServices =
  | LocalProjectPaths
  | LocalProjectHost
  | ChildProcessSpawner.ChildProcessSpawner;

export const LocalProjectPathsLive = Layer.effect(
  LocalProjectPaths,
  Effect.gen(function* () {
    const filesystem = yield* FileSystem.FileSystem;
    return LocalProjectPaths.of({
      realPath: (input) =>
        filesystem.realPath(input).pipe(
          Effect.catch((cause) =>
            cause.reason._tag === 'NotFound'
              ? Effect.succeed(input)
              : Effect.fail(
                  new LocalProjectGitError({
                    message: `Failed to resolve local project path: ${input}`,
                    cause,
                  })
                )
          )
        ),
      isDirectory: (input) =>
        filesystem.stat(input).pipe(
          Effect.map((info) => info.type === 'Directory'),
          Effect.mapError(
            (cause) =>
              new LocalProjectGitError({ message: 'Selected path is not a directory', cause })
          )
        ),
    });
  })
);
const normalizeCanonicalRootPath = (real: string): string => {
  const normalized = path.normalize(real);
  const root = path.parse(normalized).root;
  return root && normalized === root ? root : normalized.replace(/[\\/]+$/, '');
};
const hashCanonicalProjectRoot = (root: string): LocalProjectId =>
  `local-project-${createHash('sha256').update(root).digest('hex').slice(0, 24)}` as LocalProjectId;

const normalizeLocalProjectRootPathImpl = (inputPath: string) =>
  Effect.gen(function* () {
    const paths = yield* LocalProjectPaths;
    return normalizeCanonicalRootPath(yield* paths.realPath(path.resolve(inputPath)));
  });
const ensureLocalProjectRootPathImpl = (inputPath: string) =>
  Effect.gen(function* () {
    const normalized = yield* normalizeLocalProjectRootPathImpl(inputPath.trim());
    const paths = yield* LocalProjectPaths;
    if (!(yield* paths.isDirectory(normalized)))
      return yield* Effect.fail(
        new LocalProjectGitError({ message: 'Selected path is not a directory' })
      );
    return normalized;
  });
const createLocalProjectIdImpl = (rootPath: string) =>
  Effect.map(normalizeLocalProjectRootPathImpl(rootPath), hashCanonicalProjectRoot);

type GitCommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

type GitCommandOptions = {
  timeoutMs?: number;
};

export type ResolvedLocalProjectBranch =
  | {
      kind: 'local';
      branchName: string;
      refName: string;
      commitHash: string;
    }
  | {
      kind: 'remote';
      branchName: string;
      remoteName: string;
      refName: string;
      commitHash: string;
    };

export type ParsedLocalProjectBranchRef =
  | Omit<Extract<ResolvedLocalProjectBranch, { kind: 'local' }>, 'commitHash'>
  | Omit<Extract<ResolvedLocalProjectBranch, { kind: 'remote' }>, 'commitHash'>;

// Read-only probes need a tight budget: a single git-state RPC issues ~8
// sequential `git` calls, all under one 30 s RPC timeout. A 10 s ceiling on
// the first command alone would burn the whole budget on a stalled filesystem
// or fsmonitor hook with nothing left for the remaining probes.
const DEFAULT_GIT_COMMAND_TIMEOUT_MS = 5_000;
const GIT_CHECKOUT_TIMEOUT_MS = 30_000;
const GIT_COMMAND_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export function getLocalProjectNameFromRootPath(rootPath: string): string {
  const base = path.basename(rootPath);
  return base || rootPath;
}

function runGitCommandImpl(
  rootPath: string,
  args: string[],
  options: GitCommandOptions = {}
): Effect.Effect<GitCommandResult, LocalProjectError, NativeServices> {
  return Effect.gen(function* () {
    const host = yield* LocalProjectHost;
    const env = yield* host.env;
    const result = yield* runCommand({
      command: 'git',
      args,
      cwd: rootPath,
      timeout: options.timeoutMs ?? DEFAULT_GIT_COMMAND_TIMEOUT_MS,
      maxOutputBytes: GIT_COMMAND_MAX_BUFFER_BYTES,
      env: { ...env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    });
    // Nonzero exit statuses remain domain outcomes for absent refs/non-Git paths.
    // Startup, timeout, I/O, interruption and release failures never become status null.
    if (result.code === null)
      return yield* Effect.fail(
        new LocalProjectGitError({
          message: `Git command terminated without an exit status: ${result.signal ?? 'unknown'}`,
        })
      );
    return {
      status: result.code,
      stdout: result.stdout.toString('utf8'),
      stderr: result.stderr.toString('utf8'),
    };
  });
}
const checkGitStatus = (
  result: GitCommandResult,
  operation: string,
  allowed: readonly number[] = [0]
) =>
  allowed.includes(result.status)
    ? Effect.void
    : Effect.fail(
        new LocalProjectGitError({
          message: `${operation}: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`}`,
        })
      );
const isUnbornHead = (result: GitCommandResult) =>
  result.status === 128 &&
  result.stderr.includes("ambiguous argument 'HEAD': unknown revision or path");

function isGitRepositoryImpl(
  rootPath: string
): Effect.Effect<boolean, LocalProjectError, NativeServices> {
  return Effect.gen(function* () {
    // Git inherits repository context from parent directories. A registered local
    // project is Git-capable only when its own root is the worktree root.
    const probe = yield* runGitCommandImpl(rootPath, ['rev-parse', '--show-toplevel']);
    if (
      probe.status === 128 &&
      (probe.stderr.startsWith('fatal: not a git repository') ||
        probe.stderr.startsWith('fatal: this operation must be run in a work tree'))
    )
      return false;
    yield* checkGitStatus(probe, 'Failed to inspect git repository');
    const repositoryRoot = probe.stdout.trim();
    if (!repositoryRoot)
      return yield* Effect.fail(
        new LocalProjectGitError({ message: 'Git repository probe returned no root' })
      );
    return (
      (yield* normalizeLocalProjectRootPathImpl(repositoryRoot)) ===
      (yield* normalizeLocalProjectRootPathImpl(rootPath))
    );
  });
}

function assertGitRepositoryImpl(
  rootPath: string
): Effect.Effect<void, LocalProjectError, NativeServices> {
  return Effect.gen(function* () {
    if (!(yield* isGitRepositoryImpl(rootPath))) {
      yield* Effect.fail(
        new LocalProjectGitError({ message: 'Local project is not a git repository' })
      );
    }
  });
}

function parseGitRemoteDefaultBranch(raw: string, remoteName: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const prefix = `${remoteName}/`;
  if (!trimmed.startsWith(prefix)) return null;
  const name = trimmed.slice(prefix.length).trim();
  return name || null;
}
function listGitRemotesImpl(
  rootPath: string
): Effect.Effect<string[], LocalProjectError, NativeServices> {
  return Effect.gen(function* () {
    const remoteResult = yield* runGitCommandImpl(rootPath, ['remote']);
    yield* checkGitStatus(remoteResult, 'Failed to inspect git remotes');
    return remoteResult.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  });
}

function resolveCommitAtRefImpl(
  rootPath: string,
  refName: string
): Effect.Effect<string | null, LocalProjectError, NativeServices> {
  return Effect.gen(function* () {
    // `rev-parse --verify` accepts revision expressions such as `foo~0`; branch
    // selectors must resolve one exact ref so a failed lookup cannot mutate the
    // registered repository before reporting branch-not-found.
    const exists = yield* runGitCommandImpl(rootPath, ['show-ref', '--verify', '--quiet', refName]);
    yield* checkGitStatus(exists, 'Failed to inspect git ref', [0, 1]);
    if (exists.status === 1) return null;
    const result = yield* runGitCommandImpl(rootPath, ['show-ref', '--verify', '--hash', refName]);
    yield* checkGitStatus(result, 'Failed to resolve git ref');
    const commitHash = result.stdout.trim();
    return commitHash || null;
  });
}

const LOCAL_BRANCH_SELECTOR_PREFIX = 'lody:branch:local:';
const REMOTE_BRANCH_SELECTOR_PREFIX = 'lody:branch:remote:';

export function createLocalProjectBranchSelector(candidate: {
  kind: 'local' | 'remote';
  branchName: string;
  remoteName?: string;
}): string {
  if (candidate.kind === 'local') {
    return `${LOCAL_BRANCH_SELECTOR_PREFIX}${encodeURIComponent(candidate.branchName)}`;
  }
  return `${REMOTE_BRANCH_SELECTOR_PREFIX}${encodeURIComponent(
    candidate.remoteName ?? ''
  )}:${encodeURIComponent(candidate.branchName)}`;
}

function parseBranchSelector(
  selector: string
):
  | { kind: 'local'; branchName: string }
  | { kind: 'remote'; remoteName: string; branchName: string }
  | null {
  try {
    if (selector.startsWith(LOCAL_BRANCH_SELECTOR_PREFIX)) {
      const branchName = decodeURIComponent(selector.slice(LOCAL_BRANCH_SELECTOR_PREFIX.length));
      return branchName ? { kind: 'local', branchName } : null;
    }
    if (selector.startsWith(REMOTE_BRANCH_SELECTOR_PREFIX)) {
      const encoded = selector.slice(REMOTE_BRANCH_SELECTOR_PREFIX.length);
      const separator = encoded.indexOf(':');
      if (separator < 0) return null;
      const remoteName = decodeURIComponent(encoded.slice(0, separator));
      const branchName = decodeURIComponent(encoded.slice(separator + 1));
      return remoteName && branchName ? { kind: 'remote', remoteName, branchName } : null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Maps a branch name onto one of the selectors a project reported, applying the
 * same local-first precedence as `preferLocalOnCollision`. Callers that only
 * hold a remote machine's branch list use this instead of a plain membership
 * test, so a human-typed `main` still finds `lody:branch:local:main`.
 */
export function selectLocalProjectBranchSelector(
  branches: string[],
  branchName: string
): string | null {
  const normalizedBranchName = branchName.trim();
  if (!normalizedBranchName) return null;
  if (branches.includes(normalizedBranchName)) return normalizedBranchName;

  const localSelector = createLocalProjectBranchSelector({
    kind: 'local',
    branchName: normalizedBranchName,
  });
  if (branches.includes(localSelector)) return localSelector;

  const remoteMatches = branches.filter((branch) => {
    const parsed = parseBranchSelector(branch);
    return parsed?.kind === 'remote' && parsed.branchName === normalizedBranchName;
  });
  return remoteMatches.length === 1 ? remoteMatches[0]! : null;
}

function findQualifiedRemoteName(remotes: string[], branchName: string): string | null {
  return (
    [...remotes]
      .sort((a, b) => b.length - a.length)
      .find((remote) => branchName.startsWith(`${remote}/`)) ?? null
  );
}
function resolveLocalProjectBranchRefAtRootPathImpl(
  rootPath: string,
  refName: string
): Effect.Effect<ResolvedLocalProjectBranch, LocalProjectError, NativeServices> {
  return Effect.gen(function* () {
    const parsedRef = yield* parseLocalProjectBranchRefAtRootPathImpl(rootPath, refName);
    const commitHash = yield* resolveCommitAtRefImpl(rootPath, parsedRef.refName);
    if (!commitHash) {
      return yield* Effect.fail(
        new LocalProjectGitError({
          message: `Local project branch ref not found: ${parsedRef.refName}`,
        })
      );
    }
    return { ...parsedRef, commitHash };
  });
}

function parseLocalProjectBranchRefAtRootPathImpl(
  rootPath: string,
  refName: string
): Effect.Effect<ParsedLocalProjectBranchRef, LocalProjectError, NativeServices> {
  return Effect.gen(function* () {
    const normalizedRootPath = yield* ensureLocalProjectRootPathImpl(rootPath);
    const normalizedRefName = refName.trim();
    yield* assertGitRepositoryImpl(normalizedRootPath);
    const formatResult = yield* runGitCommandImpl(normalizedRootPath, [
      'check-ref-format',
      normalizedRefName,
    ]);
    if (formatResult.status !== 0) {
      return yield* Effect.fail(
        new LocalProjectGitError({
          message: `Local project branch ref not found: ${normalizedRefName}`,
        })
      );
    }
    if (normalizedRefName.startsWith('refs/heads/')) {
      const branchName = normalizedRefName.slice('refs/heads/'.length);
      if (!branchName) {
        return yield* Effect.fail(
          new LocalProjectGitError({
            message: `Local project branch ref not found: ${normalizedRefName}`,
          })
        );
      }
      return { kind: 'local', branchName, refName: normalizedRefName };
    }
    if (normalizedRefName.startsWith('refs/remotes/')) {
      const qualifiedName = normalizedRefName.slice('refs/remotes/'.length);
      const remoteName = findQualifiedRemoteName(
        yield* listGitRemotesImpl(normalizedRootPath),
        qualifiedName
      );
      const branchName = remoteName ? qualifiedName.slice(remoteName.length + 1) : '';
      if (!remoteName || !branchName) {
        return yield* Effect.fail(
          new LocalProjectGitError({
            message: `Local project branch ref not found: ${normalizedRefName}`,
          })
        );
      }
      return {
        kind: 'remote',
        branchName,
        remoteName,
        refName: normalizedRefName,
      };
    }
    return yield* Effect.fail(
      new LocalProjectGitError({
        message: `Local project branch ref not found: ${normalizedRefName}`,
      })
    );
  });
}

function getLocalProjectBranchUpstreamRefAtRootPathImpl(
  rootPath: string,
  branchName: string
): Effect.Effect<string | null, LocalProjectError, NativeServices> {
  return Effect.gen(function* () {
    const normalizedRootPath = yield* ensureLocalProjectRootPathImpl(rootPath);
    const normalizedBranchName = branchName.trim();
    if (!normalizedBranchName) return null;
    yield* assertGitRepositoryImpl(normalizedRootPath);
    const result = yield* runGitCommandImpl(normalizedRootPath, [
      'for-each-ref',
      '--format=%(upstream)',
      `refs/heads/${normalizedBranchName}`,
    ]);
    yield* checkGitStatus(result, 'Failed to inspect git upstream');
    const upstreamRef = result.stdout.trim();
    return upstreamRef.startsWith('refs/remotes/') ? upstreamRef : null;
  });
}

function getLocalProjectCurrentBranchNameAtRootPathImpl(
  rootPath: string
): Effect.Effect<string | null, LocalProjectError, NativeServices> {
  return Effect.gen(function* () {
    const normalizedRootPath = yield* ensureLocalProjectRootPathImpl(rootPath);
    yield* assertGitRepositoryImpl(normalizedRootPath);
    const result = yield* runGitCommandImpl(normalizedRootPath, [
      'symbolic-ref',
      '--quiet',
      '--short',
      'HEAD',
    ]);
    yield* checkGitStatus(result, 'Failed to inspect current git branch', [0, 1]);
    const branchName = result.status === 0 ? result.stdout.trim() : '';
    return branchName || null;
  });
}

function resolveLocalProjectLegacyBaseBranchAtRootPathImpl(
  rootPath: string,
  branchName: string,
  options: {
    useWorktree?: boolean;
  } = {}
): Effect.Effect<ResolvedLocalProjectBranch, LocalProjectError, NativeServices> {
  return Effect.gen(function* () {
    const normalizedRootPath = yield* ensureLocalProjectRootPathImpl(rootPath);
    const normalizedBranchName = branchName.trim();
    if (!normalizedBranchName) {
      return yield* Effect.fail(new LocalProjectGitError({ message: 'Branch name is required' }));
    }
    // Old sessions stored the selector in baseBranch. In checkout mode a
    // remote-only selector may since have created a same-named local tracking
    // branch, so recover its exact upstream before ordinary selector precedence
    // can mistake the work branch for the review base. Worktree mode never checks
    // the base out in the project root, so a same-named local branch there is the
    // user's own branch and must be preserved as-is.
    if (options.useWorktree !== true && !parseBranchSelector(normalizedBranchName)) {
      yield* assertGitRepositoryImpl(normalizedRootPath);
      const localRef = `refs/heads/${normalizedBranchName}`;
      if (yield* resolveCommitAtRefImpl(normalizedRootPath, localRef)) {
        const upstream = yield* runGitCommandImpl(normalizedRootPath, [
          'for-each-ref',
          '--format=%(upstream)',
          localRef,
        ]);
        yield* checkGitStatus(upstream, 'Failed to inspect git upstream');
        const upstreamRef = upstream.stdout.trim();
        if (upstreamRef.startsWith('refs/remotes/')) {
          return yield* resolveLocalProjectBranchRefAtRootPathImpl(normalizedRootPath, upstreamRef);
        }
      }
    }
    // A legacy value was handed straight to `git checkout` / `git worktree add`,
    // which resolve a bare name local-first. Keep that precedence: `master` in a
    // repository that also has `origin/master` meant refs/heads/master, and
    // failing it as ambiguous strands every session created before selectors.
    return yield* resolveLocalProjectBranchAtRootPathImpl(
      normalizedRootPath,
      normalizedBranchName,
      {
        preferLocalOnCollision: true,
      }
    );
  });
}

/**
 * Resolves a branch selector to an exact ref.
 *
 * By default an unqualified name that matches both `refs/heads/<name>` and a
 * remote-tracking ref fails as ambiguous, which is what keeps the selectors
 * emitted by `getLocalProjectGitStateAtRootPath` round-tripping exactly.
 * `preferLocalOnCollision` relaxes that to Git's own precedence (local branch
 * wins) and belongs on the paths that consume a human-typed or pre-selector
 * name, where refusing `main` would be nothing but a dead end.
 */
function resolveLocalProjectBranchAtRootPathImpl(
  rootPath: string,
  branchName: string,
  options: {
    preferLocalOnCollision?: boolean;
  } = {}
): Effect.Effect<ResolvedLocalProjectBranch, LocalProjectError, NativeServices> {
  return Effect.gen(function* () {
    const normalizedRootPath = yield* ensureLocalProjectRootPathImpl(rootPath);
    const normalizedBranchName = branchName.trim();
    if (!normalizedBranchName) {
      return yield* Effect.fail(new LocalProjectGitError({ message: 'Branch name is required' }));
    }
    yield* assertGitRepositoryImpl(normalizedRootPath);
    const exactSelector = parseBranchSelector(normalizedBranchName);
    if (exactSelector?.kind === 'local') {
      const localRef = `refs/heads/${exactSelector.branchName}`;
      const localCommit = yield* resolveCommitAtRefImpl(normalizedRootPath, localRef);
      if (!localCommit) {
        return yield* Effect.fail(
          new LocalProjectGitError({
            message: `Local project branch not found: ${normalizedBranchName}`,
          })
        );
      }
      return {
        kind: 'local',
        branchName: exactSelector.branchName,
        refName: localRef,
        commitHash: localCommit,
      };
    }
    const remotes = yield* listGitRemotesImpl(normalizedRootPath);
    if (exactSelector?.kind === 'remote') {
      const remoteRef = `refs/remotes/${exactSelector.remoteName}/${exactSelector.branchName}`;
      const remoteCommit = remotes.includes(exactSelector.remoteName)
        ? yield* resolveCommitAtRefImpl(normalizedRootPath, remoteRef)
        : null;
      if (!remoteCommit) {
        return yield* Effect.fail(
          new LocalProjectGitError({
            message: `Local project branch not found: ${normalizedBranchName}`,
          })
        );
      }
      return {
        kind: 'remote',
        branchName: exactSelector.branchName,
        remoteName: exactSelector.remoteName,
        refName: remoteRef,
        commitHash: remoteCommit,
      };
    }
    const localRef = `refs/heads/${normalizedBranchName}`;
    const localCommit = yield* resolveCommitAtRefImpl(normalizedRootPath, localRef);
    const qualifiedRemote = findQualifiedRemoteName(remotes, normalizedBranchName);
    const remoteRefs = qualifiedRemote
      ? [`refs/remotes/${normalizedBranchName}`]
      : remotes.map((remote) => `refs/remotes/${remote}/${normalizedBranchName}`);
    const matches: Array<{
      branchName: string;
      remoteName: string;
      refName: string;
      commitHash: string;
    }> = [];
    for (const refName of remoteRefs) {
      const commitHash = yield* resolveCommitAtRefImpl(normalizedRootPath, refName);
      if (!commitHash) continue;
      const qualifiedName = refName.slice('refs/remotes/'.length);
      const remoteName = findQualifiedRemoteName(remotes, qualifiedName);
      if (!remoteName) continue;
      matches.push({
        branchName: qualifiedName.slice(remoteName.length + 1),
        remoteName,
        refName,
        commitHash,
      });
    }
    if (localCommit && (matches.length === 0 || options.preferLocalOnCollision === true)) {
      return {
        kind: 'local',
        branchName: normalizedBranchName,
        refName: localRef,
        commitHash: localCommit,
      };
    }
    if (!localCommit && matches.length === 1) {
      return {
        kind: 'remote',
        branchName: matches[0]!.branchName,
        remoteName: matches[0]!.remoteName,
        refName: matches[0]!.refName,
        commitHash: matches[0]!.commitHash,
      };
    }
    if (localCommit || matches.length > 1) {
      const matchRefs = [
        ...(localCommit ? [localRef] : []),
        ...matches.map((match) => match.refName),
      ];
      return yield* Effect.fail(
        new LocalProjectGitError({
          message: `Local project branch is ambiguous: ${normalizedBranchName}. Matches: ${matchRefs.join(', ')}`,
        })
      );
    }
    return yield* Effect.fail(
      new LocalProjectGitError({
        message: `Local project branch not found: ${normalizedBranchName}`,
      })
    );
  });
}

function resolveGitRemoteUrlImpl(
  rootPath: string,
  remoteName: string,
  direction: 'push' | 'fetch'
): Effect.Effect<string | null, LocalProjectError, NativeServices> {
  return Effect.gen(function* () {
    const args = ['remote', 'get-url'];
    if (direction === 'push') {
      args.push('--push');
    }
    args.push(remoteName);
    const result = yield* runGitCommandImpl(rootPath, args);
    yield* checkGitStatus(result, 'Failed to inspect git remote URL', [0, 2]);
    if (result.status === 2) return null;
    const url = result.stdout.trim();
    return url || null;
  });
}

function parseRemoteAsGitHubRepo(remoteUrl: string): string | null {
  try {
    const parsed = parseGitHubRepo(remoteUrl);
    return parsed ? `${parsed.owner}/${parsed.repo}` : null;
  } catch {
    return null;
  }
}
function resolveCurrentBranchRemoteImpl(
  rootPath: string,
  remotes: string[]
): Effect.Effect<string | null, LocalProjectError, NativeServices> {
  return Effect.gen(function* () {
    const currentBranchResult = yield* runGitCommandImpl(rootPath, [
      'rev-parse',
      '--abbrev-ref',
      'HEAD',
    ]);
    if (isUnbornHead(currentBranchResult)) return null;
    yield* checkGitStatus(currentBranchResult, 'Failed to inspect current git branch');
    const currentBranch = currentBranchResult.stdout.trim();
    if (!currentBranch || currentBranch === 'HEAD') {
      return null;
    }
    const remoteResult = yield* runGitCommandImpl(rootPath, [
      'config',
      `branch.${currentBranch}.remote`,
    ]);
    yield* checkGitStatus(remoteResult, 'Failed to inspect current branch remote', [0, 1]);
    if (remoteResult.status === 1) return null;
    const remoteName = remoteResult.stdout.trim();
    if (!remoteName || !remotes.includes(remoteName)) {
      return null;
    }
    return remoteName;
  });
}

function probeGitHubRemoteAtRootPathImpl(rootPath: string): Effect.Effect<
  {
    repoFullName: string;
    remoteName: string;
    remoteUrl: string;
  } | null,
  LocalProjectError,
  NativeServices
> {
  return Effect.gen(function* () {
    if (!(yield* isGitRepositoryImpl(rootPath))) {
      return null;
    }
    const remotes = yield* listGitRemotesImpl(rootPath);
    if (remotes.length === 0) return null;
    const currentBranchRemote = yield* resolveCurrentBranchRemoteImpl(rootPath, remotes);
    const prioritizedRemotes: string[] = [];
    if (currentBranchRemote && remotes.includes(currentBranchRemote)) {
      prioritizedRemotes.push(currentBranchRemote);
    }
    if (remotes.includes('origin') && currentBranchRemote !== 'origin') {
      prioritizedRemotes.push('origin');
    }
    if (prioritizedRemotes.length === 0 && remotes.length === 1) {
      prioritizedRemotes.push(remotes[0] as string);
    }
    const candidates: Array<{
      remoteName: string;
      direction: 'push' | 'fetch';
    }> = [];
    for (const remoteName of prioritizedRemotes) {
      candidates.push({ remoteName, direction: 'push' });
      candidates.push({ remoteName, direction: 'fetch' });
    }
    for (const candidate of candidates) {
      const remoteUrl = yield* resolveGitRemoteUrlImpl(
        rootPath,
        candidate.remoteName,
        candidate.direction
      );
      if (!remoteUrl) {
        continue;
      }
      const repoFullName = parseRemoteAsGitHubRepo(remoteUrl);
      if (!repoFullName) {
        continue;
      }
      return {
        repoFullName,
        remoteName: candidate.remoteName,
        remoteUrl,
      };
    }
    return null;
  });
}

function getLocalProjectGitHubRepoAtRootPathImpl(
  rootPath: string
): Effect.Effect<string | null, LocalProjectError, NativeServices> {
  return Effect.gen(function* () {
    return (
      (yield* probeGitHubRemoteAtRootPathImpl(yield* normalizeLocalProjectRootPathImpl(rootPath)))
        ?.repoFullName ?? null
    );
  });
}

function listLocalProjectBranchesAtRootPathImpl(rootPath: string): Effect.Effect<
  {
    branches: string[];
    currentBranch: string | null;
    defaultBranch: string | null;
  },
  LocalProjectError,
  NativeServices
> {
  return Effect.gen(function* () {
    yield* assertGitRepositoryImpl(rootPath);
    const remotes = yield* listGitRemotesImpl(rootPath);
    const refsResult = yield* runGitCommandImpl(rootPath, [
      'for-each-ref',
      '--format=%(refname)',
      'refs/heads',
      ...remotes.map((remote) => `refs/remotes/${remote}`),
    ]);
    if (refsResult.status !== 0) {
      const reason = refsResult.stderr.trim() || refsResult.stdout.trim() || 'unknown error';
      return yield* Effect.fail(
        new LocalProjectGitError({ message: `Failed to list git branches: ${reason}` })
      );
    }
    type BranchCandidate = {
      kind: 'local' | 'remote';
      branchName: string;
      exactRef: string;
      selector: string;
      remoteName?: string;
    };
    const remoteSet = new Set(remotes);
    const localBranchNames = new Set<string>();
    const candidates: BranchCandidate[] = [];
    const remoteRefsByBranch = new Map<
      string,
      Array<{
        remoteName: string;
        qualifiedName: string;
        exactRef: string;
      }>
    >();
    for (const line of refsResult.stdout.split('\n')) {
      const ref = line.trim();
      if (!ref) continue;
      if (ref.startsWith('refs/heads/')) {
        const localName = ref.slice('refs/heads/'.length).trim();
        if (localName) {
          localBranchNames.add(localName);
          candidates.push({
            kind: 'local',
            branchName: localName,
            exactRef: ref,
            selector: localName,
          });
        }
        continue;
      }
      if (!ref.startsWith('refs/remotes/')) continue;
      const remoteRef = ref.slice('refs/remotes/'.length).trim();
      if (!remoteRef) continue;
      const remoteName = [...remoteSet]
        .sort((a, b) => b.length - a.length)
        .find((remote) => remoteRef.startsWith(`${remote}/`));
      if (!remoteName) continue;
      const branchName = remoteRef.slice(remoteName.length + 1).trim();
      if (branchName && branchName !== 'HEAD') {
        const qualifiedName = `${remoteName}/${branchName}`;
        const refs = remoteRefsByBranch.get(branchName) ?? [];
        refs.push({ remoteName, qualifiedName, exactRef: ref });
        remoteRefsByBranch.set(branchName, refs);
      }
    }
    const currentResult = yield* runGitCommandImpl(rootPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!isUnbornHead(currentResult))
      yield* checkGitStatus(currentResult, 'Failed to inspect current git branch');
    const currentBranchRaw = currentResult.status === 0 ? currentResult.stdout.trim() : '';
    const currentBranchName =
      currentBranchRaw && currentBranchRaw !== 'HEAD' ? currentBranchRaw : null;
    if (currentBranchName && !localBranchNames.has(currentBranchName)) {
      localBranchNames.add(currentBranchName);
      candidates.push({
        kind: 'local',
        branchName: currentBranchName,
        exactRef: `refs/heads/${currentBranchName}`,
        selector: currentBranchName,
      });
    }
    let defaultBranchFromRemote: {
      branchName: string;
      remoteName: string;
    } | null = null;
    for (const remote of remotes) {
      const defaultResult = yield* runGitCommandImpl(rootPath, [
        'symbolic-ref',
        '--quiet',
        '--short',
        `refs/remotes/${remote}/HEAD`,
      ]);
      yield* checkGitStatus(defaultResult, 'Failed to inspect remote default branch', [0, 1]);
      if (defaultResult.status === 1) continue;
      const defaultBranch = parseGitRemoteDefaultBranch(defaultResult.stdout, remote);
      if (!defaultBranch) continue;
      defaultBranchFromRemote = { branchName: defaultBranch, remoteName: remote };
      break;
    }
    for (const [branchName, remoteRefs] of remoteRefsByBranch) {
      const looksQualified = remotes.some((remote) => branchName.startsWith(`${remote}/`));
      const useShortName =
        remoteRefs.length === 1 && !looksQualified && !localBranchNames.has(branchName);
      for (const remoteRef of remoteRefs) {
        candidates.push({
          kind: 'remote',
          branchName,
          remoteName: remoteRef.remoteName,
          exactRef: remoteRef.exactRef,
          selector: useShortName ? branchName : remoteRef.qualifiedName,
        });
      }
    }
    const candidatesBySelector = new Map<string, BranchCandidate[]>();
    for (const candidate of candidates) {
      const matching = candidatesBySelector.get(candidate.selector) ?? [];
      matching.push(candidate);
      candidatesBySelector.set(candidate.selector, matching);
    }
    for (const matching of candidatesBySelector.values()) {
      if (matching.length < 2) continue;
      for (const candidate of matching) {
        candidate.selector = createLocalProjectBranchSelector(candidate);
      }
    }
    // The legacy resolver searches an unqualified local name on every remote as
    // well. Emit the exact local selector when such a remote ref exists so values
    // returned by this function always round-trip through branch resolution.
    for (const candidate of candidates) {
      if (
        candidate.kind === 'local' &&
        !findQualifiedRemoteName(remotes, candidate.branchName) &&
        remoteRefsByBranch.has(candidate.branchName)
      ) {
        candidate.selector = createLocalProjectBranchSelector(candidate);
      }
    }
    const localSelector = (branchName: string): string | null =>
      candidates.find(
        (candidate) => candidate.kind === 'local' && candidate.branchName === branchName
      )?.selector ?? null;
    const remoteSelector = (remoteName: string, branchName: string): string | null =>
      candidates.find(
        (candidate) =>
          candidate.kind === 'remote' &&
          candidate.remoteName === remoteName &&
          candidate.branchName === branchName
      )?.selector ?? null;
    let defaultBranch: string | null = null;
    if (defaultBranchFromRemote) {
      const { branchName, remoteName } = defaultBranchFromRemote;
      defaultBranch = localSelector(branchName) ?? remoteSelector(remoteName, branchName);
    }
    const branches = candidates
      .map((candidate) => candidate.selector)
      .sort((a, b) => a.localeCompare(b));
    if (!defaultBranch) {
      if (localSelector('main')) {
        defaultBranch = localSelector('main');
      } else if (localSelector('master')) {
        defaultBranch = localSelector('master');
      } else {
        defaultBranch = branches[0] ?? null;
      }
    }
    return {
      branches,
      currentBranch: currentBranchName ? localSelector(currentBranchName) : null,
      defaultBranch,
    };
  });
}

function getLocalProjectWorkingTreeAtRootPathImpl(
  rootPath: string
): Effect.Effect<LocalProjectWorkingTreeState, LocalProjectError, NativeServices> {
  return Effect.gen(function* () {
    yield* assertGitRepositoryImpl(rootPath);
    const statusResult = yield* runGitCommandImpl(rootPath, [
      'status',
      '--porcelain=v1',
      '--untracked-files=normal',
    ]);
    if (statusResult.status !== 0) {
      const reason = statusResult.stderr.trim() || statusResult.stdout.trim() || 'unknown error';
      return yield* Effect.fail(
        new LocalProjectGitError({ message: `Failed to inspect git status: ${reason}` })
      );
    }
    let staged = false;
    let unstaged = false;
    let untracked = false;
    let conflicted = false;
    for (const rawLine of statusResult.stdout.split('\n')) {
      const line = rawLine.trimEnd();
      if (!line) continue;
      const x = line[0] ?? ' ';
      const y = line[1] ?? ' ';
      if (x === '?' && y === '?') {
        untracked = true;
        continue;
      }
      const isConflictedEntry =
        x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D');
      if (isConflictedEntry) {
        conflicted = true;
        continue;
      }
      if (x !== ' ') {
        staged = true;
      }
      if (y !== ' ') {
        unstaged = true;
      }
    }
    return {
      clean: !staged && !unstaged && !untracked && !conflicted,
      staged,
      unstaged,
      untracked,
      conflicted,
    };
  });
}

function getLocalProjectGitStateAtRootPathImpl(
  rootPath: string
): Effect.Effect<LocalProjectGitState, LocalProjectError, NativeServices> {
  return Effect.gen(function* () {
    const normalizedRootPath = yield* ensureLocalProjectRootPathImpl(rootPath);
    if (!(yield* isGitRepositoryImpl(normalizedRootPath))) {
      return { git: false };
    }
    const branches = yield* listLocalProjectBranchesAtRootPathImpl(normalizedRootPath);
    const githubRemote = yield* probeGitHubRemoteAtRootPathImpl(normalizedRootPath);
    const workingTree = yield* getLocalProjectWorkingTreeAtRootPathImpl(normalizedRootPath);
    return {
      git: true,
      branches: branches.branches,
      currentBranch: branches.currentBranch,
      defaultBranch: branches.defaultBranch,
      githubRepoFullName: githubRemote?.repoFullName ?? null,
      workingTree,
    };
  });
}

function getWorkingTreeBlockers(workingTree: LocalProjectWorkingTreeState): string[] {
  const blockers: string[] = [];
  if (workingTree.conflicted) blockers.push('conflicted files');
  if (workingTree.staged) blockers.push('staged changes');
  if (workingTree.unstaged) blockers.push('unstaged changes');
  if (workingTree.untracked) blockers.push('untracked files');
  return blockers;
}
function resolveTrackingLocalBranchNameImpl(
  rootPath: string,
  resolvedBranch: Extract<
    ResolvedLocalProjectBranch,
    {
      kind: 'remote';
    }
  >
): Effect.Effect<string, LocalProjectError, NativeServices> {
  return Effect.gen(function* () {
    const refsResult = yield* runGitCommandImpl(rootPath, [
      'for-each-ref',
      '--format=%(refname)',
      'refs/heads',
    ]);
    if (refsResult.status !== 0) {
      const reason = refsResult.stderr.trim() || refsResult.stdout.trim() || 'unknown error';
      return yield* Effect.fail(
        new LocalProjectGitError({ message: `Failed to inspect local git branches: ${reason}` })
      );
    }
    const localRefs = refsResult.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const isAvailable = (branchName: string): boolean => {
      const candidateRef = `refs/heads/${branchName}`;
      return localRefs.every(
        (existingRef) =>
          existingRef !== candidateRef &&
          !existingRef.startsWith(`${candidateRef}/`) &&
          !candidateRef.startsWith(`${existingRef}/`)
      );
    };
    // Git's ref plumbing accepts refs/heads/-f, but its branch-creation
    // porcelain rejects a short name that starts with an option prefix.
    if (!resolvedBranch.branchName.startsWith('-') && isAvailable(resolvedBranch.branchName)) {
      return resolvedBranch.branchName;
    }
    const stableBase = `lody-remote-${createHash('sha256')
      .update(resolvedBranch.refName)
      .digest('hex')
      .slice(0, 12)}`;
    for (let suffix = 0; suffix < 1000; suffix += 1) {
      const candidate = suffix === 0 ? stableBase : `${stableBase}-${suffix + 1}`;
      if (isAvailable(candidate)) return candidate;
    }
    return yield* Effect.fail(
      new LocalProjectGitError({
        message: `Unable to choose a local tracking branch for ${resolvedBranch.refName}`,
      })
    );
  });
}

function resolveReusableTrackingBranchNameImpl(
  rootPath: string,
  resolvedBranch: Extract<
    ResolvedLocalProjectBranch,
    {
      kind: 'remote';
    }
  >
): Effect.Effect<string | null, LocalProjectError, NativeServices> {
  return Effect.gen(function* () {
    const [currentResult, refsResult, worktreesResult] = yield* Effect.all(
      [
        runGitCommandImpl(rootPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']).pipe(
          Effect.tap((result) =>
            checkGitStatus(result, 'Failed to inspect current git branch', [0, 1])
          )
        ),
        runGitCommandImpl(rootPath, [
          'for-each-ref',
          '--format=%(refname:short)\t%(upstream)\t%(objectname)',
          'refs/heads',
        ]).pipe(
          Effect.tap((result) => checkGitStatus(result, 'Failed to inspect tracking branches'))
        ),
        runGitCommandImpl(rootPath, ['worktree', 'list', '--porcelain']).pipe(
          Effect.tap((result) => checkGitStatus(result, 'Failed to inspect git worktrees'))
        ),
      ],
      { concurrency: 'unbounded' }
    );
    const currentBranch = currentResult.status === 0 ? currentResult.stdout.trim() : '';
    const checkedOutBranches = new Set(
      worktreesResult.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('branch refs/heads/'))
        .map((line) => line.slice('branch refs/heads/'.length))
    );
    const matches = refsResult.stdout
      .split('\n')
      .map((line) => line.split('\t'))
      .filter(
        (fields): fields is [string, string, string] =>
          fields.length === 3 &&
          fields[1] === resolvedBranch.refName &&
          fields[2] === resolvedBranch.commitHash
      )
      .map(([branchName]) => branchName)
      .filter((branchName) => branchName === currentBranch || !checkedOutBranches.has(branchName));
    return matches.find((branchName) => branchName === currentBranch) ?? matches[0] ?? null;
  });
}

function checkoutLocalProjectBranchAtRootPathImpl(
  rootPath: string,
  branchName: string
): Effect.Effect<
  {
    currentBranch: string;
  },
  LocalProjectError,
  NativeServices
> {
  return Effect.gen(function* () {
    const normalizedRootPath = yield* ensureLocalProjectRootPathImpl(rootPath);
    const normalizedBranchName = branchName.trim();
    if (!normalizedBranchName) {
      return yield* Effect.fail(new LocalProjectGitError({ message: 'Branch name is required' }));
    }
    const resolvedBranch = yield* resolveLocalProjectBranchAtRootPathImpl(
      normalizedRootPath,
      normalizedBranchName
    );
    let reusableTrackingBranch: string | null = null;
    if (resolvedBranch.kind === 'remote') {
      reusableTrackingBranch = yield* resolveReusableTrackingBranchNameImpl(
        normalizedRootPath,
        resolvedBranch
      );
      const currentResult = yield* runGitCommandImpl(normalizedRootPath, [
        'symbolic-ref',
        '--quiet',
        '--short',
        'HEAD',
      ]);
      yield* checkGitStatus(currentResult, 'Failed to inspect current git branch', [0, 1]);
      if (
        reusableTrackingBranch &&
        currentResult.status === 0 &&
        currentResult.stdout.trim() === reusableTrackingBranch
      ) {
        return { currentBranch: reusableTrackingBranch };
      }
    }
    const workingTree = yield* getLocalProjectWorkingTreeAtRootPathImpl(normalizedRootPath);
    if (!workingTree.clean) {
      const blockers = getWorkingTreeBlockers(workingTree);
      return yield* Effect.fail(
        new LocalProjectGitError({
          message: `Cannot switch branches with local changes: ${blockers.join(', ')}`,
        })
      );
    }
    const trackingBranchName =
      resolvedBranch.kind === 'remote'
        ? (reusableTrackingBranch ??
          (yield* resolveTrackingLocalBranchNameImpl(normalizedRootPath, resolvedBranch)))
        : null;
    const checkoutResult = yield* runGitCommandImpl(
      normalizedRootPath,
      reusableTrackingBranch
        ? ['switch', '--no-guess', '--', reusableTrackingBranch]
        : trackingBranchName
          ? ['checkout', '--track', '-b', trackingBranchName, resolvedBranch.refName]
          : ['switch', '--no-guess', '--', resolvedBranch.branchName],
      {
        timeoutMs: GIT_CHECKOUT_TIMEOUT_MS,
      }
    );
    if (checkoutResult.status !== 0) {
      const reason =
        checkoutResult.stderr.trim() || checkoutResult.stdout.trim() || 'unknown error';
      return yield* Effect.fail(
        new LocalProjectGitError({ message: `Failed to checkout git branch: ${reason}` })
      );
    }
    const currentResult = yield* runGitCommandImpl(normalizedRootPath, [
      'symbolic-ref',
      '--quiet',
      'HEAD',
    ]);
    if (currentResult.status !== 0) {
      const reason = currentResult.stderr.trim() || currentResult.stdout.trim() || 'unknown error';
      return yield* Effect.fail(
        new LocalProjectGitError({
          message: `Failed to resolve current git branch after checkout: ${reason}`,
        })
      );
    }
    const currentRef = currentResult.stdout.trim();
    const currentBranch = currentRef.startsWith('refs/heads/')
      ? currentRef.slice('refs/heads/'.length)
      : '';
    if (!currentBranch) {
      return yield* Effect.fail(
        new LocalProjectGitError({ message: 'Current git branch is detached after checkout' })
      );
    }
    return { currentBranch };
  });
}

const kernel = {
  normalizeLocalProjectRootPath: normalizeLocalProjectRootPathImpl,
  ensureLocalProjectRootPath: ensureLocalProjectRootPathImpl,
  createLocalProjectId: createLocalProjectIdImpl,
  resolveLocalProjectBranchRefAtRootPath: resolveLocalProjectBranchRefAtRootPathImpl,
  parseLocalProjectBranchRefAtRootPath: parseLocalProjectBranchRefAtRootPathImpl,
  getLocalProjectBranchUpstreamRefAtRootPath: getLocalProjectBranchUpstreamRefAtRootPathImpl,
  getLocalProjectCurrentBranchNameAtRootPath: getLocalProjectCurrentBranchNameAtRootPathImpl,
  resolveLocalProjectLegacyBaseBranchAtRootPath: resolveLocalProjectLegacyBaseBranchAtRootPathImpl,
  resolveLocalProjectBranchAtRootPath: resolveLocalProjectBranchAtRootPathImpl,
  getLocalProjectGitHubRepoAtRootPath: getLocalProjectGitHubRepoAtRootPathImpl,
  getLocalProjectWorkingTreeAtRootPath: getLocalProjectWorkingTreeAtRootPathImpl,
  getLocalProjectGitStateAtRootPath: getLocalProjectGitStateAtRootPathImpl,
  checkoutLocalProjectBranchAtRootPath: checkoutLocalProjectBranchAtRootPathImpl,
};
type LocalProjectApi = {
  [K in keyof typeof kernel]: (
    ...args: Parameters<(typeof kernel)[K]>
  ) => Effect.Effect<Effect.Success<ReturnType<(typeof kernel)[K]>>, LocalProjectError>;
};
export class LocalProjects extends Context.Service<LocalProjects, LocalProjectApi>()(
  'lody/LocalProjects'
) {}

export const LocalProjectsLive = Layer.effect(
  LocalProjects,
  Effect.gen(function* () {
    const paths = yield* LocalProjectPaths;
    const host = yield* LocalProjectHost;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const provide = <A, E>(program: Effect.Effect<A, E, NativeServices>): Effect.Effect<A, E> =>
      program.pipe(
        Effect.provideService(LocalProjectPaths, paths),
        Effect.provideService(LocalProjectHost, host),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
      );
    return LocalProjects.of({
      normalizeLocalProjectRootPath: (...args) =>
        provide(normalizeLocalProjectRootPathImpl(...args)),
      ensureLocalProjectRootPath: (...args) => provide(ensureLocalProjectRootPathImpl(...args)),
      createLocalProjectId: (...args) => provide(createLocalProjectIdImpl(...args)),
      resolveLocalProjectBranchRefAtRootPath: (...args) =>
        provide(resolveLocalProjectBranchRefAtRootPathImpl(...args)),
      parseLocalProjectBranchRefAtRootPath: (...args) =>
        provide(parseLocalProjectBranchRefAtRootPathImpl(...args)),
      getLocalProjectBranchUpstreamRefAtRootPath: (...args) =>
        provide(getLocalProjectBranchUpstreamRefAtRootPathImpl(...args)),
      getLocalProjectCurrentBranchNameAtRootPath: (...args) =>
        provide(getLocalProjectCurrentBranchNameAtRootPathImpl(...args)),
      resolveLocalProjectLegacyBaseBranchAtRootPath: (...args) =>
        provide(resolveLocalProjectLegacyBaseBranchAtRootPathImpl(...args)),
      resolveLocalProjectBranchAtRootPath: (...args) =>
        provide(resolveLocalProjectBranchAtRootPathImpl(...args)),
      getLocalProjectGitHubRepoAtRootPath: (...args) =>
        provide(getLocalProjectGitHubRepoAtRootPathImpl(...args)),
      getLocalProjectWorkingTreeAtRootPath: (...args) =>
        provide(getLocalProjectWorkingTreeAtRootPathImpl(...args)),
      getLocalProjectGitStateAtRootPath: (...args) =>
        provide(getLocalProjectGitStateAtRootPathImpl(...args)),
      checkoutLocalProjectBranchAtRootPath: (...args) =>
        provide(checkoutLocalProjectBranchAtRootPathImpl(...args)),
    });
  })
);
/** Passive composition; application/Legacy entrypoints execute the program. */
export const localProjectLayer = LocalProjectsLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      LocalProjectPathsLive.pipe(Layer.provide(NodeFileSystem.layer)),
      processLayer({}),
      Layer.succeed(LocalProjectHost, { env: Effect.sync(() => ({ ...process.env })) })
    )
  )
);
export const normalizeLocalProjectRootPath = (
  ...args: Parameters<typeof normalizeLocalProjectRootPathImpl>
) => Effect.flatMap(LocalProjects, (projects) => projects.normalizeLocalProjectRootPath(...args));
export const ensureLocalProjectRootPath = (
  ...args: Parameters<typeof ensureLocalProjectRootPathImpl>
) => Effect.flatMap(LocalProjects, (projects) => projects.ensureLocalProjectRootPath(...args));
export const createLocalProjectId = (...args: Parameters<typeof createLocalProjectIdImpl>) =>
  Effect.flatMap(LocalProjects, (projects) => projects.createLocalProjectId(...args));
export const resolveLocalProjectBranchRefAtRootPath = (
  ...args: Parameters<typeof resolveLocalProjectBranchRefAtRootPathImpl>
) =>
  Effect.flatMap(LocalProjects, (projects) =>
    projects.resolveLocalProjectBranchRefAtRootPath(...args)
  );
export const parseLocalProjectBranchRefAtRootPath = (
  ...args: Parameters<typeof parseLocalProjectBranchRefAtRootPathImpl>
) =>
  Effect.flatMap(LocalProjects, (projects) =>
    projects.parseLocalProjectBranchRefAtRootPath(...args)
  );
export const getLocalProjectBranchUpstreamRefAtRootPath = (
  ...args: Parameters<typeof getLocalProjectBranchUpstreamRefAtRootPathImpl>
) =>
  Effect.flatMap(LocalProjects, (projects) =>
    projects.getLocalProjectBranchUpstreamRefAtRootPath(...args)
  );
export const getLocalProjectCurrentBranchNameAtRootPath = (
  ...args: Parameters<typeof getLocalProjectCurrentBranchNameAtRootPathImpl>
) =>
  Effect.flatMap(LocalProjects, (projects) =>
    projects.getLocalProjectCurrentBranchNameAtRootPath(...args)
  );
export const resolveLocalProjectLegacyBaseBranchAtRootPath = (
  ...args: Parameters<typeof resolveLocalProjectLegacyBaseBranchAtRootPathImpl>
) =>
  Effect.flatMap(LocalProjects, (projects) =>
    projects.resolveLocalProjectLegacyBaseBranchAtRootPath(...args)
  );
export const resolveLocalProjectBranchAtRootPath = (
  ...args: Parameters<typeof resolveLocalProjectBranchAtRootPathImpl>
) =>
  Effect.flatMap(LocalProjects, (projects) =>
    projects.resolveLocalProjectBranchAtRootPath(...args)
  );
export const getLocalProjectGitHubRepoAtRootPath = (
  ...args: Parameters<typeof getLocalProjectGitHubRepoAtRootPathImpl>
) =>
  Effect.flatMap(LocalProjects, (projects) =>
    projects.getLocalProjectGitHubRepoAtRootPath(...args)
  );
export const getLocalProjectWorkingTreeAtRootPath = (
  ...args: Parameters<typeof getLocalProjectWorkingTreeAtRootPathImpl>
) =>
  Effect.flatMap(LocalProjects, (projects) =>
    projects.getLocalProjectWorkingTreeAtRootPath(...args)
  );
export const getLocalProjectGitStateAtRootPath = (
  ...args: Parameters<typeof getLocalProjectGitStateAtRootPathImpl>
) =>
  Effect.flatMap(LocalProjects, (projects) => projects.getLocalProjectGitStateAtRootPath(...args));
export const checkoutLocalProjectBranchAtRootPath = (
  ...args: Parameters<typeof checkoutLocalProjectBranchAtRootPathImpl>
) =>
  Effect.flatMap(LocalProjects, (projects) =>
    projects.checkoutLocalProjectBranchAtRootPath(...args)
  );

// ---- single compatibility boundary -------------------------------------
const legacyRuntime = ManagedRuntime.make(localProjectLayer);
const runLocalProjectPromiseLegacy = <A, E>(
  program: Effect.Effect<A, E, LocalProjects>,
  options?: Effect.RunOptions
): Promise<A> =>
  legacyRuntime.runPromiseExit(program, options).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value;
    throw squashProcessFailure(exit.cause);
  });
// Synchronous consumers use the same path/identity kernel, with blocking I/O
// supplied explicitly here. Blocking operations are not automatically interruptible.
const synchronousPathsLegacy = LocalProjectPaths.of({
  realPath: (input) =>
    Effect.try({
      try: () => fs.realpathSync.native(input),
      catch: (cause) =>
        new LocalProjectGitError({
          message: `Failed to resolve local project path: ${input}`,
          cause,
        }),
    }).pipe(
      Effect.catch((error) => {
        const code = (error.cause as NodeJS.ErrnoException)?.code;
        return code === 'ENOENT' || code === 'ENOTDIR' ? Effect.succeed(input) : Effect.fail(error);
      })
    ),
  isDirectory: (input) =>
    Effect.try({
      try: () => fs.statSync(input).isDirectory(),
      catch: (cause) =>
        new LocalProjectGitError({ message: 'Selected path is not a directory', cause }),
    }),
});
const runLocalProjectSyncLegacy = <A, E>(program: Effect.Effect<A, E, LocalProjectPaths>): A => {
  const exit = Effect.runSyncExit(
    program.pipe(Effect.provideService(LocalProjectPaths, synchronousPathsLegacy))
  );
  if (Exit.isSuccess(exit)) return exit.value;
  throw squashProcessFailure(exit.cause);
};
/** @deprecated Unmigrated Promise/synchronous callers only. Remove after their application runtime supplies LocalProjects. */
export const localProjectsLegacy = {
  runPromise: runLocalProjectPromiseLegacy,
  normalizeLocalProjectRootPath: (input: string) =>
    runLocalProjectSyncLegacy(normalizeLocalProjectRootPathImpl(input)),
  ensureLocalProjectRootPath: (input: string) =>
    runLocalProjectSyncLegacy(ensureLocalProjectRootPathImpl(input)),
  createLocalProjectId: (input: string) =>
    runLocalProjectSyncLegacy(createLocalProjectIdImpl(input)),
  resolveLocalProjectBranchRefAtRootPath: (
    ...args: Parameters<typeof resolveLocalProjectBranchRefAtRootPathImpl>
  ) => runLocalProjectPromiseLegacy(resolveLocalProjectBranchRefAtRootPath(...args)),
  parseLocalProjectBranchRefAtRootPath: (
    ...args: Parameters<typeof parseLocalProjectBranchRefAtRootPathImpl>
  ) => runLocalProjectPromiseLegacy(parseLocalProjectBranchRefAtRootPath(...args)),
  getLocalProjectBranchUpstreamRefAtRootPath: (
    ...args: Parameters<typeof getLocalProjectBranchUpstreamRefAtRootPathImpl>
  ) => runLocalProjectPromiseLegacy(getLocalProjectBranchUpstreamRefAtRootPath(...args)),
  getLocalProjectCurrentBranchNameAtRootPath: (
    ...args: Parameters<typeof getLocalProjectCurrentBranchNameAtRootPathImpl>
  ) => runLocalProjectPromiseLegacy(getLocalProjectCurrentBranchNameAtRootPath(...args)),
  resolveLocalProjectLegacyBaseBranchAtRootPath: (
    ...args: Parameters<typeof resolveLocalProjectLegacyBaseBranchAtRootPathImpl>
  ) => runLocalProjectPromiseLegacy(resolveLocalProjectLegacyBaseBranchAtRootPath(...args)),
  resolveLocalProjectBranchAtRootPath: (
    ...args: Parameters<typeof resolveLocalProjectBranchAtRootPathImpl>
  ) => runLocalProjectPromiseLegacy(resolveLocalProjectBranchAtRootPath(...args)),
  getLocalProjectGitHubRepoAtRootPath: (
    ...args: Parameters<typeof getLocalProjectGitHubRepoAtRootPathImpl>
  ) => runLocalProjectPromiseLegacy(getLocalProjectGitHubRepoAtRootPath(...args)),
  getLocalProjectWorkingTreeAtRootPath: (
    ...args: Parameters<typeof getLocalProjectWorkingTreeAtRootPathImpl>
  ) => runLocalProjectPromiseLegacy(getLocalProjectWorkingTreeAtRootPath(...args)),
  getLocalProjectGitStateAtRootPath: (
    ...args: Parameters<typeof getLocalProjectGitStateAtRootPathImpl>
  ) => runLocalProjectPromiseLegacy(getLocalProjectGitStateAtRootPath(...args)),
  checkoutLocalProjectBranchAtRootPath: (
    ...args: Parameters<typeof checkoutLocalProjectBranchAtRootPathImpl>
  ) => runLocalProjectPromiseLegacy(checkoutLocalProjectBranchAtRootPath(...args)),
};
