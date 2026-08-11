import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  LocalProjectGitState,
  LocalProjectId,
  LocalProjectWorkingTreeState,
} from '../project';
import { parseGitHubRepo } from '../worktree-paths';

const execFileAsync = promisify(execFile);

type GitCommandResult = {
  status: number | null;
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

function tryRealpath(inputPath: string): string {
  try {
    if (typeof fs.realpathSync.native === 'function') {
      return fs.realpathSync.native(inputPath);
    }
    return fs.realpathSync(inputPath);
  } catch {
    return inputPath;
  }
}

export function normalizeLocalProjectRootPath(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  const real = tryRealpath(resolved);
  const normalized = path.normalize(real);
  const root = path.parse(normalized).root;
  if (root && normalized === root) {
    return root;
  }
  return normalized.replace(/[\\/]+$/, '');
}

export function ensureLocalProjectRootPath(inputPath: string): string {
  const normalizedRootPath = normalizeLocalProjectRootPath(inputPath.trim());
  let stat: fs.Stats;
  try {
    stat = fs.statSync(normalizedRootPath);
  } catch {
    throw new Error('Selected path is not a directory');
  }
  if (!stat.isDirectory()) {
    throw new Error('Selected path is not a directory');
  }
  return normalizedRootPath;
}

export function getLocalProjectNameFromRootPath(rootPath: string): string {
  const base = path.basename(rootPath);
  return base || rootPath;
}

export function createLocalProjectId(rootPath: string): LocalProjectId {
  const normalizedRootPath = normalizeLocalProjectRootPath(rootPath);
  const hash = createHash('sha256').update(normalizedRootPath).digest('hex').slice(0, 24);
  return `local-project-${hash}` as LocalProjectId;
}

async function runGitCommand(
  rootPath: string,
  args: string[],
  options: GitCommandOptions = {}
): Promise<GitCommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_COMMAND_TIMEOUT_MS;
  try {
    const result = await execFileAsync('git', args, {
      cwd: rootPath,
      encoding: 'utf-8',
      timeout: timeoutMs,
      killSignal: 'SIGTERM',
      maxBuffer: GIT_COMMAND_MAX_BUFFER_BYTES,
      // The daemon runs without a console on Windows; without this each of
      // the ~8 git calls per git-state refresh pops a visible console window.
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
      },
    });
    const commandResult = {
      status: 0,
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
    };
    return commandResult;
  } catch (error) {
    const withOutput = error as
      | (Error & { code?: number | string; signal?: string; stdout?: string; stderr?: string })
      | undefined;
    const message =
      error instanceof Error
        ? error.message || `Git command failed after ${timeoutMs}ms: git ${args.join(' ')}`
        : String(error);
    return {
      status: typeof withOutput?.code === 'number' ? withOutput.code : null,
      stdout: String(withOutput?.stdout ?? ''),
      stderr: String(withOutput?.stderr ?? message),
    };
  }
}

async function isGitRepository(rootPath: string): Promise<boolean> {
  // Git inherits repository context from parent directories. A registered local
  // project is Git-capable only when its own root is the worktree root.
  const probe = await runGitCommand(rootPath, ['rev-parse', '--show-toplevel']);
  const repositoryRoot = probe.stdout.trim();
  return (
    probe.status === 0 &&
    repositoryRoot !== '' &&
    normalizeLocalProjectRootPath(repositoryRoot) === normalizeLocalProjectRootPath(rootPath)
  );
}

async function assertGitRepository(rootPath: string): Promise<void> {
  if (!(await isGitRepository(rootPath))) {
    throw new Error('Local project is not a git repository');
  }
}

function parseGitRemoteDefaultBranch(raw: string, remoteName: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const prefix = `${remoteName}/`;
  if (!trimmed.startsWith(prefix)) return null;
  const name = trimmed.slice(prefix.length).trim();
  return name || null;
}

