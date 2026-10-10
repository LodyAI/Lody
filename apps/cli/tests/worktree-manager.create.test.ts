import { describe, expect, it } from 'vitest';
import { it as effectIt } from '@effect/vitest';
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Layer, PlatformError } from 'effect';
import { NodeFileSystem } from '@effect/platform-node-shared';
import { TestClock } from 'effect/testing';
import { RepoId } from '@lody/shared';
import { createLogger } from '../src/utils/logger';
import { LodyDataDirUnavailableError } from '@lody/shared/node/installation-profile';
import { WorktreeGit, WorktreeGitCommandFailed, WorktreeGitExecutionFailed } from '../src/session/worktree/git-execution';
import { LocalWorktreePreparation, LocalWorktreePreparationLive, LocalWorktreeScratchReleaseFailed, LOCAL_WORKTREE_SCRATCH_RELEASE_MS } from '../src/session/worktree/local-worktree-preparation';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { SessionId } from '@lody/shared';
import {
  buildGitHubCredentialConfigArgs,
  WorktreeManager,
} from '../src/session/worktree/worktree-manager';
import {
  createLocalRepo,
  createRemoteRepo,
  gitCommit,
  runGit,
  toFileUrl,
  useWorktreeManagerTestFixture,
} from './worktree-manager-test-helpers';

