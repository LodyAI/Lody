import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Cause, Deferred, Effect, Exit, Layer, Option } from 'effect';

import { FakeProcessTable } from '../src/node/process-testing';
import { processLayer } from '../src/node/process';

import {
  createLocalProjectId,
  normalizeLocalProjectRootPath,
  checkoutLocalProjectBranchAtRootPath,
  localProjectLayer,
  LocalProjectHost,
  LocalProjectPaths,
  LocalProjectsLive,
  getLocalProjectGitStateAtRootPath,
  localProjectsLegacy,
} from '../src/node/local-project';

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
  beforeEach(() => {
    // Keep fixture URLs and repository selection independent of host Git rewrites.
    for (const key of Object.keys(process.env)) {
      if (/^(GIT_|SSH_|LODY_GIT_)/.test(key)) vi.stubEnv(key, undefined);
    }
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_CONFIG_GLOBAL', os.devNull);
  });
  afterEach(() => vi.unstubAllEnvs());

  let tempDir: string | null = null;

  afterEach(() => {
    if (!tempDir) return;
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it.skipIf(process.platform === 'win32')(
    'native and synchronous identity share symlink canonicalization',
    async () => {
      tempDir = makeTempDir();
      const root = path.join(tempDir, 'project');
      const alias = path.join(tempDir, 'alias');
      fs.mkdirSync(root);
      fs.symlinkSync(root, alias);
      const actual = await Effect.runPromise(
        Effect.gen(function* () {
          return {
            root: yield* normalizeLocalProjectRootPath(alias + path.sep),
            id: yield* createLocalProjectId(alias),
          };
        }).pipe(Effect.provide(localProjectLayer))
      );
      expect(actual).toEqual({
        root: localProjectsLegacy.normalizeLocalProjectRootPath(root),
        id: localProjectsLegacy.createLocalProjectId(root),
      });
    }
  );

  it('reports corrupt Git metadata as failure rather than a non-Git directory', async () => {
    tempDir = makeTempDir();
    const root = createGitProjectWithRemotes(tempDir, []);
    fs.writeFileSync(path.join(root, '.git', 'config'), '[broken');
    await expect(localProjectsLegacy.getLocalProjectGitStateAtRootPath(root)).rejects.toMatchObject(
      { _tag: 'LocalProjectGitError' }
    );
  });

  it('keeps a bare repository outside local-project worktree capabilities', async () => {
    tempDir = makeTempDir();
    runGit(tempDir, ['init', '--bare']);
    expect(await localProjectsLegacy.getLocalProjectGitStateAtRootPath(tempDir)).toEqual({
      git: false,
    });
  });

  it(
    'reports an initialized repository with no commits as git with no branches',
    async () => {
      tempDir = makeTempDir();
      runGit(tempDir, ['init', '-b', 'main']);

      const gitState = await localProjectsLegacy.getLocalProjectGitStateAtRootPath(tempDir);

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

      expect(await localProjectsLegacy.getLocalProjectGitStateAtRootPath(projectDir)).toEqual({
        git: false,
      });
    },
    GIT_HELPER_TEST_TIMEOUT_MS
  );

  it(
    'rejects missing branches instead of falling back to HEAD',
    async () => {
      tempDir = makeTempDir();
      const projectDir = createClonedProjectWithUpstreamRemote(tempDir);

      await expect(
        localProjectsLegacy.resolveLocalProjectBranchAtRootPath(projectDir, 'feature/missing')
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
      await expect(
        localProjectsLegacy.resolveLocalProjectBranchAtRootPath(projectDir, 'foo')
      ).rejects.toThrow(expectedMessage);
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
      await expect(
        localProjectsLegacy.getLocalProjectGitStateAtRootPath(projectDir)
      ).resolves.toMatchObject(expectedState);
      await expect(
        localProjectsLegacy.resolveLocalProjectBranchAtRootPath(
          projectDir,
          'lody:branch:local:main'
        )
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
        localProjectsLegacy.resolveLocalProjectBranchRefAtRootPath(projectDir, 'refs/heads/main')
      ).resolves.toMatchObject({ kind: 'local', refName: 'refs/heads/main' });
      await expect(
        localProjectsLegacy.resolveLocalProjectBranchRefAtRootPath(
          projectDir,
          'refs/remotes/upstream/feature/remote-branch'
        )
      ).resolves.toMatchObject({
        kind: 'remote',
        refName: 'refs/remotes/upstream/feature/remote-branch',
      });
      await expect(
        localProjectsLegacy.resolveLocalProjectBranchRefAtRootPath(projectDir, 'refs/heads/main~1')
      ).rejects.toThrow('Local project branch ref not found: refs/heads/main~1');

      runGit(projectDir, ['update-ref', '-d', 'refs/remotes/upstream/feature/remote-branch']);
      await expect(
        localProjectsLegacy.parseLocalProjectBranchRefAtRootPath(
          projectDir,
          'refs/remotes/upstream/feature/remote-branch'
        )
      ).resolves.toMatchObject({
        kind: 'remote',
        refName: 'refs/remotes/upstream/feature/remote-branch',
      });
      await expect(
        localProjectsLegacy.resolveLocalProjectBranchRefAtRootPath(
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
        localProjectsLegacy.resolveLocalProjectLegacyBaseBranchAtRootPath(projectDir, 'foo')
      ).resolves.toMatchObject({
        kind: 'remote',
        refName: 'refs/remotes/origin/foo',
        commitHash: remoteCommit,
      });

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
        localProjectsLegacy.resolveLocalProjectLegacyBaseBranchAtRootPath(projectDir, 'foo')
      ).resolves.toMatchObject({
        kind: 'remote',
        refName: 'refs/remotes/origin/foo',
        commitHash: remoteCommit,
      });
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
          localProjectsLegacy.resolveLocalProjectLegacyBaseBranchAtRootPath(
            projectDir,
            'master',
            options
          )
        ).resolves.toMatchObject(expected);
      }

      // The strict selector contract is unchanged: only the legacy/human paths
      // fall back to Git's local-first precedence.
      await expect(
        localProjectsLegacy.resolveLocalProjectBranchAtRootPath(projectDir, 'master')
      ).rejects.toThrow('Local project branch is ambiguous: master');
      await expect(
        localProjectsLegacy.resolveLocalProjectBranchAtRootPath(projectDir, 'master', {
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
        localProjectsLegacy.resolveLocalProjectLegacyBaseBranchAtRootPath(projectDir, 'main', {
          useWorktree: true,
        })
      ).resolves.toMatchObject(worktreeExpected);

      // Checkout mode still recovers the upstream, because there the local
      // branch may be the session's own work branch.
      const checkoutExpected = {
        kind: 'remote',
        refName: 'refs/remotes/origin/main',
        commitHash: remoteCommit,
      };
      await expect(
        localProjectsLegacy.resolveLocalProjectLegacyBaseBranchAtRootPath(projectDir, 'main')
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
          localProjectsLegacy.resolveLocalProjectLegacyBaseBranchAtRootPath(
            projectDir,
            'release',
            options
          )
        ).rejects.toThrow(expectedMessage);
      }
    },
    GIT_HELPER_TEST_TIMEOUT_MS
  );

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

      const gitState = await localProjectsLegacy.getLocalProjectGitStateAtRootPath(projectDir);
      expect(gitState).toMatchObject({
        git: true,
        branches: expect.arrayContaining(['origin/feature/shared', 'upstream/feature/shared']),
      });
      if (gitState.git) {
        expect(gitState.branches).not.toContain('feature/shared');
      }

      await expect(
        localProjectsLegacy.resolveLocalProjectBranchAtRootPath(projectDir, 'origin/feature/shared')
      ).resolves.toMatchObject({ refName: 'refs/remotes/origin/feature/shared' });
      await expect(
        localProjectsLegacy.resolveLocalProjectBranchAtRootPath(projectDir, 'feature/shared')
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

      const gitState = await localProjectsLegacy.getLocalProjectGitStateAtRootPath(projectDir);
      expect(gitState).toMatchObject({
        git: true,
        branches: expect.arrayContaining([
          'lody:branch:local:origin%2Ffoo',
          'lody:branch:remote:origin:foo',
          'upstream/foo',
        ]),
      });

      await expect(
        localProjectsLegacy.resolveLocalProjectBranchAtRootPath(projectDir, 'origin/foo')
      ).rejects.toThrow(
        'Local project branch is ambiguous: origin/foo. Matches: refs/heads/origin/foo, refs/remotes/origin/foo'
      );
      await expect(
        localProjectsLegacy.resolveLocalProjectBranchAtRootPath(
          projectDir,
          'lody:branch:local:origin%2Ffoo'
        )
      ).resolves.toMatchObject({ kind: 'local', commitHash: localCommit });
      await expect(
        localProjectsLegacy.resolveLocalProjectBranchAtRootPath(
          projectDir,
          'lody:branch:remote:origin:foo'
        )
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

      const gitState = await localProjectsLegacy.getLocalProjectGitStateAtRootPath(projectDir);
      expect(gitState).toMatchObject({
        git: true,
        branches: expect.arrayContaining(['foo', 'refs/heads/foo']),
      });
      await expect(
        localProjectsLegacy.resolveLocalProjectBranchAtRootPath(projectDir, 'refs/heads/foo')
      ).resolves.toMatchObject({
        kind: 'local',
        refName: 'refs/heads/refs/heads/foo',
        commitHash: namespaceCommit,
      });

      runGit(projectDir, ['switch', 'main']);
      await expect(
        localProjectsLegacy.checkoutLocalProjectBranchAtRootPath(projectDir, 'refs/heads/foo')
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

      const gitState = await localProjectsLegacy.getLocalProjectGitStateAtRootPath(projectDir);
      expect(gitState).toMatchObject({
        git: true,
        branches: expect.arrayContaining(['upstream/origin/feature']),
      });
      await expect(
        localProjectsLegacy.resolveLocalProjectBranchAtRootPath(
          projectDir,
          'upstream/origin/feature'
        )
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

      const gitState = await localProjectsLegacy.getLocalProjectGitStateAtRootPath(projectDir);
      expect(gitState).toMatchObject({ git: true, branches: expect.arrayContaining(['feature']) });
      await expect(
        localProjectsLegacy.resolveLocalProjectBranchAtRootPath(projectDir, 'feature')
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
        localProjectsLegacy.checkoutLocalProjectBranchAtRootPath(
          projectDir,
          'origin/feature/shared'
        )
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
        localProjectsLegacy.checkoutLocalProjectBranchAtRootPath(
          projectDir,
          'lody:branch:local:--detach'
        )
      ).resolves.toEqual({ currentBranch: '--detach' });
      expect(runGit(projectDir, ['symbolic-ref', '--short', 'HEAD'])).toBe('--detach');

      runGit(projectDir, ['switch', 'main']);
      await expect(
        localProjectsLegacy.checkoutLocalProjectBranchAtRootPath(projectDir, 'lody:branch:local:-f')
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
        localProjectsLegacy.checkoutLocalProjectBranchAtRootPath(
          projectDir,
          'lody:branch:remote:origin:--detach'
        )
      ).resolves.toEqual({ currentBranch: '--detach' });
      expect(runGit(projectDir, ['symbolic-ref', '--short', 'HEAD'])).toBe('--detach');

      runGit(projectDir, ['switch', 'main']);
      await expect(
        localProjectsLegacy.checkoutLocalProjectBranchAtRootPath(
          projectDir,
          'lody:branch:remote:origin:-f'
        )
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

      const result = await localProjectsLegacy.checkoutLocalProjectBranchAtRootPath(
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

      await expect(
        localProjectsLegacy.checkoutLocalProjectBranchAtRootPath(projectDir, 'origin/foo')
      ).resolves.toEqual({ currentBranch: 'foo' });
      expect(runGit(projectDir, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/foo');
      expect(runGit(projectDir, ['config', 'branch.foo.remote'])).toBe('origin');
      runGit(projectDir, ['checkout', 'main']);
      await expect(
        localProjectsLegacy.checkoutLocalProjectBranchAtRootPath(projectDir, 'origin/foo')
      ).resolves.toEqual({ currentBranch: 'foo' });
      expect(
        runGit(projectDir, ['for-each-ref', '--format=%(refname)', 'refs/heads'])
      ).not.toContain('refs/heads/lody-remote-');

      runGit(projectDir, ['checkout', 'main']);
      runGit(projectDir, ['branch', '-D', 'foo']);
      await expect(
        localProjectsLegacy.checkoutLocalProjectBranchAtRootPath(projectDir, 'origin/foo')
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

      const first = await localProjectsLegacy.checkoutLocalProjectBranchAtRootPath(
        projectDir,
        'origin/foo'
      );
      expect(first.currentBranch).toMatch(/^lody-remote-/);
      expect(runGit(projectDir, ['rev-parse', 'HEAD'])).toBe(remoteCommit);
      expect(runGit(projectDir, ['rev-parse', 'foo'])).toBe(aheadCommit);

      runGit(projectDir, ['checkout', 'main']);
      await expect(
        localProjectsLegacy.checkoutLocalProjectBranchAtRootPath(projectDir, 'origin/foo')
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

      const result = await localProjectsLegacy.checkoutLocalProjectBranchAtRootPath(
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
        localProjectsLegacy.checkoutLocalProjectBranchAtRootPath(projectDir, 'feature/missing')
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

      await expect(
        localProjectsLegacy.checkoutLocalProjectBranchAtRootPath(projectDir, 'foo~0')
      ).rejects.toThrow('Local project branch not found: foo~0');
      await expect(
        localProjectsLegacy.checkoutLocalProjectBranchAtRootPath(projectDir, 'foo^{commit}')
      ).rejects.toThrow('Local project branch not found: foo^{commit}');
      expect(runGit(projectDir, ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
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
        localProjectsLegacy.checkoutLocalProjectBranchAtRootPath(projectDir, 'feature/local-branch')
      ).rejects.toThrow(/Cannot switch branches with local changes/);
    },
    GIT_HELPER_TEST_TIMEOUT_MS
  );

  it(
    'reports remote branches and default branch for non-origin remotes',
    async () => {
      tempDir = makeTempDir();
      const projectDir = createClonedProjectWithUpstreamRemote(tempDir);

      const gitState = await localProjectsLegacy.getLocalProjectGitStateAtRootPath(projectDir);

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

      const gitState = await localProjectsLegacy.getLocalProjectGitStateAtRootPath(projectDir);
      expect(gitState.git).toBe(true);
      if (gitState.git) {
        expect(gitState.githubRepoFullName).toBe('loro-dev/lody');
        expect(await localProjectsLegacy.getLocalProjectGitHubRepoAtRootPath(projectDir)).toBe(
          'loro-dev/lody'
        );
      }
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

      const gitState = await localProjectsLegacy.getLocalProjectGitStateAtRootPath(projectDir);
      expect(gitState.git).toBe(true);
      if (gitState.git) {
        expect(gitState.githubRepoFullName).toBe('loro-dev/lody');
      }
    },
    GIT_HELPER_TEST_TIMEOUT_MS
  );
});
