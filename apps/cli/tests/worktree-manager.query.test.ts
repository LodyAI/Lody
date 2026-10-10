import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';
import { it as effectIt } from '@effect/vitest';
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Option, PlatformError } from 'effect';
import { NodeFileSystem } from '@effect/platform-node-shared';
import { FileLocks, FileLocksLive, FileLockHost, LockReentrant } from '@lody/shared/node/file-lock';
import { FakeProcessTable } from '@lody/shared/node/process-testing';
import { TestClock } from 'effect/testing';
import { processLayer, ProcessReleaseFailed, ProcessCleanupFailed, squashProcessFailure } from '@lody/shared/node/process';
import { NodeProcess, nodeProcessLive } from '@lody/shared/node/process';
import { WorktreeGit, WorktreeGitCommandFailed, WorktreeGitExecutionFailed, WorktreeGitHost, WorktreeGitLive } from '../src/session/worktree/git-execution';
import { WorktreeObservations, WorktreeObservationsLive } from '../src/session/worktree/worktree-observations';
import { RepoId, SessionId } from '@lody/shared';
import { createLogger } from '../src/utils/logger';
import { deriveRepoIdFromLocalProjectPath } from '@lody/shared/node/worktree-paths';
import { preflightLocalProjectWorktreeRemoval, cleanupLocalProjectWorktrees } from '../src/lib/local-project-removal';
import { getWorktreeManager, WorktreeManager } from '../src/session/worktree/worktree-manager';
import { createLocalRepo, runGit, useWorktreeManagerTestFixture } from './worktree-manager-test-helpers';

