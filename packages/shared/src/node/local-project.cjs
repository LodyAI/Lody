const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { parseGitHubRepo } = require('./worktree-paths.cjs');

const execFileAsync = promisify(execFile);

// Read-only probes need a tight budget: a single git-state RPC issues ~8
// sequential `git` calls, all under one 30 s RPC timeout. A 10 s ceiling on
// the first command alone would burn the whole budget on a stalled filesystem
// or fsmonitor hook with nothing left for the remaining probes.
const DEFAULT_GIT_COMMAND_TIMEOUT_MS = 5000;
const GIT_CHECKOUT_TIMEOUT_MS = 30000;
const GIT_COMMAND_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

function tryRealpath(inputPath) {
  try {
    if (typeof fs.realpathSync.native === 'function') {
      return fs.realpathSync.native(inputPath);
    }
    return fs.realpathSync(inputPath);
  } catch {
    return inputPath;
  }
}

function normalizeLocalProjectRootPath(inputPath) {
  const resolved = path.resolve(inputPath);
  const real = tryRealpath(resolved);
  const normalized = path.normalize(real);
  const root = path.parse(normalized).root;
  if (root && normalized === root) {
    return root;
  }
  return normalized.replace(/[\\/]+$/, '');
}

function ensureLocalProjectRootPath(inputPath) {
  const normalizedRootPath = normalizeLocalProjectRootPath(inputPath.trim());
  let stat;
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

function getLocalProjectNameFromRootPath(rootPath) {
  const base = path.basename(rootPath);
  return base || rootPath;
}

function createLocalProjectId(rootPath) {
  const normalizedRootPath = normalizeLocalProjectRootPath(rootPath);
  const hash = createHash('sha256').update(normalizedRootPath).digest('hex').slice(0, 24);
  return `local-project-${hash}`;
}

async function runGitCommand(rootPath, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_COMMAND_TIMEOUT_MS;
  try {
    const result = await execFileAsync('git', args, {
      cwd: rootPath,
      encoding: 'utf-8',
      timeout: timeoutMs,
      killSignal: 'SIGTERM',
      maxBuffer: GIT_COMMAND_MAX_BUFFER_BYTES,
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
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: typeof error?.code === 'number' ? error.code : null,
      stdout: String(error?.stdout ?? ''),
      stderr: String(error?.stderr ?? message),
    };
  }
}

async function isGitRepository(rootPath) {
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

async function assertGitRepository(rootPath) {
  if (!(await isGitRepository(rootPath))) {
    throw new Error('Local project is not a git repository');
  }
}

function parseGitRemoteDefaultBranch(raw, remoteName) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const prefix = `${remoteName}/`;
  if (!trimmed.startsWith(prefix)) return null;
  const name = trimmed.slice(prefix.length).trim();
  return name || null;
}

async function listGitRemotes(rootPath) {
  const remoteResult = await runGitCommand(rootPath, ['remote']);
  if (remoteResult.status !== 0) return [];
  return remoteResult.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

async function resolveCommitAtRef(rootPath, refName) {
  const result = await runGitCommand(rootPath, ['show-ref', '--verify', '--hash', refName]);
  if (result.status !== 0) return null;
  const commitHash = result.stdout.trim();
  return commitHash || null;
}

const LOCAL_BRANCH_SELECTOR_PREFIX = 'lody:branch:local:';
const REMOTE_BRANCH_SELECTOR_PREFIX = 'lody:branch:remote:';

function createLocalProjectBranchSelector(candidate) {
  if (candidate.kind === 'local') {
    return `${LOCAL_BRANCH_SELECTOR_PREFIX}${encodeURIComponent(candidate.branchName)}`;
  }
  return `${REMOTE_BRANCH_SELECTOR_PREFIX}${encodeURIComponent(
    candidate.remoteName ?? ''
  )}:${encodeURIComponent(candidate.branchName)}`;
}

function parseBranchSelector(selector) {
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

function selectLocalProjectBranchSelector(branches, branchName) {
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
  return remoteMatches.length === 1 ? remoteMatches[0] : null;
}

function findQualifiedRemoteName(remotes, branchName) {
  return (
    [...remotes]
      .sort((a, b) => b.length - a.length)
      .find((remote) => branchName.startsWith(`${remote}/`)) ?? null
  );
}

async function resolveLocalProjectBranchRefAtRootPath(rootPath, refName) {
  const parsedRef = await parseLocalProjectBranchRefAtRootPath(rootPath, refName);
  const commitHash = await resolveCommitAtRef(rootPath, parsedRef.refName);
  if (!commitHash) {
    throw new Error(`Local project branch ref not found: ${parsedRef.refName}`);
  }
  return { ...parsedRef, commitHash };
}

async function parseLocalProjectBranchRefAtRootPath(rootPath, refName) {
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

async function getLocalProjectBranchUpstreamRefAtRootPath(rootPath, branchName) {
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

async function getLocalProjectCurrentBranchNameAtRootPath(rootPath) {
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

async function resolveLocalProjectLegacyBaseBranchAtRootPath(rootPath, branchName, options = {}) {
  const normalizedRootPath = ensureLocalProjectRootPath(rootPath);
  const normalizedBranchName = branchName.trim();
  if (!normalizedBranchName) {
    throw new Error('Branch name is required');
  }

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

  return await resolveLocalProjectBranchAtRootPath(normalizedRootPath, normalizedBranchName, {
    preferLocalOnCollision: true,
  });
}

async function resolveLocalProjectBranchAtRootPath(rootPath, branchName, options = {}) {
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

  const matches = [];
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
      branchName: matches[0].branchName,
      remoteName: matches[0].remoteName,
      refName: matches[0].refName,
      commitHash: matches[0].commitHash,
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

async function resolveGitRemoteUrl(rootPath, remoteName, direction) {
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

function parseRemoteAsGitHubRepo(remoteUrl) {
  try {
    const parsed = parseGitHubRepo(remoteUrl);
    return parsed ? `${parsed.owner}/${parsed.repo}` : null;
  } catch {
    return null;
  }
}

async function resolveCurrentBranchRemote(rootPath, remotes) {
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

async function probeGitHubRemoteAtRootPath(rootPath) {
  await assertGitRepository(rootPath);

  const remotes = await listGitRemotes(rootPath);
  if (remotes.length === 0) return null;

  const currentBranchRemote = await resolveCurrentBranchRemote(rootPath, remotes);
  const prioritizedRemotes = [];
  if (currentBranchRemote && remotes.includes(currentBranchRemote)) {
    prioritizedRemotes.push(currentBranchRemote);
  }
  if (remotes.includes('origin') && currentBranchRemote !== 'origin') {
    prioritizedRemotes.push('origin');
  }
  if (prioritizedRemotes.length === 0 && remotes.length === 1) {
    prioritizedRemotes.push(remotes[0]);
  }

  const candidates = [];
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

async function listLocalProjectBranchesAtRootPath(rootPath) {
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

  const remoteSet = new Set(remotes);
  const localBranchNames = new Set();
  const candidates = [];
  const remoteRefsByBranch = new Map();
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

  let defaultBranchFromRemote = null;
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

  const candidatesBySelector = new Map();
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

  const localSelector = (branchName) =>
    candidates.find(
      (candidate) => candidate.kind === 'local' && candidate.branchName === branchName
    )?.selector ?? null;
  const remoteSelector = (remoteName, branchName) =>
    candidates.find(
      (candidate) =>
        candidate.kind === 'remote' &&
        candidate.remoteName === remoteName &&
        candidate.branchName === branchName
    )?.selector ?? null;

  let defaultBranch = null;
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

async function getLocalProjectWorkingTreeAtRootPath(rootPath) {
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

async function getLocalProjectGitStateAtRootPath(rootPath) {
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
    githubRepoFullName: githubRemote ? githubRemote.repoFullName : null,
    workingTree,
  };
}

function getWorkingTreeBlockers(workingTree) {
  const blockers = [];
  if (workingTree.conflicted) blockers.push('conflicted files');
  if (workingTree.staged) blockers.push('staged changes');
  if (workingTree.unstaged) blockers.push('unstaged changes');
  if (workingTree.untracked) blockers.push('untracked files');
  return blockers;
}

async function resolveTrackingLocalBranchName(rootPath, resolvedBranch) {
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
  const isAvailable = (branchName) => {
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
  throw new Error(`Unable to choose a local tracking branch for ${resolvedBranch.refName}`);
}

async function resolveReusableTrackingBranchName(rootPath, resolvedBranch) {
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
      (fields) =>
        fields.length === 3 &&
        fields[1] === resolvedBranch.refName &&
        fields[2] === resolvedBranch.commitHash
    )
    .map(([branchName]) => branchName)
    .filter((branchName) => branchName === currentBranch || !checkedOutBranches.has(branchName));
  return matches.find((branchName) => branchName === currentBranch) ?? matches[0] ?? null;
}

async function checkoutLocalProjectBranchAtRootPath(rootPath, branchName) {
  const normalizedRootPath = ensureLocalProjectRootPath(rootPath);
  const normalizedBranchName = branchName.trim();
  if (!normalizedBranchName) {
    throw new Error('Branch name is required');
  }

  const resolvedBranch = await resolveLocalProjectBranchAtRootPath(
    normalizedRootPath,
    normalizedBranchName
  );

  let reusableTrackingBranch = null;
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

module.exports = {
  normalizeLocalProjectRootPath,
  ensureLocalProjectRootPath,
  getLocalProjectNameFromRootPath,
  createLocalProjectId,
  getLocalProjectWorkingTreeAtRootPath,
  getLocalProjectGitStateAtRootPath,
  createLocalProjectBranchSelector,
  selectLocalProjectBranchSelector,
  getLocalProjectBranchUpstreamRefAtRootPath,
  getLocalProjectCurrentBranchNameAtRootPath,
  resolveLocalProjectBranchAtRootPath,
  parseLocalProjectBranchRefAtRootPath,
  resolveLocalProjectBranchRefAtRootPath,
  resolveLocalProjectLegacyBaseBranchAtRootPath,
  checkoutLocalProjectBranchAtRootPath,
};