async function listGitRemotes(rootPath: string): Promise<string[]> {
  const remoteResult = await runGitCommand(rootPath, ['remote']);
  if (remoteResult.status !== 0) return [];
  return remoteResult.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

async function resolveCommitAtRef(rootPath: string, refName: string): Promise<string | null> {
  // `rev-parse --verify` accepts revision expressions such as `foo~0`; branch
  // selectors must resolve one exact ref so a failed lookup cannot mutate the
  // registered repository before reporting branch-not-found.
  const result = await runGitCommand(rootPath, ['show-ref', '--verify', '--hash', refName]);
  if (result.status !== 0) return null;
  const commitHash = result.stdout.trim();
  return commitHash || null;
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

export async function resolveLocalProjectBranchRefAtRootPath(
  rootPath: string,
  refName: string
): Promise<ResolvedLocalProjectBranch> {
  const parsedRef = await parseLocalProjectBranchRefAtRootPath(rootPath, refName);
  const commitHash = await resolveCommitAtRef(rootPath, parsedRef.refName);
  if (!commitHash) {
    throw new Error(`Local project branch ref not found: ${parsedRef.refName}`);
  }
  return { ...parsedRef, commitHash };
}

export async function parseLocalProjectBranchRefAtRootPath(
  rootPath: string,
  refName: string
): Promise<ParsedLocalProjectBranchRef> {
  const normalizedRootPath = ensureLocalProjectRootPath(rootPath);
  const normalizedRefName = refName.trim();
  await assertGitRepository(normalizedRootPath);

  const formatResult = await runGitCommand(normalizedRootPath, [
    'check-ref-format',
    normalizedRefName,
  ]);
  if (formatResult.status !== 0) {
    throw new Error(`Local project branch ref not found: ${normalizedRefName}`);
  }

  if (normalizedRefName.startsWith('refs/heads/')) {
    const branchName = normalizedRefName.slice('refs/heads/'.length);
    if (!branchName) {
      throw new Error(`Local project branch ref not found: ${normalizedRefName}`);
    }
    return { kind: 'local', branchName, refName: normalizedRefName };
  }

  if (normalizedRefName.startsWith('refs/remotes/')) {
    const qualifiedName = normalizedRefName.slice('refs/remotes/'.length);
    const remoteName = findQualifiedRemoteName(
      await listGitRemotes(normalizedRootPath),
      qualifiedName
    );
    const branchName = remoteName ? qualifiedName.slice(remoteName.length + 1) : '';
    if (!remoteName || !branchName) {
      throw new Error(`Local project branch ref not found: ${normalizedRefName}`);
    }
    return {
      kind: 'remote',
      branchName,
      remoteName,
      refName: normalizedRefName,
    };
  }

  throw new Error(`Local project branch ref not found: ${normalizedRefName}`);
}

export async function getLocalProjectBranchUpstreamRefAtRootPath(
  rootPath: string,
  branchName: string
): Promise<string | null> {
  const normalizedRootPath = ensureLocalProjectRootPath(rootPath);
  const normalizedBranchName = branchName.trim();
  if (!normalizedBranchName) return null;
  await assertGitRepository(normalizedRootPath);

  const result = await runGitCommand(normalizedRootPath, [
    'for-each-ref',
    '--format=%(upstream)',
    `refs/heads/${normalizedBranchName}`,
  ]);
  if (result.status !== 0) return null;
  const upstreamRef = result.stdout.trim();
  return upstreamRef.startsWith('refs/remotes/') ? upstreamRef : null;
}

export async function getLocalProjectCurrentBranchNameAtRootPath(
  rootPath: string
): Promise<string | null> {
  const normalizedRootPath = ensureLocalProjectRootPath(rootPath);
  await assertGitRepository(normalizedRootPath);
  const result = await runGitCommand(normalizedRootPath, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'HEAD',
  ]);
  const branchName = result.status === 0 ? result.stdout.trim() : '';
  return branchName || null;
}

export async function resolveLocalProjectLegacyBaseBranchAtRootPath(
  rootPath: string,
  branchName: string,
  options: { useWorktree?: boolean } = {}
): Promise<ResolvedLocalProjectBranch> {
  const normalizedRootPath = ensureLocalProjectRootPath(rootPath);
  const normalizedBranchName = branchName.trim();
  if (!normalizedBranchName) {
    throw new Error('Branch name is required');
  }

  // Old sessions stored the selector in baseBranch. In checkout mode a
  // remote-only selector may since have created a same-named local tracking
  // branch, so recover its exact upstream before ordinary selector precedence
  // can mistake the work branch for the review base. Worktree mode never checks
  // the base out in the project root, so a same-named local branch there is the
  // user's own branch and must be preserved as-is.
  if (options.useWorktree !== true && !parseBranchSelector(normalizedBranchName)) {
    await assertGitRepository(normalizedRootPath);
    const localRef = `refs/heads/${normalizedBranchName}`;
    if (await resolveCommitAtRef(normalizedRootPath, localRef)) {
      const upstream = await runGitCommand(normalizedRootPath, [
        'for-each-ref',
        '--format=%(upstream)',
        localRef,
      ]);
      const upstreamRef = upstream.status === 0 ? upstream.stdout.trim() : '';
      if (upstreamRef.startsWith('refs/remotes/')) {
        return await resolveLocalProjectBranchRefAtRootPath(normalizedRootPath, upstreamRef);
      }
    }
  }

  // A legacy value was handed straight to `git checkout` / `git worktree add`,
  // which resolve a bare name local-first. Keep that precedence: `master` in a
  // repository that also has `origin/master` meant refs/heads/master, and
  // failing it as ambiguous strands every session created before selectors.
  return await resolveLocalProjectBranchAtRootPath(normalizedRootPath, normalizedBranchName, {
    preferLocalOnCollision: true,
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
export async function resolveLocalProjectBranchAtRootPath(
  rootPath: string,
  branchName: string,
  options: { preferLocalOnCollision?: boolean } = {}
): Promise<ResolvedLocalProjectBranch> {
  const normalizedRootPath = ensureLocalProjectRootPath(rootPath);
  const normalizedBranchName = branchName.trim();
  if (!normalizedBranchName) {
    throw new Error('Branch name is required');
  }
  await assertGitRepository(normalizedRootPath);

  const exactSelector = parseBranchSelector(normalizedBranchName);
  if (exactSelector?.kind === 'local') {
    const localRef = `refs/heads/${exactSelector.branchName}`;
    const localCommit = await resolveCommitAtRef(normalizedRootPath, localRef);
    if (!localCommit) {
      throw new Error(`Local project branch not found: ${normalizedBranchName}`);
    }
    return {
      kind: 'local',
      branchName: exactSelector.branchName,
      refName: localRef,
      commitHash: localCommit,
    };
  }

  const remotes = await listGitRemotes(normalizedRootPath);
  if (exactSelector?.kind === 'remote') {
    const remoteRef = `refs/remotes/${exactSelector.remoteName}/${exactSelector.branchName}`;
    const remoteCommit = remotes.includes(exactSelector.remoteName)
      ? await resolveCommitAtRef(normalizedRootPath, remoteRef)
      : null;
    if (!remoteCommit) {
      throw new Error(`Local project branch not found: ${normalizedBranchName}`);
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
  const localCommit = await resolveCommitAtRef(normalizedRootPath, localRef);
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
    const commitHash = await resolveCommitAtRef(normalizedRootPath, refName);
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
    throw new Error(
      `Local project branch is ambiguous: ${normalizedBranchName}. Matches: ${matchRefs.join(', ')}`
    );
  }
  throw new Error(`Local project branch not found: ${normalizedBranchName}`);
}

async function resolveGitRemoteUrl(
  rootPath: string,
  remoteName: string,
  direction: 'push' | 'fetch'
): Promise<string | null> {
  const args = ['remote', 'get-url'];
  if (direction === 'push') {
    args.push('--push');
  }
  args.push(remoteName);

  const result = await runGitCommand(rootPath, args);
  if (result.status !== 0) return null;
  const url = result.stdout.trim();
  return url || null;
}

function parseRemoteAsGitHubRepo(remoteUrl: string): string | null {
  try {
    const parsed = parseGitHubRepo(remoteUrl);
    return parsed ? `${parsed.owner}/${parsed.repo}` : null;
  } catch {
    return null;
  }
}

async function resolveCurrentBranchRemote(
  rootPath: string,
  remotes: string[]
): Promise<string | null> {
  const currentBranchResult = await runGitCommand(rootPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (currentBranchResult.status !== 0) {
    return null;
  }
  const currentBranch = currentBranchResult.stdout.trim();
  if (!currentBranch || currentBranch === 'HEAD') {
    return null;
  }

  const remoteResult = await runGitCommand(rootPath, ['config', `branch.${currentBranch}.remote`]);
  if (remoteResult.status !== 0) {
    return null;
  }
  const remoteName = remoteResult.stdout.trim();
  if (!remoteName || !remotes.includes(remoteName)) {
    return null;
  }
  return remoteName;
}

async function probeGitHubRemoteAtRootPath(rootPath: string): Promise<{
  repoFullName: string;
  remoteName: string;
  remoteUrl: string;
} | null> {
  if (!(await isGitRepository(rootPath))) {
    return null;
  }

  const remotes = await listGitRemotes(rootPath);
  if (remotes.length === 0) return null;

  const currentBranchRemote = await resolveCurrentBranchRemote(rootPath, remotes);
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

  const candidates: Array<{ remoteName: string; direction: 'push' | 'fetch' }> = [];
  for (const remoteName of prioritizedRemotes) {
    candidates.push({ remoteName, direction: 'push' });
    candidates.push({ remoteName, direction: 'fetch' });
  }

  for (const candidate of candidates) {
    const remoteUrl = await resolveGitRemoteUrl(
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
}

async function listLocalProjectBranchesAtRootPath(rootPath: string): Promise<{
  branches: string[];
  currentBranch: string | null;
  defaultBranch: string | null;
}> {
  await assertGitRepository(rootPath);
  const remotes = await listGitRemotes(rootPath);
  const refsResult = await runGitCommand(rootPath, [
    'for-each-ref',
    '--format=%(refname)',
    'refs/heads',
    ...remotes.map((remote) => `refs/remotes/${remote}`),
  ]);
  if (refsResult.status !== 0) {
    const reason = refsResult.stderr.trim() || refsResult.stdout.trim() || 'unknown error';
    throw new Error(`Failed to list git branches: ${reason}`);
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
    Array<{ remoteName: string; qualifiedName: string; exactRef: string }>
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

  const currentResult = await runGitCommand(rootPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
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

  let defaultBranchFromRemote: { branchName: string; remoteName: string } | null = null;
  for (const remote of remotes) {
    const defaultResult = await runGitCommand(rootPath, [
      'symbolic-ref',
      '--quiet',
      '--short',
      `refs/remotes/${remote}/HEAD`,
    ]);
    if (defaultResult.status !== 0) continue;

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
}

export async function getLocalProjectWorkingTreeAtRootPath(
  rootPath: string
): Promise<LocalProjectWorkingTreeState> {
  await assertGitRepository(rootPath);

  const statusResult = await runGitCommand(rootPath, [
    'status',
    '--porcelain=v1',
    '--untracked-files=normal',
  ]);
  if (statusResult.status !== 0) {
    const reason = statusResult.stderr.trim() || statusResult.stdout.trim() || 'unknown error';
    throw new Error(`Failed to inspect git status: ${reason}`);
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
}

export async function getLocalProjectGitStateAtRootPath(
  rootPath: string
): Promise<LocalProjectGitState> {
  const normalizedRootPath = ensureLocalProjectRootPath(rootPath);
  if (!(await isGitRepository(normalizedRootPath))) {
    return { git: false };
  }

  const branches = await listLocalProjectBranchesAtRootPath(normalizedRootPath);
  const githubRemote = await probeGitHubRemoteAtRootPath(normalizedRootPath);
  const workingTree = await getLocalProjectWorkingTreeAtRootPath(normalizedRootPath);
  return {
    git: true,
    branches: branches.branches,
    currentBranch: branches.currentBranch,
    defaultBranch: branches.defaultBranch,
    githubRepoFullName: githubRemote?.repoFullName ?? null,
    workingTree,
  };
}

function getWorkingTreeBlockers(workingTree: LocalProjectWorkingTreeState): string[] {
  const blockers: string[] = [];
  if (workingTree.conflicted) blockers.push('conflicted files');
  if (workingTree.staged) blockers.push('staged changes');
  if (workingTree.unstaged) blockers.push('unstaged changes');
  if (workingTree.untracked) blockers.push('untracked files');
  return blockers;
}

async function resolveTrackingLocalBranchName(
  rootPath: string,
  resolvedBranch: Extract<ResolvedLocalProjectBranch, { kind: 'remote' }>
): Promise<string> {
  const refsResult = await runGitCommand(rootPath, [
    'for-each-ref',
    '--format=%(refname)',
    'refs/heads',
  ]);
  if (refsResult.status !== 0) {
    const reason = refsResult.stderr.trim() || refsResult.stdout.trim() || 'unknown error';
    throw new Error(`Failed to inspect local git branches: ${reason}`);
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
  for (let suffix = 0; suffix < 1_000; suffix += 1) {
    const candidate = suffix === 0 ? stableBase : `${stableBase}-${suffix + 1}`;
    if (isAvailable(candidate)) return candidate;
  }
  throw new Error(`Unable to choose a local tracking branch for ${resolvedBranch.refName}`);
}

async function resolveReusableTrackingBranchName(
  rootPath: string,
  resolvedBranch: Extract<ResolvedLocalProjectBranch, { kind: 'remote' }>
): Promise<string | null> {
  const [currentResult, refsResult, worktreesResult] = await Promise.all([
    runGitCommand(rootPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    runGitCommand(rootPath, [
      'for-each-ref',
      '--format=%(refname:short)\t%(upstream)\t%(objectname)',
      'refs/heads',
    ]),
    runGitCommand(rootPath, ['worktree', 'list', '--porcelain']),
  ]);
  if (refsResult.status !== 0 || worktreesResult.status !== 0) return null;
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
}

export async function checkoutLocalProjectBranchAtRootPath(
  rootPath: string,
  branchName: string
): Promise<{ currentBranch: string }> {
  const normalizedRootPath = ensureLocalProjectRootPath(rootPath);
  const normalizedBranchName = branchName.trim();
  if (!normalizedBranchName) {
    throw new Error('Branch name is required');
  }

  const resolvedBranch = await resolveLocalProjectBranchAtRootPath(
    normalizedRootPath,
    normalizedBranchName
  );

  let reusableTrackingBranch: string | null = null;
  if (resolvedBranch.kind === 'remote') {
    reusableTrackingBranch = await resolveReusableTrackingBranchName(
      normalizedRootPath,
      resolvedBranch
    );
    const currentResult = await runGitCommand(normalizedRootPath, [
      'symbolic-ref',
      '--quiet',
      '--short',
      'HEAD',
    ]);
    if (reusableTrackingBranch && currentResult.stdout.trim() === reusableTrackingBranch) {
      return { currentBranch: reusableTrackingBranch };
    }
  }

  const workingTree = await getLocalProjectWorkingTreeAtRootPath(normalizedRootPath);
  if (!workingTree.clean) {
    const blockers = getWorkingTreeBlockers(workingTree);
    throw new Error(`Cannot switch branches with local changes: ${blockers.join(', ')}`);
  }

  const trackingBranchName =
    resolvedBranch.kind === 'remote'
      ? (reusableTrackingBranch ??
        (await resolveTrackingLocalBranchName(normalizedRootPath, resolvedBranch)))
      : null;
  const checkoutResult = await runGitCommand(
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
    const reason = checkoutResult.stderr.trim() || checkoutResult.stdout.trim() || 'unknown error';
    throw new Error(`Failed to checkout git branch: ${reason}`);
  }

  const currentResult = await runGitCommand(normalizedRootPath, [
    'symbolic-ref',
    '--quiet',
    'HEAD',
  ]);
  if (currentResult.status !== 0) {
    const reason = currentResult.stderr.trim() || currentResult.stdout.trim() || 'unknown error';
    throw new Error(`Failed to resolve current git branch after checkout: ${reason}`);
  }

  const currentRef = currentResult.stdout.trim();
  const currentBranch = currentRef.startsWith('refs/heads/')
    ? currentRef.slice('refs/heads/'.length)
    : '';
  if (!currentBranch) {
    throw new Error('Current git branch is detached after checkout');
  }

  return { currentBranch };
}
