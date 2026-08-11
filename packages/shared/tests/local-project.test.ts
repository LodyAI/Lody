import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import {
  checkoutLocalProjectBranchAtRootPath,
  createLocalProjectId,
  getLocalProjectGitStateAtRootPath,
  getLocalProjectWorkingTreeAtRootPath,
  normalizeLocalProjectRootPath,
  parseLocalProjectBranchRefAtRootPath,
  resolveLocalProjectBranchAtRootPath,
  resolveLocalProjectBranchRefAtRootPath,
  resolveLocalProjectLegacyBaseBranchAtRootPath,
  selectLocalProjectBranchSelector,
} from '../src/node/local-project';

const require = createRequire(import.meta.url);
const {
  checkoutLocalProjectBranchAtRootPath: checkoutLocalProjectBranchAtRootPathCjs,
  getLocalProjectGitStateAtRootPath: getLocalProjectGitStateAtRootPathCjs,
  resolveLocalProjectBranchAtRootPath: resolveLocalProjectBranchAtRootPathCjs,
  parseLocalProjectBranchRefAtRootPath: parseLocalProjectBranchRefAtRootPathCjs,
  resolveLocalProjectBranchRefAtRootPath: resolveLocalProjectBranchRefAtRootPathCjs,
  resolveLocalProjectLegacyBaseBranchAtRootPath: resolveLocalProjectLegacyBaseBranchAtRootPathCjs,
  selectLocalProjectBranchSelector: selectLocalProjectBranchSelectorCjs,
} = require('../src/node/local-project.cjs') as {
  checkoutLocalProjectBranchAtRootPath: (
    rootPath: string,
    branchName: string
  ) => Promise<{ currentBranch: string }>;
  getLocalProjectGitStateAtRootPath: (
    rootPath: string
  ) => ReturnType<typeof getLocalProjectGitStateAtRootPath>;
  resolveLocalProjectBranchAtRootPath: (
    rootPath: string,
    branchName: string,
    options?: { preferLocalOnCollision?: boolean }
  ) => Promise<{ kind: string; branchName: string; refName: string; commitHash: string }>;
  selectLocalProjectBranchSelector: (branches: string[], branchName: string) => string | null;
  parseLocalProjectBranchRefAtRootPath: (
    rootPath: string,
    refName: string
  ) => Promise<{ kind: string; branchName: string; refName: string }>;
  resolveLocalProjectBranchRefAtRootPath: (
    rootPath: string,
    refName: string
  ) => Promise<{ kind: string; branchName: string; refName: string; commitHash: string }>;
  resolveLocalProjectLegacyBaseBranchAtRootPath: (
    rootPath: string,
    branchName: string,
    options?: { useWorktree?: boolean }
  ) => Promise<{ kind: string; branchName: string; refName: string; commitHash: string }>;
};

const GIT_HELPER_TEST_TIMEOUT_MS = 60_000;

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lody-local-project-'));
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function runGitWithInput(cwd: string, args: string[], input: string): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function createClonedProjectWithUpstreamRemote(baseDir: string): string {
  const seedDir = path.join(baseDir, 'seed');
  const remoteDir = path.join(baseDir, 'remote.git');
  const projectDir = path.join(baseDir, 'git-project');
  fs.mkdirSync(seedDir);

  runGit(seedDir, ['init', '-b', 'main']);
  fs.writeFileSync(path.join(seedDir, 'README.md'), '# hello\n', 'utf8');
  runGit(seedDir, ['add', 'README.md']);
  runGit(seedDir, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    'init',
  ]);

  runGit(seedDir, ['checkout', '-b', 'feature/remote-branch']);
  fs.writeFileSync(path.join(seedDir, 'feature.txt'), 'remote branch\n', 'utf8');
  runGit(seedDir, ['add', 'feature.txt']);
  runGit(seedDir, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    'feature',
  ]);
  runGit(seedDir, ['checkout', 'main']);

  runGit(baseDir, ['init', '--bare', '-b', 'main', remoteDir]);
  runGit(seedDir, ['remote', 'add', 'upstream', remoteDir]);
  runGit(seedDir, ['push', '-u', 'upstream', 'main']);
  runGit(seedDir, ['push', 'upstream', 'feature/remote-branch']);

  runGit(baseDir, ['clone', '-o', 'upstream', remoteDir, projectDir]);
  return projectDir;
}