describe('WorktreeManager', () => {
  let repoId: RepoId;
  let testDir: string;
  let manager: WorktreeManager;

  useWorktreeManagerTestFixture((fixture) => {
    ({ repoId, manager, testDir } = fixture);
  });

  describe('listWorktrees', () => {
    it('should list every safe worktree directory', async () => {
      const sessionIds = [
        'list0001-session-list-1',
        'list0002-session-list-2',
        'list0003-session-list-3',
      ] as SessionId[];
      const sourceDir = createLocalRepo(testDir);
      manager.updateSource({ kind: 'local-shared', originalRootPath: sourceDir });
      for (const sessionId of sessionIds) await manager.createWorktree(sessionId);

      const worktrees = await manager.listWorktrees();

      expect(new Set(worktrees.map((worktree) => worktree.sessionId))).toEqual(new Set(sessionIds));
    });

    it('reports a corrupt directory rather than returning a phantom dirty worktree', async () => {
      const sessionId = 'corrupt-session' as SessionId;
      const cwd = manager.getWorktreeHostPath(sessionId);
      fs.mkdirSync(cwd, { recursive: true });
      fs.writeFileSync(path.join(cwd, 'uncommitted.txt'), 'must survive');
      await expect(manager.listWorktrees()).rejects.toMatchObject({ _tag: 'WorktreeGitCommandFailed' });
      expect(await manager.inspectWorktree(sessionId)).toMatchObject({ state: 'failed', path: cwd });
      await expect(manager.getCurrentBranchName(sessionId)).rejects.toMatchObject({ _tag: 'WorktreeGitCommandFailed' });
      expect(fs.readFileSync(path.join(cwd, 'uncommitted.txt'), 'utf8')).toBe('must survive');
    });

    it('skips symbolic links and unsafe names while returning an actual worktree', async () => {
      const sourceDir = createLocalRepo(testDir);
      manager.updateSource({ kind: 'local-shared', originalRootPath: sourceDir });
      const sessionId = 'actual-session' as SessionId;
      const created = await manager.createWorktree(sessionId);
      const root = path.dirname(created.hostPath);
      fs.symlinkSync(created.hostPath, path.join(root, 'linked-session'), 'dir');
      fs.mkdirSync(path.join(root, '.invalid'));
      fs.writeFileSync(path.join(root, 'ordinary-file'), 'not a worktree');
      expect(await manager.listWorktrees()).toEqual([created]);
    });

    it('observes renamed branches, detached commits, and dirty files', async () => {
      const sourceDir = createLocalRepo(testDir);
      manager.updateSource({ kind: 'local-shared', originalRootPath: sourceDir });
      const sessionId = 'renamed-session' as SessionId;
      const created = await manager.createWorktree(sessionId);
      runGit(created.hostPath, ['branch', '-m', 'new-observed-name']);
      expect(await manager.getCurrentBranchName(sessionId)).toBe('new-observed-name');
      expect(await manager.inspectWorktree(sessionId)).toMatchObject({ state: 'clean', info: { branch: 'new-observed-name', headSha: created.headSha } });
      fs.writeFileSync(path.join(created.hostPath, 'pending.txt'), 'pending');
      expect(await manager.inspectWorktree(sessionId)).toMatchObject({ state: 'dirty', info: { isClean: false } });
      runGit(created.hostPath, ['checkout', '--detach']);
      expect(await manager.getCurrentBranchName(sessionId)).toBeNull();
      expect(await manager.listWorktrees()).toMatchObject([{ headSha: created.headSha, isClean: false }]);
    });

    it('keeps only a genuinely unborn branch as a null HEAD', async () => {
      const sessionId = 'unborn-session' as SessionId;
      const cwd = manager.getWorktreeHostPath(sessionId);
      fs.mkdirSync(cwd, { recursive: true });
      runGit(cwd, ['init', '-b', 'unborn']);
      expect(await manager.listWorktrees()).toMatchObject([{ branch: 'unborn', headSha: null, isClean: true }]);
      fs.writeFileSync(path.join(cwd, '.git', 'refs', 'heads', 'unborn'), '1111111111111111111111111111111111111111\n');
      await expect(manager.listWorktrees()).rejects.toMatchObject({ _tag: 'WorktreeGitCommandFailed' });
      expect(await manager.inspectWorktree(sessionId)).toMatchObject({ state: 'failed' });
    });

    it('reports missing inspection and branch without creating a worktree', async () => {
      const sessionId = 'missing-session' as SessionId;
      expect(await manager.inspectWorktree(sessionId)).toEqual({ state: 'missing', path: manager.getWorktreeHostPath(sessionId) });
      expect(await manager.getCurrentBranchName(sessionId)).toBeNull();
      expect(fs.existsSync(manager.getWorktreeHostPath(sessionId))).toBe(false);
    });

    it('real local-project removal reports corruption and keeps dirty files and the original project', async () => {
      const priorDataDir = process.env.LODY_DATA_DIR;
      process.env.LODY_DATA_DIR = path.join(testDir, 'project-state');
      try {
        const originalRootPath = createLocalRepo(testDir);
        const repo = deriveRepoIdFromLocalProjectPath(originalRootPath);
        const logger = createLogger({ level: 'error', transports: 'console', console: { colorize: false, timestamp: false, format: 'simple' } });
        const removalManager = getWorktreeManager({ repoId: repo, source: { kind: 'local-shared', originalRootPath }, logger });
        const cleanId = 'remove-clean' as SessionId;
        const dirtyId = 'remove-dirty' as SessionId;
        const brokenId = 'remove-broken' as SessionId;
        const clean = await removalManager.createWorktree(cleanId);
        const dirty = await removalManager.createWorktree(dirtyId);
        fs.writeFileSync(path.join(dirty.hostPath, 'pending.txt'), 'keep dirty data');
        const brokenPath = removalManager.getWorktreeHostPath(brokenId);
        fs.mkdirSync(brokenPath);
        fs.writeFileSync(path.join(brokenPath, 'unique.txt'), 'keep corrupt worktree data');
        const machineId = 'query-machine' as import('@lody/shared').MachineId;
        const localProjectId = 'query-project' as import('@lody/shared').LocalProjectId;
        const target = { originalRootPath, machineId, localProjectId, logger, sessions: [cleanId, dirtyId, brokenId].map(id => ({ id, machineId, isWorktree: true, project: { kind: 'local', localProjectId } } as import('@lody/shared').SessionMeta)) };
        const preflight = await preflightLocalProjectWorktreeRemoval(target);
        expect(preflight.clean.map(item => item.sessionId)).toEqual([cleanId]);
        expect(preflight.dirty.map(item => item.sessionId)).toEqual([dirtyId]);
        expect(preflight.failed.map(item => item.sessionId)).toEqual([brokenId]);
        const cleaned = await cleanupLocalProjectWorktrees(target);
        expect(cleaned.deleted.map(item => item.sessionId)).toEqual([cleanId]);
        expect(cleaned.skippedDirty.map(item => item.sessionId)).toEqual([dirtyId]);
        expect(cleaned.failed.map(item => item.sessionId)).toEqual([brokenId]);
        expect(fs.existsSync(clean.hostPath)).toBe(false);
        expect(fs.readFileSync(path.join(dirty.hostPath, 'pending.txt'), 'utf8')).toBe('keep dirty data');
        expect(fs.readFileSync(path.join(brokenPath, 'unique.txt'), 'utf8')).toBe('keep corrupt worktree data');
        expect(fs.readFileSync(path.join(originalRootPath, 'README.md'), 'utf8')).toBe('# local\n');
      } finally {
        if (priorDataDir === undefined) delete process.env.LODY_DATA_DIR;
        else process.env.LODY_DATA_DIR = priorDataDir;
      }
    });

    it('should return an empty array when the worktree root does not exist', async () => {
      const worktrees = await manager.listWorktrees();
      expect(worktrees).toEqual([]);
    });
  });

  describe('hasWorktree', () => {
    it('should return true for existing worktree', async () => {
      const sessionId = 'haswt001-session-has' as SessionId;
      fs.mkdirSync(manager.getWorktreeHostPath(sessionId), { recursive: true });

      expect(manager.hasWorktree(sessionId)).toBe(true);
    });

    it('should return false for non-existent worktree', () => {
      expect(manager.hasWorktree('nonexistent' as SessionId)).toBe(false);
    });

    it('should return false for unsafe session ids', () => {
      expect(manager.hasWorktree('../evil' as SessionId)).toBe(false);
    });
  });

  describe('path resolution', () => {
    it('should resolve correct host path', () => {
      const sessionId = 'pathres1-session-path' as SessionId;

      const hostPath = manager.getWorktreeHostPath(sessionId);

      expect(hostPath).toBe(path.join(testDir, repoId, 'worktrees', sessionId));
    });

    it('should resolve repo host path', () => {
      expect(manager.getRepoHostPath()).toBe(path.join(testDir, repoId));
    });
  });
});