describe('WorktreeManager', () => {
  let testDir: string;
  let manager: WorktreeManager;

  useWorktreeManagerTestFixture((fixture) => {
    ({ testDir, manager } = fixture);
  });

  describe('ensureRepo', () => {
    it('should create a bare repository when no repoUrl is provided', async () => {
      await manager.ensureRepo();

      // @ts-expect-error - accessing private property for testing
      expect(fs.existsSync(manager.bareGitDir)).toBe(true);

      // @ts-expect-error - accessing private property for testing
      const gitDir = manager.bareGitDir;
      const isGitRepo = fs.existsSync(path.join(gitDir, 'HEAD'));
      expect(isGitRepo).toBe(true);
    });

    it('should create worktrees and cache directories', async () => {
      await manager.ensureRepo();

      // @ts-expect-error - accessing private property for testing
      expect(fs.existsSync(manager.worktreesDir)).toBe(true);
      // @ts-expect-error - accessing private property for testing
      expect(fs.existsSync(manager.cacheDir)).toBe(true);
    });

    it('should be idempotent', async () => {
      await manager.ensureRepo();
      await manager.ensureRepo();

      // @ts-expect-error - accessing private property for testing
      expect(fs.existsSync(manager.bareGitDir)).toBe(true);
    });

    it('preserves existing metadata on repeated local-source preparation', async () => {
      const sourceDir = createLocalRepo(testDir);
      manager.updateSource({ kind: 'local-shared', originalRootPath: sourceDir, sourceGitDir: '.git' });
      await manager.ensureRepo();
      // @ts-expect-error - inspect the persisted boundary
      const metaPath = path.join(manager.repoDir, 'meta.json');
      const first = fs.readFileSync(metaPath, 'utf8');
      expect(JSON.parse(first)).toMatchObject({ sourceGitDir: '.git', originalRootPath: sourceDir });
      await manager.ensureRepo();
      expect(fs.readFileSync(metaPath, 'utf8')).toBe(first);
      expect(fs.readFileSync(path.join(sourceDir, 'README.md'), 'utf8')).toBe('# local\n');
      expect(fs.readdirSync(path.dirname(metaPath)).some(name => name.startsWith('.lody-source-'))).toBe(false);
    });

    it('rejects an unavailable local source without publishing metadata', async () => {
      manager.updateSource({ kind: 'local-shared', originalRootPath: path.join(testDir, 'missing-source') });
      await expect(manager.ensureRepo()).rejects.toThrow(/Local worktree source is missing/);
      // @ts-expect-error - inspect the persisted boundary
      expect(fs.existsSync(path.join(manager.repoDir, 'meta.json'))).toBe(false);
      const sourceDir = createLocalRepo(testDir);
      manager.updateSource({ kind: 'local-shared', originalRootPath: sourceDir });
      await manager.ensureRepo();
      // @ts-expect-error - inspect the persisted boundary
      expect(JSON.parse(fs.readFileSync(path.join(manager.repoDir, 'meta.json'), 'utf8'))).toMatchObject({ originalRootPath: sourceDir });
    });

    it('should prepare a shared local source without creating a bare clone', async () => {
      const sourceDir = createLocalRepo(testDir);
      manager.updateSource({
        kind: 'local-shared',
        originalRootPath: sourceDir,
      });

      await manager.ensureRepo();

      // @ts-expect-error - accessing private property for testing
      expect(fs.existsSync(manager.bareGitDir)).toBe(false);
      // @ts-expect-error - accessing private property for testing
      const metaPath = path.join(manager.repoDir, 'meta.json');
      expect(JSON.parse(fs.readFileSync(metaPath, 'utf8'))).toMatchObject({
        kind: 'local',
        originalRootPath: sourceDir,
      });
    });
  });

  describe('git credential config', () => {
    it.each([
      ['github.com', 'managed', 'owner/repo.git'],
      ['git.example.com', 'native', undefined],
    ])('isolates the GitHub helper from native credentials for %s', (host, username, repoPath) => {
      const helper = (identity: string) =>
        `!f() { printf 'username=${identity}\\npassword=synthetic-test-token\\n'; }; f`;
      const output = execFileSync(
        'git',
        [
          '-c',
          'credential.helper=',
          '-c',
          `credential.helper=${helper('native')}`,
          ...buildGitHubCredentialConfigArgs(helper('managed')),
          'credential',
          'fill',
        ],
        {
          cwd: testDir,
          encoding: 'utf8',
          input: `protocol=https\nhost=${host}\npath=owner/repo.git\n\n`,
          env: {
            ...process.env,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: path.join(testDir, 'unused-gitconfig'),
            GIT_CONFIG_COUNT: '0',
            GIT_TERMINAL_PROMPT: '0',
          },
        }
      );
      const credential = Object.fromEntries(
        output
          .trim()
          .split('\n')
          .map((line) => line.split('='))
      );
      expect(credential).toMatchObject({ protocol: 'https', host, username });
      expect(credential.path).toBe(repoPath);
    });
  });

  describe('createWorktree', () => {
    it('should create a worktree for a session', async () => {
      await manager.ensureRepo();

      const sessionId = 'a1b2c3d4-session-1' as SessionId;
      const info = await manager.createWorktree(sessionId);

      expect(info.sessionId).toBe(sessionId);
      expect(info.branch).toBe(`session/${sessionId.slice(0, 8)}`);
      expect(fs.existsSync(info.hostPath)).toBe(true);
    });

    it('should rewrite .git gitdir to a relative path', async () => {
      await manager.ensureRepo();

      const sessionId = 'gitdir01-session-gitdir' as SessionId;
      const info = await manager.createWorktree(sessionId);
      const gitFile = fs.readFileSync(path.join(info.hostPath, '.git'), 'utf8');
      expect(gitFile).toMatch(/^gitdir:\s*\.\./m);
      expect(gitFile).not.toMatch(/^gitdir:\s*\//m);
    });

    it('should reject unsafe session ids', async () => {
      await manager.ensureRepo();
      await expect(manager.createWorktree('../evil' as SessionId)).rejects.toThrow(
        /Invalid sessionId/
      );
      await expect(manager.createWorktree('session/evil' as SessionId)).rejects.toThrow(
        /Invalid sessionId/
      );
    });

    it('should be idempotent', async () => {
      await manager.ensureRepo();

      const sessionId = 'idempt02-session-2' as SessionId;
      const info1 = await manager.createWorktree(sessionId);
      const info2 = await manager.createWorktree(sessionId);

      expect(info1.hostPath).toBe(info2.hostPath);
      expect(info1.branch).toBe(info2.branch);
    });

    it('should rebuild a missing registered worktree without reusing its old branch', async () => {
      const sourceDir = createLocalRepo(testDir);
      manager.updateSource({ kind: 'local-shared', originalRootPath: sourceDir });
      const sessionId = 'staleadd-session-worktree' as SessionId;
      const first = await manager.createWorktree(sessionId);

      // Model a worktree directory disappearing before Git's registration is pruned.
      fs.rmSync(first.hostPath, { recursive: true, force: true });

      const rebuilt = await manager.createWorktree(sessionId);

      expect(rebuilt.branch).toBe(`${first.branch}-2`);
      expect(fs.existsSync(rebuilt.hostPath)).toBe(true);
    });

    it('should create multiple worktrees', async () => {
      await manager.ensureRepo();

      const session1 = 'multi0aa-session-a' as SessionId;
      const session2 = 'multi0bb-session-b' as SessionId;

      const info1 = await manager.createWorktree(session1);
      const info2 = await manager.createWorktree(session2);

      expect(info1.hostPath).not.toBe(info2.hostPath);
      expect(fs.existsSync(info1.hostPath)).toBe(true);
      expect(fs.existsSync(info2.hostPath)).toBe(true);
    });

    it('should fetch origin/main and base new worktrees on latest commit', async () => {
      const { sourceDir, remoteBareDir } = createRemoteRepo(testDir, 'main');
      manager.updateRepoUrl(toFileUrl(remoteBareDir));

      await manager.ensureRepo();
      const initial = runGit(sourceDir, ['rev-parse', 'HEAD']);

      fs.writeFileSync(path.join(sourceDir, 'change.txt'), 'v2\n', 'utf8');
      const latest = gitCommit(sourceDir, 'update');
      runGit(sourceDir, ['push']);

      const sessionId = 'rmain002-remote-main-2' as SessionId;
      const info = await manager.createWorktree(sessionId);
      expect(info.headSha).toBe(latest);
      expect(info.headSha).not.toBe(initial);
    });

    it('should fall back to origin/master when origin/main does not exist', async () => {
      const { sourceDir, remoteBareDir } = createRemoteRepo(testDir, 'master');
      manager.updateRepoUrl(toFileUrl(remoteBareDir));

      const latest = runGit(sourceDir, ['rev-parse', 'HEAD']);
      const sessionId = 'rmaster1-remote-master-1' as SessionId;
      const info = await manager.createWorktree(sessionId);
      expect(info.headSha).toBe(latest);
    });

    it('should handle empty remote repo by creating initial commit', async () => {
      const remoteBareDir = path.join(testDir, 'remote-empty.git');
      runGit(testDir, ['init', '--bare', remoteBareDir]);

      manager.updateRepoUrl(toFileUrl(remoteBareDir));

      const sessionId = 'rempty01-remote-empty-1' as SessionId;
      const info = await manager.createWorktree(sessionId);

      expect(info.sessionId).toBe(sessionId);
      expect(info.branch).toBe(`session/${sessionId.slice(0, 8)}`);
      expect(fs.existsSync(info.hostPath)).toBe(true);
      expect(info.headSha).not.toBeNull();
    });

    it('should create a session branch based on the specified common branch', async () => {
      const { sourceDir, remoteBareDir } = createRemoteRepo(testDir, 'main');
      manager.updateRepoUrl(toFileUrl(remoteBareDir));

      runGit(sourceDir, ['checkout', '-b', 'develop']);
      fs.writeFileSync(path.join(sourceDir, 'develop.txt'), 'develop\n', 'utf8');
      const developHead = gitCommit(sourceDir, 'develop');
      runGit(sourceDir, ['push', '-u', 'origin', 'develop']);
      runGit(sourceDir, ['checkout', 'main']);

      const sessionId = 'rbranch01-remote-develop-1' as SessionId;
      const info = await manager.createWorktree(sessionId, 'develop');
      expect(info.headSha).toBe(developHead);
      expect(info.branch).toBe(`session/${sessionId.slice(0, 8)}`);
    });

    it('should create a fresh session branch from a specified non-default base', async () => {
      const { sourceDir, remoteBareDir } = createRemoteRepo(testDir, 'main');
      manager.updateRepoUrl(toFileUrl(remoteBareDir));

      runGit(sourceDir, ['checkout', '-b', 'feature/reuse-existing-branch']);
      fs.writeFileSync(path.join(sourceDir, 'feature.txt'), 'feature\n', 'utf8');
      const featureHead = gitCommit(sourceDir, 'feature');
      runGit(sourceDir, ['push', '-u', 'origin', 'feature/reuse-existing-branch']);
      runGit(sourceDir, ['checkout', 'main']);

      const sessionId = 'rbranch02-remote-feature-1' as SessionId;
      const info = await manager.createWorktree(sessionId, 'feature/reuse-existing-branch');
      expect(info.headSha).toBe(featureHead);
      expect(info.branch).toBe(`session/${sessionId.slice(0, 8)}`);
      expect(info.branch).not.toBe('feature/reuse-existing-branch');
    });

    it('should suffix a stale generated session branch even when a tag shares its name', async () => {
      await manager.ensureRepo();
      const sessionId = 'collision-session-branch' as SessionId;
      const staleBranch = `session/${sessionId.slice(0, 8)}`;
      // @ts-expect-error - accessing private property for testing
      runGit(manager.bareGitDir, ['branch', staleBranch, 'main']);
      // @ts-expect-error - accessing private property for testing
      runGit(manager.bareGitDir, ['tag', staleBranch, 'main']);

      const info = await manager.createWorktree(sessionId);

      expect(info.branch).toBe(`${staleBranch}-2`);
      // @ts-expect-error - accessing private property for testing
      expect(
        runGit(manager.bareGitDir, ['show-ref', '--verify', `refs/heads/${staleBranch}`])
      ).toContain(`refs/heads/${staleBranch}`);
    });

    it('should create a shared-local worktree on a lody session branch', async () => {
      const sourceDir = createLocalRepo(testDir);
      manager.updateSource({
        kind: 'local-shared',
        originalRootPath: sourceDir,
      });

      const sessionId = 'local001-session-worktree' as SessionId;
      const info = await manager.createWorktree(sessionId);

      expect(info.branch).toBe('lody/local001-ses');
      expect(fs.existsSync(info.hostPath)).toBe(true);
      expect(runGit(info.hostPath, ['rev-parse', '--show-toplevel'])).toBe(info.hostPath);
      expect(runGit(sourceDir, ['worktree', 'list'])).toContain(info.hostPath);
    });

    it('should suffix a stale generated shared-local branch instead of restoring it', async () => {
      const sourceDir = createLocalRepo(testDir);
      manager.updateSource({
        kind: 'local-shared',
        originalRootPath: sourceDir,
      });
      const sessionId = 'local007-session-collision' as SessionId;
      const staleBranch = 'lody/local007-ses';
      runGit(sourceDir, ['branch', staleBranch]);

      const info = await manager.createWorktree(sessionId);

      expect(info.branch).toBe(`${staleBranch}-2`);
      expect(runGit(sourceDir, ['show-ref', '--verify', `refs/heads/${staleBranch}`])).toContain(
        `refs/heads/${staleBranch}`
      );
    });

    it('should create from the captured commit even after the source HEAD advances', async () => {
      const sourceDir = createLocalRepo(testDir);
      const capturedHead = runGit(sourceDir, ['rev-parse', 'HEAD']);
      fs.writeFileSync(path.join(sourceDir, 'later.txt'), 'later\n', 'utf8');
      const laterHead = gitCommit(sourceDir, 'later source commit');
      manager.updateSource({ kind: 'local-shared', originalRootPath: sourceDir });

      const info = await manager.createWorktree(
        'forkhead-session-worktree' as SessionId,
        undefined,
        undefined,
        capturedHead
      );

      expect(info.headSha).toBe(capturedHead);
      expect(info.headSha).not.toBe(laterHead);
    });

    it('should reject an existing target worktree at a different captured commit', async () => {
      const sourceDir = createLocalRepo(testDir);
      const capturedHead = runGit(sourceDir, ['rev-parse', 'HEAD']);
      fs.writeFileSync(path.join(sourceDir, 'later.txt'), 'later\n', 'utf8');
      const laterHead = gitCommit(sourceDir, 'later source commit');
      manager.updateSource({ kind: 'local-shared', originalRootPath: sourceDir });
      const sessionId = 'forkmismatch-session' as SessionId;
      await manager.createWorktree(sessionId, undefined, undefined, laterHead);

      await expect(
        manager.createWorktree(sessionId, undefined, undefined, capturedHead)
      ).rejects.toThrow(/does not match captured fork HEAD/);
    });

    it('should base a shared-local worktree on an exact remote ref', async () => {
      const { sourceDir } = createRemoteRepo(testDir, 'main');
      runGit(sourceDir, ['checkout', '-b', 'feature/remote-only']);
      fs.writeFileSync(path.join(sourceDir, 'remote-only.txt'), 'remote only\n', 'utf8');
      const featureHead = gitCommit(sourceDir, 'remote only');
      runGit(sourceDir, ['push', '-u', 'origin', 'feature/remote-only']);
      runGit(sourceDir, ['checkout', 'main']);
      runGit(sourceDir, ['branch', '-D', 'feature/remote-only']);
      manager.updateSource({
        kind: 'local-shared',
        originalRootPath: sourceDir,
      });

      const info = await manager.createWorktree(
        'local002-remote-ref' as SessionId,
        'refs/remotes/origin/feature/remote-only'
      );

      expect(info.headSha).toBe(featureHead);
    });

    it('should resolve a unique remote-only branch when restoring a shared-local worktree', async () => {
      const { sourceDir } = createRemoteRepo(testDir, 'main');
      runGit(sourceDir, ['checkout', '-b', 'feature/remote-only']);
      fs.writeFileSync(path.join(sourceDir, 'remote-only.txt'), 'remote only\n', 'utf8');
      const featureHead = gitCommit(sourceDir, 'remote only');
      runGit(sourceDir, ['push', '-u', 'origin', 'feature/remote-only']);
      runGit(sourceDir, ['checkout', 'main']);
      runGit(sourceDir, ['branch', '-D', 'feature/remote-only']);
      manager.updateSource({
        kind: 'local-shared',
        originalRootPath: sourceDir,
      });

      const info = await manager.createWorktree(
        'local004-remote-short' as SessionId,
        'feature/remote-only'
      );

      expect(info.headSha).toBe(featureHead);
    });

    it('should reject an explicit missing shared-local base instead of using HEAD', async () => {
      const sourceDir = createLocalRepo(testDir);
      manager.updateSource({
        kind: 'local-shared',
        originalRootPath: sourceDir,
      });

      await expect(
        manager.createWorktree('local003-missing-base' as SessionId, 'refs/heads/missing')
      ).rejects.toThrow('Local project branch not found: refs/heads/missing');
    });

    it('should resolve a local branch exactly when a tag has the same name', async () => {
      const sourceDir = createLocalRepo(testDir);
      const oldHead = runGit(sourceDir, ['rev-parse', 'HEAD']);
      fs.writeFileSync(path.join(sourceDir, 'new-head.txt'), 'new head\n', 'utf8');
      const branchHead = gitCommit(sourceDir, 'new branch head');
      runGit(sourceDir, ['tag', 'main', oldHead]);
      manager.updateSource({ kind: 'local-shared', originalRootPath: sourceDir });

      const info = await manager.createWorktree('local005-tag-collision' as SessionId, 'main');

      expect(info.headSha).toBe(branchHead);
    });

    it('should restore an existing session branch after its original base is deleted', async () => {
      const sourceDir = createLocalRepo(testDir);
      const restoredHead = runGit(sourceDir, ['rev-parse', 'HEAD']);
      const restoreBranch = 'lody/local006-restore';
      runGit(sourceDir, ['branch', restoreBranch]);
      manager.updateSource({ kind: 'local-shared', originalRootPath: sourceDir });

      const info = await manager.createWorktree(
        'local006-restore-base' as SessionId,
        'feature/deleted-base',
        restoreBranch
      );

      expect(info.branch).toBe(restoreBranch);
      expect(info.headSha).toBe(restoredHead);
    });

    it('should restore an existing worktree when origin is unreachable', async () => {
      const { remoteBareDir } = createRemoteRepo(testDir, 'main');
      manager.updateRepoUrl(toFileUrl(remoteBareDir));

      const sessionId = 'roffl01-existing-worktree' as SessionId;
      const created = await manager.createWorktree(sessionId);

      fs.rmSync(remoteBareDir, { recursive: true, force: true });

      const restored = await manager.createWorktree(sessionId);
      expect(restored.hostPath).toBe(created.hostPath);
      expect(restored.branch).toBe(created.branch);
      expect(restored.headSha).toBe(created.headSha);
    });

    it('should restore from an existing branch when origin is unreachable', async () => {
      const { remoteBareDir } = createRemoteRepo(testDir, 'main');
      manager.updateRepoUrl(toFileUrl(remoteBareDir));

      const sessionId = 'roffl02-existing-branch' as SessionId;
      const created = await manager.createWorktree(sessionId);

      // Remove the worktree but keep the session branch, then kill origin.
      // @ts-expect-error - accessing private property for testing
      runGit(manager.bareGitDir, ['worktree', 'remove', '--force', created.hostPath]);
      fs.rmSync(remoteBareDir, { recursive: true, force: true });

      const restored = await manager.createWorktree(sessionId, undefined, created.branch);
      expect(restored.branch).toBe(created.branch);
      expect(restored.headSha).toBe(created.headSha);
      expect(fs.existsSync(restored.hostPath)).toBe(true);
    });

    it('should still require a reachable origin when cutting a fresh worktree', async () => {
      const { remoteBareDir } = createRemoteRepo(testDir, 'main');
      manager.updateRepoUrl(toFileUrl(remoteBareDir));
      await manager.ensureRepo();

      fs.rmSync(remoteBareDir, { recursive: true, force: true });

      await expect(manager.createWorktree('roffl03-fresh-cut' as SessionId)).rejects.toThrow(
        /Failed to fetch from origin/
      );
    });

    it('should fail closed when an explicit restore branch is missing', async () => {
      await manager.ensureRepo();

      await expect(
        manager.createWorktree(
          'restore-missing-branch' as SessionId,
          undefined,
          'feat/missing-restore'
        )
      ).rejects.toThrow('Session restore branch not found: feat/missing-restore');
    });
  });
});


const preparationFixture = Effect.gen(function* () {
  const filesystem = yield* FileSystem.FileSystem;
  const root = yield* filesystem.makeTempDirectoryScoped({ prefix: 'lody-source-preparation-' });
  const originalRootPath = path.join(root, 'original');
  yield* filesystem.makeDirectory(originalRootPath);
  yield* filesystem.writeFileString(path.join(originalRootPath, 'original.txt'), 'retain user data');
  const source = { repoId: 'native-local-source' as RepoId, dataDir: path.join(root, 'data'),
    repoDir: path.join(root, 'data', 'repos', 'native-local-source'),
    worktreesDir: path.join(root, 'data', 'repos', 'native-local-source', 'worktrees'),
    cacheDir: path.join(root, 'data', 'repos', 'native-local-source', 'cache'), originalRootPath, sourceGitDir: '.git' };
  const git = WorktreeGit.of({ run: () => Effect.succeed('.git\ntrue'),
    probeCredentials: () => Effect.succeed({ exitCode: 0, returnedCredentials: false, stderrNonEmpty: false }) });
  const layer = (io = filesystem, commands = git) => LocalWorktreePreparationLive.pipe(Layer.provide(Layer.mergeAll(
    Layer.succeed(FileSystem.FileSystem, io), Layer.succeed(WorktreeGit, commands))));
  const prepare = (io = filesystem, commands = git) => Effect.flatMap(LocalWorktreePreparation,
    preparation => preparation.prepareLocked(source)).pipe(Effect.provide(layer(io, commands)));
  const scratch = () => filesystem.readDirectory(source.repoDir).pipe(Effect.map(entries => entries.filter(name => name.startsWith('.lody-source-'))));
  return { filesystem, root, source, git, prepare, scratch, target: path.join(source.repoDir, 'meta.json') };
}).pipe(Effect.provide(NodeFileSystem.layer));

const deniedWrite = new PlatformError.SystemError({ module: 'FileSystem', method: 'writeFile',
  reason: 'PermissionDenied', description: 'synthetic write denied', pathOrDescriptor: '/synthetic-metadata' });

describe('native local worktree preparation ownership', () => {
  effectIt.effect('publishes complete metadata with the injected Clock and removes its scratch owner', () => Effect.gen(function* () {
    const { filesystem, source, prepare, scratch, target } = yield* preparationFixture;
    yield* prepare();
    expect(JSON.parse(yield* filesystem.readFileString(target))).toEqual({ kind: 'local',
      originalRootPath: source.originalRootPath, sourceGitDir: '.git', createdAtMs: 0 });
    expect(yield* scratch()).toEqual([]);
    expect(yield* filesystem.exists(source.worktreesDir)).toBe(true);
    expect(yield* filesystem.exists(source.cacheDir)).toBe(true);
  }));

  effectIt.effect('failed preparatory writes leave no published or unowned metadata', () => Effect.gen(function* () {
    const { filesystem, source, prepare, scratch, target } = yield* preparationFixture;
    const failedFs = { ...filesystem, writeFileString: (file: string) => filesystem.writeFileString(file, '{partial').pipe(Effect.andThen(Effect.fail(deniedWrite))) };
    const exit = yield* Effect.exit(prepare(failedFs));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(yield* filesystem.exists(target)).toBe(false);
    expect(yield* scratch()).toEqual([]);
    expect(yield* filesystem.readFileString(path.join(source.originalRootPath, 'original.txt'))).toBe('retain user data');
    yield* prepare();
    expect(JSON.parse(yield* filesystem.readFileString(target))).toMatchObject({ kind: 'local' });
  }));

  effectIt.effect('cancellation before publication joins scratch removal before completion', () => Effect.gen(function* () {
    const { filesystem, prepare, scratch, target } = yield* preparationFixture;
    const writing = yield* Deferred.make<void>();
    const blockedFs = { ...filesystem, writeFileString: (file: string) => filesystem.writeFileString(file, '{partial').pipe(
      Effect.andThen(Deferred.succeed(writing, undefined)), Effect.andThen(Effect.never)) };
    const fiber = yield* prepare(blockedFs).pipe(Effect.forkChild);
    yield* Deferred.await(writing);
    expect((yield* scratch()).length).toBe(1);
    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(yield* filesystem.exists(target)).toBe(false);
    expect(yield* scratch()).toEqual([]);
    yield* prepare();
    expect(JSON.parse(yield* filesystem.readFileString(target))).toMatchObject({ kind: 'local' });
  }));

  effectIt.effect('exclusive publication preserves metadata that appears during preparation', () => Effect.gen(function* () {
    const { filesystem, prepare, scratch, target } = yield* preparationFixture;
    const prior = '{"kind":"local","retained":"other owner"}\n';
    const competingFs = { ...filesystem, link: (from: string, to: string) => filesystem.writeFileString(to, prior).pipe(Effect.andThen(filesystem.link(from, to))) };
    yield* prepare(competingFs);
    expect(yield* filesystem.readFileString(target)).toBe(prior);
    expect(yield* scratch()).toEqual([]);
  }));

  effectIt.effect('a scratch release failure is observable even after complete publication', () => Effect.gen(function* () {
    const { filesystem, prepare, scratch, target } = yield* preparationFixture;
    const failedReleaseFs = { ...filesystem, remove: () => Effect.fail(deniedWrite) };
    const exit = yield* Effect.exit(prepare(failedReleaseFs));
    expect(Exit.isFailure(exit) && exit.cause.reasons.some(reason => reason._tag === 'Die' && reason.defect instanceof LocalWorktreeScratchReleaseFailed)).toBe(true);
    expect(JSON.parse(yield* filesystem.readFileString(target))).toMatchObject({ kind: 'local' });
    expect((yield* scratch()).length).toBe(1);
  }));

  effectIt.effect('scratch cleanup timeout completes with retained recovery ownership', () => Effect.gen(function* () {
    const { filesystem, prepare, scratch, target } = yield* preparationFixture;
    const cleaning = yield* Deferred.make<void>();
    let blocked = true;
    const slowFs = { ...filesystem, remove: (directory: string, options?: { recursive?: boolean; force?: boolean }) =>
      Effect.suspend(() => blocked ? Deferred.succeed(cleaning, undefined).pipe(Effect.andThen(Effect.never)) : filesystem.remove(directory, options)) };
    const fiber = yield* prepare(slowFs).pipe(Effect.forkChild);
    yield* Deferred.await(cleaning);
    expect(fiber.pollUnsafe()).toBeUndefined();
    yield* TestClock.adjust(LOCAL_WORKTREE_SCRATCH_RELEASE_MS + 1);
    const exit = yield* Fiber.await(fiber);
    if (Exit.isSuccess(exit)) return yield* Effect.die(new Error('cleanup timeout became success'));
    const reason = exit.cause.reasons.find(candidate => candidate._tag === 'Die' && candidate.defect instanceof LocalWorktreeScratchReleaseFailed);
    if (reason?._tag !== 'Die' || !(reason.defect instanceof LocalWorktreeScratchReleaseFailed))
      return yield* Effect.die(new Error('missing scratch recovery owner'));
    expect(JSON.parse(yield* filesystem.readFileString(target))).toMatchObject({ kind: 'local' });
    expect(yield* scratch()).toEqual([path.basename(reason.defect.directory)]);
    blocked = false;
    yield* reason.defect.retryCleanup;
    expect(yield* scratch()).toEqual([]);
    return undefined;
  }));

  effectIt.effect('the actual Legacy manager boundary retains write failure and scratch recovery together', () => Effect.gen(function* () {
    const { filesystem, source, prepare, scratch } = yield* preparationFixture;
    let releaseBlocked = true;
    const failedFs = { ...filesystem,
      writeFileString: (file: string) => filesystem.writeFileString(file, '{partial').pipe(Effect.andThen(Effect.fail(deniedWrite))),
      remove: (directory: string, options?: { recursive?: boolean; force?: boolean }) => Effect.suspend(() =>
        releaseBlocked ? Effect.fail(deniedWrite) : filesystem.remove(directory, options)) };
    // Exercise the real Promise execution boundary with a native failed operation.
    const manager = new WorktreeManager({ repoId: source.repoId, logger: createLogger({ level: 'error', transports: 'console' }) });
    const failure = yield* Effect.promise(async () => {
      try {
        // @ts-expect-error - exercise the private compatibility boundary
        await manager.runWorktreeLegacy(prepare(failedFs));
        throw new Error('failed preparation became success');
      } catch (error) { return error; }
    });
    if (!(failure instanceof WorktreeGitExecutionFailed) || !(failure.cause instanceof AggregateError))
      return yield* Effect.die(new Error('missing complete compatibility failure'));
    const owner = failure.cause.errors.find((error: unknown) => error instanceof LocalWorktreeScratchReleaseFailed);
    if (!(owner instanceof LocalWorktreeScratchReleaseFailed)) return yield* Effect.die(new Error('missing scratch owner'));
    expect(failure.cause.errors.some((error: unknown) => error instanceof WorktreeGitExecutionFailed && error.cause === deniedWrite)).toBe(true);
    expect(yield* scratch()).toEqual([path.basename(owner.directory)]);
    releaseBlocked = false;
    yield* owner.retryCleanup;
    expect(yield* scratch()).toEqual([]);
    return undefined;
  }));

  effectIt.effect('Git failure cannot erase a simultaneous release defect during source validation', () => Effect.gen(function* () {
    const { filesystem, source, git, prepare, target } = yield* preparationFixture;
    const commandFailure = new WorktreeGitCommandFailed({ message: 'not a repository', args: ['rev-parse'],
      cwd: source.originalRootPath, code: 128, signal: null, stdout: '', stderr: 'not a repository' });
    const releaseFailure = new Error('unresolved process release');
    const commands = { ...git, run: () => Effect.failCause(Cause.combine(Cause.fail(commandFailure), Cause.die(releaseFailure))) };
    const exit = yield* Effect.exit(prepare(filesystem, commands));
    expect(Exit.isFailure(exit) && exit.cause.reasons.some(reason => reason._tag === 'Fail' && reason.error === commandFailure)).toBe(true);
    expect(Exit.isFailure(exit) && exit.cause.reasons.some(reason => reason._tag === 'Die' && reason.defect === releaseFailure)).toBe(true);
    expect(yield* filesystem.exists(target)).toBe(false);
  }));

  effectIt.effect('an unavailable installation root fails before touching the source or publishing metadata', () => Effect.gen(function* () {
    const { filesystem, source, prepare } = yield* preparationFixture;
    yield* filesystem.writeFileString(source.dataDir, 'existing unrelated file');
    const exit = yield* Effect.exit(prepare());
    expect(Exit.isFailure(exit) && exit.cause.reasons.some(reason => reason._tag === 'Fail' && reason.error instanceof LodyDataDirUnavailableError)).toBe(true);
    expect(yield* filesystem.readFileString(source.dataDir)).toBe('existing unrelated file');
    expect((yield* filesystem.readDirectory(path.dirname(source.dataDir))).sort()).toEqual(['data', 'original']);
  }));
});