function createGitProjectWithRemotes(
  baseDir: string,
  remotes: Array<{ name: string; url: string }>
): string {
  const projectDir = path.join(baseDir, `git-project-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(projectDir);

  runGit(projectDir, ['init', '-b', 'main']);
  fs.writeFileSync(path.join(projectDir, 'README.md'), '# hello\n', 'utf8');
  runGit(projectDir, ['add', 'README.md']);
  runGit(projectDir, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    'init',
  ]);

  for (const remote of remotes) {
    runGit(projectDir, ['remote', 'add', remote.name, remote.url]);
  }

  return projectDir;
}

describe('local-project helpers', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (!tempDir) return;
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it('creates a deterministic project id for the normalized root path', () => {
    tempDir = makeTempDir();
    const projectDir = path.join(tempDir, 'project');
    fs.mkdirSync(projectDir);

    const first = createLocalProjectId(projectDir);
    const second = createLocalProjectId(`${projectDir}${path.sep}`);

    expect(first).toBe(second);
    expect(normalizeLocalProjectRootPath(`${projectDir}${path.sep}`)).toBe(
      normalizeLocalProjectRootPath(projectDir)
    );
  });

  it('returns git=false for plain directories', async () => {
    tempDir = makeTempDir();
    const projectDir = path.join(tempDir, 'plain-project');
    fs.mkdirSync(projectDir);

    expect(await getLocalProjectGitStateAtRootPath(projectDir)).toEqual({ git: false });
  });

  it(
    'reports an initialized repository with no commits as git with no branches',
    async () => {
      tempDir = makeTempDir();
      runGit(tempDir, ['init', '-b', 'main']);

      const gitState = await getLocalProjectGitStateAtRootPath(tempDir);

      expect(gitState).toMatchObject({
        git: true,
        branches: [],
        currentBranch: null,
        defaultBranch: null,
      });
    },
    GIT_HELPER_TEST_TIMEOUT_MS
  );

  it(
    'returns git=false for a project nested in a dirty parent repository',
    async () => {
      tempDir = makeTempDir();
      runGit(tempDir, ['init', '-b', 'main']);
      const projectDir = path.join(tempDir, 'nested-project');
      fs.mkdirSync(projectDir);
      fs.writeFileSync(path.join(projectDir, 'untracked.txt'), 'dirty parent\n', 'utf8');
      expect(runGit(tempDir, ['status', '--porcelain'])).not.toBe('');

      expect(await getLocalProjectGitStateAtRootPath(projectDir)).toEqual({ git: false });
      expect(await getLocalProjectGitStateAtRootPathCjs(projectDir)).toEqual({ git: false });
    },
    GIT_HELPER_TEST_TIMEOUT_MS
  );

  it(
    'reports git branches, working tree state, and default branch',
    async () => {
      tempDir = makeTempDir();
      const projectDir = path.join(tempDir, 'git-project');
      fs.mkdirSync(projectDir);

      runGit(projectDir, ['init', '-b', 'main']);
      fs.writeFileSync(path.join(projectDir, 'README.md'), '# hello\n', 'utf8');
      runGit(projectDir, ['add', 'README.md']);
      runGit(projectDir, [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-m',
        'init',
      ]);
      runGit(projectDir, ['checkout', '-b', 'feature/local-branch']);
      runGit(projectDir, ['checkout', 'main']);

      const gitState = await getLocalProjectGitStateAtRootPath(projectDir);

      expect(gitState.git).toBe(true);
      if (!gitState.git) {
        return;
      }

      expect(gitState.currentBranch).toBe('main');
      expect(gitState.defaultBranch).toBe('main');
      expect(gitState.branches).toContain('main');
      expect(gitState.branches).toContain('feature/local-branch');
      expect(gitState.githubRepoFullName).toBeNull();
      expect(gitState.workingTree).toEqual({
        clean: true,
        staged: false,
        unstaged: false,
        untracked: false,
        conflicted: false,
      });
    },
    GIT_HELPER_TEST_TIMEOUT_MS
  );

  it(
    'resolves local and unique remote-only branches to exact refs',
    async () => {
      tempDir = makeTempDir();
      const projectDir = createClonedProjectWithUpstreamRemote(tempDir);

      const local = await resolveLocalProjectBranchAtRootPath(projectDir, 'lody:branch:local:main');
      const remote = await resolveLocalProjectBranchAtRootPath(projectDir, 'feature/remote-branch');

      expect(local.refName).toBe('refs/heads/main');
      expect(local.commitHash).toMatch(/^[0-9a-f]{40,64}$/);
      expect(remote.refName).toBe('refs/remotes/upstream/feature/remote-branch');
      expect(remote.commitHash).toMatch(/^[0-9a-f]{40,64}$/);
    },
    GIT_HELPER_TEST_TIMEOUT_MS
  );

  it(
    'rejects missing branches instead of falling back to HEAD',
    async () => {
      tempDir = makeTempDir();
      const projectDir = createClonedProjectWithUpstreamRemote(tempDir);

      await expect(
        resolveLocalProjectBranchAtRootPath(projectDir, 'feature/missing')
      ).rejects.toThrow('Local project branch not found: feature/missing');
    },
    GIT_HELPER_TEST_TIMEOUT_MS
  );

  it(
    'rejects a legacy selector when local and remote refs share its name',
    async () => {
      tempDir = makeTempDir();
      const projectDir = createGitProjectWithRemotes(tempDir, [
        { name: 'origin', url: path.join(tempDir, 'origin.git') },
      ]);
      runGit(projectDir, ['branch', 'foo']);
      runGit(projectDir, ['update-ref', 'refs/remotes/origin/foo', 'HEAD']);

      const expectedMessage =
        'Local project branch is ambiguous: foo. Matches: refs/heads/foo, refs/remotes/origin/foo';
      await expect(resolveLocalProjectBranchAtRootPath(projectDir, 'foo')).rejects.toThrow(
        expectedMessage
      );
      await expect(resolveLocalProjectBranchAtRootPathCjs(projectDir, 'foo')).rejects.toThrow(
        expectedMessage
      );
    },
    GIT_HELPER_TEST_TIMEOUT_MS
  );

  it(
    'emits exact selectors when local and remote refs share a short name',
    async () => {
      tempDir = makeTempDir();
      const projectDir = createGitProjectWithRemotes(tempDir, [
        { name: 'origin', url: path.join(tempDir, 'origin.git') },
      ]);
      runGit(projectDir, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);

      const expectedState = {
        branches: expect.arrayContaining(['lody:branch:local:main', 'origin/main']),
        currentBranch: 'lody:branch:local:main',
        defaultBranch: 'lody:branch:local:main',
      };
      await expect(getLocalProjectGitStateAtRootPath(projectDir)).resolves.toMatchObject(
        expectedState
      );
      await expect(getLocalProjectGitStateAtRootPathCjs(projectDir)).resolves.toMatchObject(
        expectedState
      );
      await expect(
        resolveLocalProjectBranchAtRootPath(projectDir, 'lody:branch:local:main')
      ).resolves.toMatchObject({ kind: 'local', refName: 'refs/heads/main' });
    },
    GIT_HELPER_TEST_TIMEOUT_MS
  );

  it(
    'accepts only exact canonical branch refs',
    async () => {
      tempDir = makeTempDir();
      const projectDir = createClonedProjectWithUpstreamRemote(tempDir);

      await expect(
        resolveLocalProjectBranchRefAtRootPath(projectDir, 'refs/heads/main')
      ).resolves.toMatchObject({ kind: 'local', refName: 'refs/heads/main' });
      await expect(
        resolveLocalProjectBranchRefAtRootPath(
          projectDir,
          'refs/remotes/upstream/feature/remote-branch'
        )
      ).resolves.toMatchObject({
        kind: 'remote',
        refName: 'refs/remotes/upstream/feature/remote-branch',
      });
      await expect(
        resolveLocalProjectBranchRefAtRootPath(projectDir, 'refs/heads/main~1')
      ).rejects.toThrow('Local project branch ref not found: refs/heads/main~1');
      await expect(
        resolveLocalProjectBranchRefAtRootPathCjs(projectDir, 'refs/heads/main~1')
      ).rejects.toThrow('Local project branch ref not found: refs/heads/main~1');

      runGit(projectDir, ['update-ref', '-d', 'refs/remotes/upstream/feature/remote-branch']);
      await expect(
        parseLocalProjectBranchRefAtRootPath(
          projectDir,
          'refs/remotes/upstream/feature/remote-branch'
        )
      ).resolves.toMatchObject({
        kind: 'remote',
        refName: 'refs/remotes/upstream/feature/remote-branch',
      });
      await expect(
        parseLocalProjectBranchRefAtRootPathCjs(
          projectDir,
          'refs/remotes/upstream/feature/remote-branch'
        )
      ).resolves.toMatchObject({ kind: 'remote' });
      await expect(
        resolveLocalProjectBranchRefAtRootPath(
          projectDir,
          'refs/remotes/upstream/feature/remote-branch'
        )
      ).rejects.toThrow(
        'Local project branch ref not found: refs/remotes/upstream/feature/remote-branch'
      );
    },
    GIT_HELPER_TEST_TIMEOUT_MS
  );

  it(
    'recovers a tracking upstream after the local branch diverges',
    async () => {
      tempDir = makeTempDir();
      const projectDir = createGitProjectWithRemotes(tempDir, [
        { name: 'origin', url: path.join(tempDir, 'origin.git') },
      ]);
      const remoteCommit = runGit(projectDir, ['rev-parse', 'HEAD']);
      runGit(projectDir, ['update-ref', 'refs/remotes/origin/foo', remoteCommit]);
      runGit(projectDir, ['checkout', '--track', '-b', 'foo', 'refs/remotes/origin/foo']);

      await expect(
        resolveLocalProjectLegacyBaseBranchAtRootPath(projectDir, 'foo')
      ).resolves.toMatchObject({
        kind: 'remote',
        refName: 'refs/remotes/origin/foo',
        commitHash: remoteCommit,
      });
      await expect(
        resolveLocalProjectLegacyBaseBranchAtRootPathCjs(projectDir, 'foo')
      ).resolves.toMatchObject({ kind: 'remote', commitHash: remoteCommit });

      fs.writeFileSync(path.join(projectDir, 'session.txt'), 'session change\n', 'utf8');
      runGit(projectDir, ['add', 'session.txt']);
      runGit(projectDir, [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-m',
        'session change',
      ]);

      await expect(
        resolveLocalProjectLegacyBaseBranchAtRootPath(projectDir, 'foo')
      ).resolves.toMatchObject({
        kind: 'remote',
        refName: 'refs/remotes/origin/foo',
        commitHash: remoteCommit,
      });
      await expect(
        resolveLocalProjectLegacyBaseBranchAtRootPathCjs(projectDir, 'foo')
      ).resolves.toMatchObject({ kind: 'remote', commitHash: remoteCommit });
    },
    GIT_HELPER_TEST_TIMEOUT_MS
  );

  it(
    'keeps a legacy base on the local branch when no upstream records the base',
    async () => {
      tempDir = makeTempDir();
      const projectDir = createGitProjectWithRemotes(tempDir, [
        { name: 'origin', url: path.join(tempDir, 'origin.git') },
      ]);
      const remoteCommit = runGit(projectDir, ['rev-parse', 'HEAD']);
      runGit(projectDir, ['update-ref', 'refs/remotes/origin/master', remoteCommit]);
      // `git checkout -b` records no upstream, which is the ordinary shape for a
      // `master` that predates selectors.
      runGit(projectDir, ['checkout', '-b', 'master']);
      fs.writeFileSync(path.join(projectDir, 'local.txt'), 'local only\n', 'utf8');
      runGit(projectDir, ['add', 'local.txt']);
      runGit(projectDir, [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-m',
        'local master',
      ]);
      const localCommit = runGit(projectDir, ['rev-parse', 'HEAD']);
      runGit(projectDir, ['checkout', 'main']);
      expect(localCommit).not.toBe(remoteCommit);

      const expected = {
        kind: 'local',
        refName: 'refs/heads/master',
        commitHash: localCommit,
      };
      for (const options of [undefined, { useWorktree: true }, { useWorktree: false }]) {
        await expect(
          resolveLocalProjectLegacyBaseBranchAtRootPath(projectDir, 'master', options)
        ).resolves.toMatchObject(expected);
        await expect(
          resolveLocalProjectLegacyBaseBranchAtRootPathCjs(projectDir, 'master', options)
        ).resolves.toMatchObject(expected);
      }

      // The strict selector contract is unchanged: only the legacy/human paths
      // fall back to Git's local-first precedence.
      await expect(resolveLocalProjectBranchAtRootPath(projectDir, 'master')).rejects.toThrow(
        'Local project branch is ambiguous: master'
      );
      await expect(
        resolveLocalProjectBranchAtRootPath(projectDir, 'master', { preferLocalOnCollision: true })
      ).resolves.toMatchObject(expected);
      await expect(
        resolveLocalProjectBranchAtRootPathCjs(projectDir, 'master', {
          preferLocalOnCollision: true,
        })
      ).resolves.toMatchObject(expected);
    },
    GIT_HELPER_TEST_TIMEOUT_MS
  );

  it(
    'keeps a worktree base on the local branch even when it tracks a remote',
    async () => {
      tempDir = makeTempDir();
      const projectDir = createGitProjectWithRemotes(tempDir, [
        { name: 'origin', url: path.join(tempDir, 'origin.git') },
      ]);
      const remoteCommit = runGit(projectDir, ['rev-parse', 'HEAD']);
      runGit(projectDir, ['update-ref', 'refs/remotes/origin/main', remoteCommit]);
      runGit(projectDir, ['branch', '--set-upstream-to=origin/main', 'main']);
      fs.writeFileSync(path.join(projectDir, 'local.txt'), 'ahead of origin\n', 'utf8');
      runGit(projectDir, ['add', 'local.txt']);
      runGit(projectDir, [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-m',
        'ahead of origin',
      ]);
      const localCommit = runGit(projectDir, ['rev-parse', 'HEAD']);
      expect(localCommit).not.toBe(remoteCommit);

      // Worktree mode never checked the base out in the project root, so the
      // local branch is the user's own and stays the base.
      const worktreeExpected = {
        kind: 'local',
        refName: 'refs/heads/main',
        commitHash: localCommit,
      };
      await expect(
        resolveLocalProjectLegacyBaseBranchAtRootPath(projectDir, 'main', { useWorktree: true })
      ).resolves.toMatchObject(worktreeExpected);
      await expect(
        resolveLocalProjectLegacyBaseBranchAtRootPathCjs(projectDir, 'main', { useWorktree: true })
      ).resolves.toMatchObject(worktreeExpected);

      // Checkout mode still recovers the upstream, because there the local
      // branch may be the session's own work branch.
      const checkoutExpected = {
        kind: 'remote',
        refName: 'refs/remotes/origin/main',
        commitHash: remoteCommit,
      };
      await expect(
        resolveLocalProjectLegacyBaseBranchAtRootPath(projectDir, 'main')
      ).resolves.toMatchObject(checkoutExpected);
      await expect(
        resolveLocalProjectLegacyBaseBranchAtRootPathCjs(projectDir, 'main')
      ).resolves.toMatchObject(checkoutExpected);
    },
    GIT_HELPER_TEST_TIMEOUT_MS
  );

  it(
    'still refuses a legacy base that only matches several remotes',
    async () => {
      tempDir = makeTempDir();
      const projectDir = createGitProjectWithRemotes(tempDir, [
        { name: 'origin', url: path.join(tempDir, 'origin.git') },
        { name: 'upstream', url: path.join(tempDir, 'upstream.git') },
      ]);
      runGit(projectDir, ['update-ref', 'refs/remotes/origin/release', 'HEAD']);
      runGit(projectDir, ['update-ref', 'refs/remotes/upstream/release', 'HEAD']);

      // Git refuses this too ("matched multiple remote tracking branches"), and
      // there is no local branch whose precedence could break the tie.
      const expectedMessage =
        'Local project branch is ambiguous: release. Matches: refs/remotes/origin/release, refs/remotes/upstream/release';
      for (const options of [undefined, { useWorktree: true }]) {
        await expect(
          resolveLocalProjectLegacyBaseBranchAtRootPath(projectDir, 'release', options)
        ).rejects.toThrow(expectedMessage);
        await expect(
          resolveLocalProjectLegacyBaseBranchAtRootPathCjs(projectDir, 'release', options)
        ).rejects.toThrow(expectedMessage);
      }
    },
    GIT_HELPER_TEST_TIMEOUT_MS
  );

  it('maps a bare branch name onto a reported selector, preferring the local one', () => {
    const branches = [
      'lody:branch:local:main',
      'lody:branch:remote:origin:main',
      'origin/release',
      'lody:branch:remote:origin:solo',
      'lody:branch:remote:upstream:shared',
      'lody:branch:remote:origin:shared',
    ];

    for (const select of [selectLocalProjectBranchSelector, selectLocalProjectBranchSelectorCjs]) {
      expect(select(branches, 'main')).toBe('lody:branch:local:main');
      expect(select(branches, 'lody:branch:remote:origin:main')).toBe(
        'lody:branch:remote:origin:main'
      );
      // Exact members win before any precedence rule applies.
      expect(select(branches, 'origin/release')).toBe('origin/release');
      // A bare name with a single remote match resolves to that remote.
      expect(select(branches, 'solo')).toBe('lody:branch:remote:origin:solo');
      // Several remotes and no local branch stays unresolved.
      expect(select(branches, 'shared')).toBeNull();
      expect(select(branches, 'missing')).toBeNull();
      expect(select(branches, '  ')).toBeNull();
    }
  });

  it(
    'rejects an unqualified branch that exists on multiple remotes',
    async () => {
      tempDir = makeTempDir();
      const projectDir = createGitProjectWithRemotes(tempDir, [
        { name: 'origin', url: path.join(tempDir, 'origin.git') },
        { name: 'upstream', url: path.join(tempDir, 'upstream.git') },
      ]);
      runGit(projectDir, ['update-ref', 'refs/remotes/origin/feature/shared', 'HEAD']);
      runGit(projectDir, ['update-ref', 'refs/remotes/upstream/feature/shared', 'HEAD']);

      const gitState = await getLocalProjectGitStateAtRootPath(projectDir);
      expect(gitState).toMatchObject({
        git: true,
        branches: expect.arrayContaining(['origin/feature/shared', 'upstream/feature/shared']),
      });
      if (gitState.git) {
        expect(gitState.branches).not.toContain('feature/shared');
      }

      await expect(
        resolveLocalProjectBranchAtRootPath(projectDir, 'origin/feature/shared')
      ).resolves.toMatchObject({ refName: 'refs/remotes/origin/feature/shared' });
      await expect(
        resolveLocalProjectBranchAtRootPath(projectDir, 'feature/shared')
      ).rejects.toThrow(
        'Local project branch is ambiguous: feature/shared. Matches: refs/remotes/origin/feature/shared, refs/remotes/upstream/feature/shared'
      );
    },
    GIT_HELPER_TEST_TIMEOUT_MS
  );

  it(
    'keeps a local branch and a qualified remote branch distinct when their selectors collide',
    async () => {
      tempDir = makeTempDir();
      const projectDir = createGitProjectWithRemotes(tempDir, [
        { name: 'origin', url: path.join(tempDir, 'origin.git') },
        { name: 'upstream', url: path.join(tempDir, 'upstream.git') },
      ]);
      const remoteCommit = runGit(projectDir, ['rev-parse', 'HEAD']);
      runGit(projectDir, ['update-ref', 'refs/remotes/origin/foo', remoteCommit]);
      runGit(projectDir, ['update-ref', 'refs/remotes/upstream/foo', remoteCommit]);
      runGit(projectDir, ['checkout', '-b', 'origin/foo']);
      fs.writeFileSync(path.join(projectDir, 'local-only.txt'), 'local branch\n', 'utf8');
      runGit(projectDir, ['add', 'local-only.txt']);
      runGit(projectDir, [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-m',
        'local collision',
      ]);
      const localCommit = runGit(projectDir, ['rev-parse', 'HEAD']);
      runGit(projectDir, ['checkout', 'main']);

      const gitState = await getLocalProjectGitStateAtRootPath(projectDir);
      expect(gitState).toMatchObject({
        git: true,
        branches: expect.arrayContaining([
          'lody:branch:local:origin%2Ffoo',
          'lody:branch:remote:origin:foo',
          'upstream/foo',
        ]),
      });
      await expect(getLocalProjectGitStateAtRootPathCjs(projectDir)).resolves.toMatchObject({
        git: true,
        branches: expect.arrayContaining([
          'lody:branch:local:origin%2Ffoo',
          'lody:branch:remote:origin:foo',
          'upstream/foo',
        ]),
      });

      await expect(resolveLocalProjectBranchAtRootPath(projectDir, 'origin/foo')).rejects.toThrow(
        'Local project branch is ambiguous: origin/foo. Matches: refs/heads/origin/foo, refs/remotes/origin/foo'
      );
      await expect(
        resolveLocalProjectBranchAtRootPath(projectDir, 'lody:branch:local:origin%2Ffoo')
      ).resolves.toMatchObject({ kind: 'local', commitHash: localCommit });
      await expect(
        resolveLocalProjectBranchAtRootPath(projectDir, 'lody:branch:remote:origin:foo')
      ).resolves.toMatchObject({ kind: 'remote', commitHash: remoteCommit });
      await expect(
        resolveLocalProjectBranchAtRootPathCjs(projectDir, 'lody:branch:remote:origin:foo')
      ).resolves.toMatchObject({
        kind: 'remote',
        refName: 'refs/remotes/origin/foo',
        commitHash: remoteCommit,
      });
    },
    GIT_HELPER_TEST_TIMEOUT_MS
  );

  it(
    'round-trips a legal branch name that starts with the full refs namespace',
    async () => {
      tempDir = makeTempDir();
      const projectDir = createGitProjectWithRemotes(tempDir, []);
      const ordinaryCommit = runGit(projectDir, ['rev-parse', 'HEAD']);
      runGit(projectDir, ['branch', 'foo']);
      runGit(projectDir, ['checkout', '-b', 'refs/heads/foo']);
      fs.writeFileSync(path.join(projectDir, 'namespace.txt'), 'namespace branch\n', 'utf8');
      runGit(projectDir, ['add', 'namespace.txt']);
      runGit(projectDir, [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-m',
        'namespace branch',
      ]);
      const namespaceCommit = runGit(projectDir, ['rev-parse', 'HEAD']);
      expect(namespaceCommit).not.toBe(ordinaryCommit);

      const gitState = await getLocalProjectGitStateAtRootPath(projectDir);
      expect(gitState).toMatchObject({
        git: true,
        branches: expect.arrayContaining(['foo', 'refs/heads/foo']),
      });
      await expect(
        resolveLocalProjectBranchAtRootPath(projectDir, 'refs/heads/foo')
      ).resolves.toMatchObject({
        kind: 'local',
        refName: 'refs/heads/refs/heads/foo',
        commitHash: namespaceCommit,
      });
      await expect(
        resolveLocalProjectBranchAtRootPathCjs(projectDir, 'refs/heads/foo')
      ).resolves.toMatchObject({ commitHash: namespaceCommit });

      runGit(projectDir, ['switch', 'main']);
      await expect(
        checkoutLocalProjectBranchAtRootPath(projectDir, 'refs/heads/foo')
      ).resolves.toEqual({ currentBranch: 'refs/heads/foo' });
      expect(runGit(projectDir, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/refs/heads/foo');
      expect(runGit(projectDir, ['rev-parse', 'HEAD'])).toBe(namespaceCommit);
      expect(runGit(projectDir, ['rev-parse', 'refs/heads/foo'])).toBe(ordinaryCommit);
    },
    GIT_HELPER_TEST_TIMEOUT_MS
  );

  it(
    'qualifies a remote branch whose short name looks like another remote',
    async () => {
      tempDir = makeTempDir();
      const projectDir = createGitProjectWithRemotes(tempDir, [
        { name: 'origin', url: path.join(tempDir, 'origin.git') },
        { name: 'upstream', url: path.join(tempDir, 'upstream.git') },
      ]);
      runGit(projectDir, ['update-ref', 'refs/remotes/upstream/origin/feature', 'HEAD']);

      const gitState = await getLocalProjectGitStateAtRootPath(projectDir);
      expect(gitState).toMatchObject({
        git: true,
        branches: expect.arrayContaining(['upstream/origin/feature']),
      });
      await expect(
        resolveLocalProjectBranchAtRootPath(projectDir, 'upstream/origin/feature')
      ).resolves.toMatchObject({ refName: 'refs/remotes/upstream/origin/feature' });
    },
    GIT_HELPER_TEST_TIMEOUT_MS
  );

  it(
    'discovers branches from a remote whose name contains a slash',
    async () => {
      tempDir = makeTempDir();
      const projectDir = createGitProjectWithRemotes(tempDir, [
        { name: 'team/upstream', url: path.join(tempDir, 'upstream.git') },
      ]);
      runGit(projectDir, ['update-ref', 'refs/remotes/team/upstream/feature', 'HEAD']);

      const gitState = await getLocalProjectGitStateAtRootPath(projectDir);
      expect(gitState).toMatchObject({ git: true, branches: expect.arrayContaining(['feature']) });
      await expect(
        resolveLocalProjectBranchAtRootPath(projectDir, 'feature')
      ).resolves.toMatchObject({ refName: 'refs/remotes/team/upstream/feature' });
    },
    GIT_HELPER_TEST_TIMEOUT_MS
  );

  it(
    'checks out a qualified remote branch without detaching the repository',
    async () => {
      tempDir = makeTempDir();
      const projectDir = createGitProjectWithRemotes(tempDir, [
        { name: 'origin', url: path.join(tempDir, 'origin.git') },
        { name: 'upstream', url: path.join(tempDir, 'upstream.git') },
      ]);
      const expectedHead = runGit(projectDir, ['rev-parse', 'HEAD']);
      runGit(projectDir, ['update-ref', 'refs/remotes/origin/feature/shared', 'HEAD']);
      runGit(projectDir, ['update-ref', 'refs/remotes/upstream/feature/shared', 'HEAD']);

      await expect(
        checkoutLocalProjectBranchAtRootPath(projectDir, 'origin/feature/shared')
      ).resolves.toEqual({ currentBranch: 'feature/shared' });

      expect(runGit(projectDir, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/feature/shared');
      expect(runGit(projectDir, ['rev-parse', 'HEAD'])).toBe(expectedHead);
      expect(runGit(projectDir, ['config', 'branch.feature/shared.remote'])).toBe('origin');
    },
    GIT_HELPER_TEST_TIMEOUT_MS
  );

  it(
    'checks out local branches whose names start with git option syntax',
    async () => {
      tempDir = makeTempDir();
      const projectDir = createGitProjectWithRemotes(tempDir, []);
      runGit(projectDir, ['update-ref', 'refs/heads/--detach', 'HEAD']);
      runGit(projectDir, ['update-ref', 'refs/heads/-f', 'HEAD']);

      await expect(
        checkoutLocalProjectBranchAtRootPath(projectDir, 'lody:branch:local:--detach')
      ).resolves.toEqual({ currentBranch: '--detach' });
      expect(runGit(projectDir, ['symbolic-ref', '--short', 'HEAD'])).toBe('--detach');

      runGit(projectDir, ['switch', 'main']);
      await expect(
        checkoutLocalProjectBranchAtRootPathCjs(projectDir, 'lody:branch:local:-f')
      ).resolves.toEqual({ currentBranch: '-f' });
      expect(runGit(projectDir, ['symbolic-ref', '--short', 'HEAD'])).toBe('-f');
    },
    GIT_HELPER_TEST_TIMEOUT_MS
  );

  it(
    'reuses tracking branches whose names start with git option syntax',
    async () => {
      tempDir = makeTempDir();
      const projectDir = createGitProjectWithRemotes(tempDir, [
        { name: 'origin', url: path.join(tempDir, 'origin.git') },
      ]);
      runGit(projectDir, ['update-ref', 'refs/remotes/origin/--detach', 'HEAD']);
      runGit(projectDir, ['update-ref', 'refs/remotes/origin/-f', 'HEAD']);
      runGit(projectDir, ['update-ref', 'refs/heads/--detach', 'HEAD']);
      runGit(projectDir, ['config', 'branch.--detach.remote', 'origin']);
      runGit(projectDir, ['config', 'branch.--detach.merge', 'refs/heads/--detach']);
      runGit(projectDir, ['update-ref', 'refs/heads/-f', 'HEAD']);
      runGit(projectDir, ['config', 'branch.-f.remote', 'origin']);
      runGit(projectDir, ['config', 'branch.-f.merge', 'refs/heads/-f']);

      await expect(
        checkoutLocalProjectBranchAtRootPath(projectDir, 'lody:branch:remote:origin:--detach')
      ).resolves.toEqual({ currentBranch: '--detach' });
      expect(runGit(projectDir, ['symbolic-ref', '--short', 'HEAD'])).toBe('--detach');

      runGit(projectDir, ['switch', 'main']);
      await expect(
        checkoutLocalProjectBranchAtRootPathCjs(projectDir, 'lody:branch:remote:origin:-f')
      ).resolves.toEqual({ currentBranch: '-f' });
      expect(runGit(projectDir, ['symbolic-ref', '--short', 'HEAD'])).toBe('-f');
    },
    GIT_HELPER_TEST_TIMEOUT_MS
  );

  it(
    'uses a safe local name when creating tracking state for a leading-dash remote branch',
    async () => {
      tempDir = makeTempDir();
      const projectDir = createGitProjectWithRemotes(tempDir, [
        { name: 'origin', url: path.join(tempDir, 'origin.git') },
      ]);
      runGit(projectDir, ['update-ref', 'refs/remotes/origin/--new-option', 'HEAD']);

      const result = await checkoutLocalProjectBranchAtRootPath(
        projectDir,
        'lody:branch:remote:origin:--new-option'
      );

      expect(result.currentBranch).toMatch(/^lody-remote-/);
      expect(runGit(projectDir, ['symbolic-ref', '--short', 'HEAD'])).toBe(result.currentBranch);
      expect(runGit(projectDir, ['rev-parse', '--abbrev-ref', '@{upstream}'])).toBe(
        'origin/--new-option'
      );
    },
    GIT_HELPER_TEST_TIMEOUT_MS
  );

  it(
    'creates a tracking branch when a local branch blocks the remote namespace',
    async () => {
      tempDir = makeTempDir();
      const projectDir = createGitProjectWithRemotes(tempDir, [
        { name: 'origin', url: path.join(tempDir, 'origin.git') },
        { name: 'upstream', url: path.join(tempDir, 'upstream.git') },
      ]);
      runGit(projectDir, ['update-ref', 'refs/remotes/origin/foo', 'HEAD']);
      runGit(projectDir, ['update-ref', 'refs/remotes/upstream/foo', 'HEAD']);
      runGit(projectDir, ['branch', 'origin']);

      await expect(checkoutLocalProjectBranchAtRootPath(projectDir, 'origin/foo')).resolves.toEqual(
        { currentBranch: 'foo' }
      );
      expect(runGit(projectDir, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/foo');
      expect(runGit(projectDir, ['config', 'branch.foo.remote'])).toBe('origin');
      runGit(projectDir, ['checkout', 'main']);
      await expect(checkoutLocalProjectBranchAtRootPath(projectDir, 'origin/foo')).resolves.toEqual(
        { currentBranch: 'foo' }
      );
      expect(
        runGit(projectDir, ['for-each-ref', '--format=%(refname)', 'refs/heads'])
      ).not.toContain('refs/heads/lody-remote-');

      runGit(projectDir, ['checkout', 'main']);
      runGit(projectDir, ['branch', '-D', 'foo']);
      await expect(
        checkoutLocalProjectBranchAtRootPathCjs(projectDir, 'origin/foo')
      ).resolves.toEqual({ currentBranch: 'foo' });
      expect(runGit(projectDir, ['config', 'branch.foo.remote'])).toBe('origin');
    },
    GIT_HELPER_TEST_TIMEOUT_MS
  );

  it(
    'does not reuse a tracking branch whose commit diverged from the selected remote ref',
    async () => {
      tempDir = makeTempDir();
      const projectDir = createGitProjectWithRemotes(tempDir, [
        { name: 'origin', url: path.join(tempDir, 'origin.git') },
      ]);
      const remoteCommit = runGit(projectDir, ['rev-parse', 'HEAD']);
      runGit(projectDir, ['update-ref', 'refs/remotes/origin/foo', remoteCommit]);
      runGit(projectDir, ['checkout', '--track', '-b', 'foo', 'refs/remotes/origin/foo']);
      fs.writeFileSync(path.join(projectDir, 'ahead.txt'), 'ahead\n', 'utf8');
      runGit(projectDir, ['add', 'ahead.txt']);
      runGit(projectDir, [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-m',
        'ahead',
      ]);
      const aheadCommit = runGit(projectDir, ['rev-parse', 'HEAD']);

      const first = await checkoutLocalProjectBranchAtRootPath(projectDir, 'origin/foo');
      expect(first.currentBranch).toMatch(/^lody-remote-/);
      expect(runGit(projectDir, ['rev-parse', 'HEAD'])).toBe(remoteCommit);
      expect(runGit(projectDir, ['rev-parse', 'foo'])).toBe(aheadCommit);

      runGit(projectDir, ['checkout', 'main']);
      await expect(
        checkoutLocalProjectBranchAtRootPathCjs(projectDir, 'origin/foo')
      ).resolves.toEqual(first);
      expect(runGit(projectDir, ['rev-parse', 'HEAD'])).toBe(remoteCommit);
      expect(
        runGit(projectDir, ['for-each-ref', '--format=%(refname)', 'refs/heads']).match(
          /refs\/heads\/lody-remote-/g
        )
      ).toHaveLength(1);
    },
    GIT_HELPER_TEST_TIMEOUT_MS
  );

  it(
    'does not reuse a tracking branch checked out by another linked worktree',
    async () => {
      tempDir = makeTempDir();
      const projectDir = createGitProjectWithRemotes(tempDir, [
        { name: 'origin', url: path.join(tempDir, 'origin.git') },
      ]);
      const remoteCommit = runGit(projectDir, ['rev-parse', 'HEAD']);
      runGit(projectDir, ['update-ref', 'refs/remotes/origin/foo', remoteCommit]);
      runGit(projectDir, ['checkout', '--track', '-b', 'foo', 'refs/remotes/origin/foo']);
      runGit(projectDir, ['checkout', 'main']);
      const linkedWorktree = path.join(tempDir, 'linked-foo');
      runGit(projectDir, ['worktree', 'add', linkedWorktree, 'foo']);

      const result = await checkoutLocalProjectBranchAtRootPath(
        projectDir,
        'lody:branch:remote:origin:foo'
      );

      expect(result.currentBranch).toMatch(/^lody-remote-/);
      expect(runGit(projectDir, ['rev-parse', 'HEAD'])).toBe(remoteCommit);
      expect(runGit(linkedWorktree, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('foo');
    },
    GIT_HELPER_TEST_TIMEOUT_MS
  );

  it(
    'does not change the current branch when the requested branch is missing',
    async () => {
      tempDir = makeTempDir();
      const projectDir = createGitProjectWithRemotes(tempDir, [
        { name: 'origin', url: path.join(tempDir, 'origin.git') },
      ]);

      await expect(
        checkoutLocalProjectBranchAtRootPath(projectDir, 'feature/missing')
      ).rejects.toThrow('Local project branch not found: feature/missing');
      expect(runGit(projectDir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    },
    GIT_HELPER_TEST_TIMEOUT_MS
  );

  it(
    'rejects revision expressions without changing HEAD',
    async () => {
      tempDir = makeTempDir();
      const projectDir = createGitProjectWithRemotes(tempDir, []);
      runGit(projectDir, ['branch', 'foo']);

      await expect(checkoutLocalProjectBranchAtRootPath(projectDir, 'foo~0')).rejects.toThrow(
        'Local project branch not found: foo~0'
      );
      await expect(
        checkoutLocalProjectBranchAtRootPathCjs(projectDir, 'foo^{commit}')
      ).rejects.toThrow('Local project branch not found: foo^{commit}');
      expect(runGit(projectDir, ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
    },
    GIT_HELPER_TEST_TIMEOUT_MS
  );

  it(
    'reports staged, unstaged, and untracked working tree changes',
    async () => {
      tempDir = makeTempDir();
      const projectDir = path.join(tempDir, 'git-project');
      fs.mkdirSync(projectDir);

      runGit(projectDir, ['init', '-b', 'main']);
      fs.writeFileSync(path.join(projectDir, 'README.md'), '# hello\n', 'utf8');
      runGit(projectDir, ['add', 'README.md']);
      runGit(projectDir, [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-m',
        'init',
      ]);

      fs.writeFileSync(path.join(projectDir, 'README.md'), '# changed\n', 'utf8');
      fs.writeFileSync(path.join(projectDir, 'staged.txt'), 'staged\n', 'utf8');
      runGit(projectDir, ['add', 'staged.txt']);
      fs.writeFileSync(path.join(projectDir, 'untracked.txt'), 'new\n', 'utf8');

      expect(await getLocalProjectWorkingTreeAtRootPath(projectDir)).toEqual({
        clean: false,
        staged: true,
        unstaged: true,
        untracked: true,
        conflicted: false,
      });
    },
    GIT_HELPER_TEST_TIMEOUT_MS
  );

  it(
    'reports conflicted working tree entries',
    async () => {
      tempDir = makeTempDir();
      const projectDir = path.join(tempDir, 'git-project');
      fs.mkdirSync(projectDir);

      runGit(projectDir, ['init', '-b', 'main']);
      fs.writeFileSync(path.join(projectDir, 'README.md'), 'base\n', 'utf8');
      runGit(projectDir, ['add', 'README.md']);
      runGit(projectDir, [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-m',
        'init',
      ]);
      const baseBlob = runGit(projectDir, ['rev-parse', 'HEAD:README.md']);

      runGit(projectDir, ['checkout', '-b', 'feature/conflict']);
      fs.writeFileSync(path.join(projectDir, 'README.md'), 'feature\n', 'utf8');
      runGit(projectDir, ['add', 'README.md']);
      runGit(projectDir, [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-m',
        'feature',
      ]);
      const theirsBlob = runGit(projectDir, ['rev-parse', 'HEAD:README.md']);

      runGit(projectDir, ['checkout', 'main']);
      fs.writeFileSync(path.join(projectDir, 'README.md'), 'main\n', 'utf8');
      runGit(projectDir, ['add', 'README.md']);
      runGit(projectDir, [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-m',
        'main',
      ]);
      const oursBlob = runGit(projectDir, ['rev-parse', 'HEAD:README.md']);
      runGitWithInput(
        projectDir,
        ['update-index', '--index-info'],
        [
          `100644 ${baseBlob} 1\tREADME.md`,
          `100644 ${oursBlob} 2\tREADME.md`,
          `100644 ${theirsBlob} 3\tREADME.md`,
        ].join('\n') + '\n'
      );
      expect(runGit(projectDir, ['status', '--porcelain=v1'])).toContain('UU README.md');

      expect(await getLocalProjectWorkingTreeAtRootPath(projectDir)).toEqual({
        clean: false,
        staged: false,
        unstaged: false,
        untracked: false,
        conflicted: true,
      });
    },
    GIT_HELPER_TEST_TIMEOUT_MS
  );

  it(
    'checks out an existing branch when the working tree is clean',
    async () => {
      tempDir = makeTempDir();
      const projectDir = path.join(tempDir, 'git-project');
      fs.mkdirSync(projectDir);

      runGit(projectDir, ['init', '-b', 'main']);
      fs.writeFileSync(path.join(projectDir, 'README.md'), '# hello\n', 'utf8');
      runGit(projectDir, ['add', 'README.md']);
      runGit(projectDir, [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-m',
        'init',
      ]);
      runGit(projectDir, ['checkout', '-b', 'feature/local-branch']);
      runGit(projectDir, ['checkout', 'main']);

      const checkoutResult = await checkoutLocalProjectBranchAtRootPath(
        projectDir,
        'feature/local-branch'
      );

      expect(checkoutResult.currentBranch).toBe('feature/local-branch');

      const gitState = await getLocalProjectGitStateAtRootPath(projectDir);
      expect(gitState.git).toBe(true);
      if (gitState.git) {
        expect(gitState.currentBranch).toBe('feature/local-branch');
      }
    },
    GIT_HELPER_TEST_TIMEOUT_MS
  );

  it(
    'blocks checkout when the working tree is dirty',
    async () => {
      tempDir = makeTempDir();
      const projectDir = path.join(tempDir, 'git-project');
      fs.mkdirSync(projectDir);

      runGit(projectDir, ['init', '-b', 'main']);
      fs.writeFileSync(path.join(projectDir, 'README.md'), '# hello\n', 'utf8');
      runGit(projectDir, ['add', 'README.md']);
      runGit(projectDir, [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-m',
        'init',
      ]);
      runGit(projectDir, ['checkout', '-b', 'feature/local-branch']);
      runGit(projectDir, ['checkout', 'main']);
      fs.writeFileSync(path.join(projectDir, 'untracked.txt'), 'new\n', 'utf8');

      await expect(
        checkoutLocalProjectBranchAtRootPath(projectDir, 'feature/local-branch')
      ).rejects.toThrow(/Cannot switch branches with local changes/);
    },
    GIT_HELPER_TEST_TIMEOUT_MS
  );

  it(
    'reports remote branches and default branch for non-origin remotes',
    async () => {
      tempDir = makeTempDir();
      const projectDir = createClonedProjectWithUpstreamRemote(tempDir);

      const gitState = await getLocalProjectGitStateAtRootPath(projectDir);

      expect(gitState.git).toBe(true);
      if (gitState.git) {
        expect(gitState.currentBranch).toBe('lody:branch:local:main');
        expect(gitState.defaultBranch).toBe('lody:branch:local:main');
        expect(gitState.branches).toContain('lody:branch:local:main');
        expect(gitState.branches).toContain('feature/remote-branch');
      }
    },
    // The setup chains real git clone/fetch operations. On the self-hosted CI
    // runner, this file can execute under enough package-level test load that
    // git subprocesses exceed the default Vitest budget.
    GIT_HELPER_TEST_TIMEOUT_MS
  );

  it(
    'reports github repo from origin remote first',
    async () => {
      tempDir = makeTempDir();
      const projectDir = createGitProjectWithRemotes(tempDir, [
        { name: 'origin', url: 'git@github.com:loro-dev/lody.git' },
        { name: 'upstream', url: 'https://github.com/example/ignored.git' },
      ]);

      const gitState = await getLocalProjectGitStateAtRootPath(projectDir);
      expect(gitState.git).toBe(true);
      if (gitState.git) {
        expect(gitState.githubRepoFullName).toBe('loro-dev/lody');
      }
    },
    GIT_HELPER_TEST_TIMEOUT_MS
  );

  it(
    'loads the cjs helper and resolves github remotes',
    async () => {
      tempDir = makeTempDir();
      const projectDir = createGitProjectWithRemotes(tempDir, [
        { name: 'origin', url: 'git@github.com:loro-dev/lody.git' },
      ]);

      expect(await getLocalProjectGitStateAtRootPathCjs(projectDir)).toMatchObject({
        git: true,
        githubRepoFullName: 'loro-dev/lody',
      });
    },
    GIT_HELPER_TEST_TIMEOUT_MS
  );

  it(
    'uses the current branch remote when origin is not github',
    async () => {
      tempDir = makeTempDir();
      const projectDir = createGitProjectWithRemotes(tempDir, [
        { name: 'origin', url: 'ssh://git@example.internal/repo.git' },
        { name: 'mirror', url: 'https://github.com/loro-dev/lody.git' },
      ]);
      runGit(projectDir, ['config', 'branch.main.remote', 'mirror']);

      const gitState = await getLocalProjectGitStateAtRootPath(projectDir);
      expect(gitState.git).toBe(true);
      if (gitState.git) {
        expect(gitState.githubRepoFullName).toBe('loro-dev/lody');
      }
    },
    GIT_HELPER_TEST_TIMEOUT_MS
  );
});