const observationFixture = Effect.gen(function* () {
  const filesystem = yield* FileSystem.FileSystem;
  const root = yield* filesystem.makeTempDirectoryScoped({ prefix: 'lody-native-observation-' });
  const locksDir = path.join(root, 'locks');
  const worktreesDir = path.join(root, 'worktrees');
  yield* filesystem.makeDirectory(worktreesDir);
  const locks = FileLocksLive.pipe(Layer.provide(Layer.mergeAll(
    Layer.succeed(FileSystem.FileSystem, filesystem),
    Layer.succeed(NodeProcess, nodeProcessLive),
    Layer.succeed(FileLockHost, { locksDir, pid: process.pid })
  )));
  const context = yield* Layer.build(locks);
  const source = { repoId: 'native-query-repo' as RepoId, worktreesDir, localShared: false };
  const layer = (git: typeof WorktreeGit.Service, queryFs = filesystem) => WorktreeObservationsLive.pipe(Layer.provide(Layer.mergeAll(
    Layer.succeed(FileSystem.FileSystem, queryFs), Layer.succeed(WorktreeGit, git)
  )));
  return { filesystem, root, locksDir, source, context, layer };
}).pipe(Effect.provide(NodeFileSystem.layer));
const completedGitFailure = new WorktreeGitCommandFailed({
  message: 'corrupt repository', args: ['status'], cwd: '/corrupt', code: 128, signal: null, stdout: '', stderr: 'fatal: corrupt repository'
});
const unusedHelper = () => Effect.succeed({ exitCode: 0, returnedCredentials: false, stderrNonEmpty: false });

describe('native worktree observation ownership', () => {
  effectIt.effect('cancelled queued queries never enter Git, and holder cleanup precedes the successor', () => Effect.gen(function* () {
    const { filesystem, root, locksDir, source, context, layer } = yield* observationFixture;
    const ready = yield* Deferred.make<void>();
    const cleanup = yield* Deferred.make<void>();
    const cleaning = yield* Deferred.make<void>();
    const holderId = 'holder-session' as SessionId;
    const cancelledId = 'cancelled-session' as SessionId;
    for (const id of [holderId, cancelledId]) yield* filesystem.makeDirectory(path.join(source.worktreesDir, id));
    const marker = path.join(root, 'cancelled-was-admitted');
    const query = WorktreeGit.of({ run: command => command.cwd.endsWith(holderId)
      ? Deferred.succeed(ready, undefined).pipe(Effect.andThen(Effect.never), Effect.ensuring(Deferred.succeed(cleaning, undefined).pipe(Effect.andThen(Deferred.await(cleanup)))))
      : filesystem.writeFileString(marker, 'entered').pipe(Effect.mapError(error => new WorktreeGitExecutionFailed({ message: error.message, cause: error })), Effect.as('main')), probeCredentials: unusedHelper });
    yield* Effect.gen(function* () {
      const observations = yield* WorktreeObservations;
      const holder = yield* observations.inspect(source, holderId).pipe(Effect.forkChild);
      yield* Deferred.await(ready);
      expect(yield* filesystem.exists(path.join(locksDir, `worktree-${source.repoId}.lock`))).toBe(true);
      const queued = yield* observations.inspect(source, cancelledId).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(queued);
      const stopping = yield* Fiber.interrupt(holder).pipe(Effect.forkChild);
      yield* Deferred.await(cleaning);
      const stoppingBeforeCleanup = stopping.pollUnsafe();
      expect(yield* filesystem.exists(path.join(locksDir, `worktree-${source.repoId}.lock`))).toBe(true);
      const next = yield* observations.inspect(source, 'missing-successor' as SessionId).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const successorBeforeCleanup = next.pollUnsafe();
      yield* Deferred.succeed(cleanup, undefined);
      yield* Fiber.join(stopping);
      expect(stoppingBeforeCleanup).toBeUndefined();
      expect(successorBeforeCleanup).toBeUndefined();
      expect(yield* Fiber.join(next)).toMatchObject({ state: 'missing' });
      expect(yield* filesystem.exists(marker)).toBe(false);
      expect(yield* filesystem.readDirectory(locksDir)).toEqual([]);
    }).pipe(Effect.ensuring(Deferred.succeed(cleanup, undefined)), Effect.provide(layer(query)), Effect.provideContext(context));
  }));

  for (const unreleasable of [false, true]) {
    effectIt.effect(`native command interruption ${unreleasable ? 'retains recovery ownership' : 'joins tree release'} before releasing the query lease`, () => Effect.gen(function* () {
      const { filesystem, locksDir, source, context } = yield* observationFixture;
      const id = 'process-query' as SessionId;
      yield* filesystem.makeDirectory(path.join(source.worktreesDir, id));
      const table = new FakeProcessTable();
      table.queueSpawn({ ignores: unreleasable ? ['SIGTERM', 'SIGKILL'] : ['SIGTERM'] });
      const started = yield* Deferred.make<{ pid: number; descendant: number }>();
      const cleaning = yield* Deferred.make<void>();
      const nativeGit = WorktreeGitLive.pipe(Layer.provide(Layer.mergeAll(
        Layer.succeed(FileSystem.FileSystem, filesystem), Layer.succeed(WorktreeGitHost, { env: Effect.succeed({}) }),
        processLayer({ nodeProcess: { ...table.api, spawn: (command, args, options) => {
          const child = table.api.spawn(command, args, options);
          if (child.pid !== undefined) Deferred.doneUnsafe(started, Effect.succeed({ pid: child.pid, descendant: table.addDescendant(child.pid, { ignores: unreleasable ? ['SIGTERM', 'SIGKILL'] : ['SIGTERM'] }) }));
          return child;
        }, kill: (target, signal) => { table.api.kill(target, signal); if (signal === 'SIGTERM') Deferred.doneUnsafe(cleaning, Effect.void); } } })
      )));
      const observationsLayer = WorktreeObservationsLive.pipe(Layer.provide(Layer.mergeAll(nativeGit, Layer.succeed(FileSystem.FileSystem, filesystem))));
      yield* Effect.gen(function* () {
        const observations = yield* WorktreeObservations;
        const query = yield* observations.inspect(source, id).pipe(Effect.forkChild);
        const { pid, descendant } = yield* Deferred.await(started);
        const interrupted = yield* Fiber.interrupt(query).pipe(Effect.forkChild);
        yield* Deferred.await(cleaning);
        const held = yield* filesystem.exists(path.join(locksDir, `worktree-${source.repoId}.lock`));
        const before = interrupted.pollUnsafe();
        yield* TestClock.adjust(unreleasable ? '20 seconds' : '2 seconds');
        yield* Fiber.join(interrupted);
        const exit = yield* Fiber.await(query);
        expect(held).toBe(true);
        expect(before).toBeUndefined();
        expect(Exit.isFailure(exit)).toBe(true);
        expect(yield* filesystem.readDirectory(locksDir)).toEqual([]);
        if (Exit.isFailure(exit) && unreleasable) {
          const releases = exit.cause.reasons.flatMap(reason => Cause.isDieReason(reason) && reason.defect instanceof ProcessReleaseFailed ? [reason.defect] : []);
          expect(releases).toHaveLength(1);
          const projected = squashProcessFailure(exit.cause);
          if (projected instanceof ProcessCleanupFailed) expect(projected.releases).toEqual(releases);
          else expect(projected).toBe(releases[0]);
          expect(table.isAlive(pid)).toBe(true);
          expect(table.isAlive(descendant)).toBe(true);
          table.exitOnItsOwn(descendant); table.exitOnItsOwn(pid);
          const retained = releases[0];
          if (!retained) throw new Error('missing recovery lease');
          expect(yield* retained.isAlive).toBe(false);
        } else {
          expect(table.isAlive(pid)).toBe(false);
          expect(table.isAlive(descendant)).toBe(false);
        }
        expect(yield* observations.inspect(source, 'after-cleanup' as SessionId)).toMatchObject({ state: 'missing' });
      }).pipe(Effect.provide(observationsLayer), Effect.provideContext(context));
    }));
  }

  effectIt.effect('completed Git failure releases the repo lease and same-context reentry fails immediately', () => Effect.gen(function* () {
    const { filesystem, locksDir, source, context, layer } = yield* observationFixture;
    const id = 'failed-session' as SessionId;
    yield* filesystem.makeDirectory(path.join(source.worktreesDir, id));
    const query = WorktreeGit.of({ run: () => Effect.fail(completedGitFailure), probeCredentials: unusedHelper });
    yield* Effect.gen(function* () {
      const observations = yield* WorktreeObservations;
      expect(yield* observations.inspect(source, id)).toMatchObject({ state: 'failed' });
      expect(yield* filesystem.readDirectory(locksDir)).toEqual([]);
      const failed = yield* observations.list(source).pipe(Effect.exit);
      expect(Exit.isFailure(failed)).toBe(true);
      if (Exit.isFailure(failed)) expect(Option.getOrUndefined(Cause.findErrorOption(failed.cause))).toBe(completedGitFailure);
      expect(yield* observations.inspect(source, 'next-session' as SessionId)).toMatchObject({ state: 'missing' });
      const locks = yield* FileLocks;
      const nested = yield* locks.withLock(`worktree-${source.repoId}`, observations.list(source)).pipe(Effect.exit);
      if (Exit.isFailure(nested)) expect(Option.getOrUndefined(Cause.findErrorOption(nested.cause))).toBeInstanceOf(LockReentrant);
      else throw new Error('nested query unexpectedly acquired its own repo lock');
      expect(yield* filesystem.readDirectory(locksDir)).toEqual([]);
    }).pipe(Effect.provide(layer(query)), Effect.provideContext(context));
  }));

  effectIt.effect('an existing invalid HEAD ref is not an unborn branch even when status succeeds', () => Effect.gen(function* () {
    const { filesystem, source, context, layer } = yield* observationFixture;
    const id = 'invalid-head' as SessionId;
    yield* filesystem.makeDirectory(path.join(source.worktreesDir, id));
    const query = WorktreeGit.of({
      run: command => command.args[0] === 'branch' ? Effect.succeed('main')
        : command.args[0] === 'rev-parse' ? Effect.fail(completedGitFailure) : Effect.succeed(''),
      probeCredentials: unusedHelper
    });
    yield* Effect.gen(function* () {
      const observations = yield* WorktreeObservations;
      expect(yield* observations.inspect(source, id)).toMatchObject({ state: 'failed' });
      const listed = yield* observations.list(source).pipe(Effect.exit);
      if (Exit.isFailure(listed)) expect(Option.getOrUndefined(Cause.findErrorOption(listed.cause))).toBe(completedGitFailure);
      else throw new Error('existing invalid HEAD was reported as an unborn successful worktree');
    }).pipe(Effect.provide(layer(query)), Effect.provideContext(context));
  }));

  effectIt.effect('filesystem denial and mixed release defects cannot become successful inspection or an empty list', () => Effect.gen(function* () {
    const { filesystem, source, context, layer } = yield* observationFixture;
    const id = 'mixed-failure' as SessionId;
    yield* filesystem.makeDirectory(path.join(source.worktreesDir, id));
    const release = new Error('unreleased resource');
    const mixed = Effect.fail(completedGitFailure).pipe(Effect.ensuring(Effect.die(release)));
    const query = WorktreeGit.of({ run: () => mixed, probeCredentials: unusedHelper });
    const inspection = yield* Effect.flatMap(WorktreeObservations, observations => observations.inspect(source, id)).pipe(Effect.provide(layer(query)), Effect.provideContext(context), Effect.exit);
    if (Exit.isFailure(inspection)) {
      expect(inspection.cause.reasons.some(reason => reason._tag === 'Die' && reason.defect === release)).toBe(true);
      expect(Option.getOrUndefined(Cause.findErrorOption(inspection.cause))).toBe(completedGitFailure);
    } else throw new Error('mixed failure became a successful inspection');
    const denied = PlatformError.systemError({ _tag: 'PermissionDenied', module: 'FileSystem', method: 'readDirectory', path: source.worktreesDir });
    const queryFs = FileSystem.FileSystem.of({ ...filesystem, readDirectory: () => Effect.fail(denied) });
    const listed = yield* Effect.flatMap(WorktreeObservations, observations => observations.list(source)).pipe(Effect.provide(layer(query, queryFs)), Effect.provideContext(context), Effect.exit);
    if (Exit.isFailure(listed)) expect(Option.getOrUndefined(Cause.findErrorOption(listed.cause))).toMatchObject({ _tag: 'WorktreeGitExecutionFailed', cause: denied });
    else throw new Error('filesystem denial became an empty list');
  }));
});
