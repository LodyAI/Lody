import { describe, expect, it } from 'vitest';
import { it as effectIt } from '@effect/vitest';
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  PlatformError,
  Ref,
} from 'effect';
import { TestClock } from 'effect/testing';
import { FakeProcessTable } from '@lody/shared/node/process-testing';
import {
  processLayer,
  ProcessReleaseFailed,
  ProcessCleanupFailed,
  squashProcessFailure,
} from '@lody/shared/node/process';
import {
  GitExecutableNotFoundError,
  isGitExecutableNotFoundError,
} from '../src/session/worktree/git-process-error';
import {
  WorktreeGit,
  WorktreeGitHost,
  WorktreeGitLive,
  WorktreeGitCommandFailed,
  WorktreeGitExecutionFailed,
} from '../src/session/worktree/git-execution';
import {
  rethrowWorktreeGitInfrastructureFailure,
  worktreeGitLegacy,
} from '../src/session/worktree/git-execution-legacy';

const nativeError = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

const fixture = Effect.gen(function* () {
  const table = new FakeProcessTable();
  const started = yield* Deferred.make<{ pid: number; descendant: number }>();
  const cleaning = yield* Deferred.make<void>();
  const env = yield* Ref.make<NodeJS.ProcessEnv>({});
  const layer = WorktreeGitLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(WorktreeGitHost, { env: Ref.get(env) }),
        Layer.succeed(
          FileSystem.FileSystem,
          FileSystem.makeNoop({ exists: () => Effect.succeed(true) })
        ),
        processLayer({
          nodeProcess: {
            ...table.api,
            spawn: (command, args, options) => {
              const child = table.api.spawn(command, args, options);
              if (child.pid !== undefined) {
                const descendant = table.addDescendant(child.pid, { ignores: ['SIGTERM'] });
                Deferred.doneUnsafe(started, Effect.succeed({ pid: child.pid, descendant }));
              }
              return child;
            },
            kill: (target, signal) => {
              table.api.kill(target, signal);
              if (signal === 'SIGTERM') Deferred.doneUnsafe(cleaning, Effect.void);
            },
          },
        })
      )
    )
  );
  return { table, started, cleaning, env, layer };
});
const gitCommand = Effect.flatMap(WorktreeGit, (git) =>
  git.run({ args: ['status'], cwd: '/project' })
);
const helperProbe = Effect.flatMap(WorktreeGit, (git) =>
  git.probeCredentials({
    helperPath: '/helper.js',
    host: 'github.com',
    repoFullName: 'owner/repo',
    env: {},
  })
);

describe('worktree Git execution boundary', () => {
  it('finds the stable unavailable-Git diagnostic through wrapped causes', () => {
    const gitError = new GitExecutableNotFoundError(new Error('spawn git ENOENT'));
    expect(isGitExecutableNotFoundError(new Error('clone failed', { cause: gitError }))).toBe(true);
    expect(isGitExecutableNotFoundError(new Error('git exited with code 1'))).toBe(false);
  });
  effectIt.effect(
    'classifies ENOENT using the provided filesystem and preserves permission failures',
    () =>
      Effect.gen(function* () {
        for (const state of ['present', 'missing', 'denied'] as const) {
          const table = new FakeProcessTable();
          const permission = PlatformError.systemError({
            _tag: 'PermissionDenied',
            module: 'FileSystem',
            method: 'exists',
            path: '/project',
          });
          table.queueSpawn({
            failWith: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }),
          });
          const layer = WorktreeGitLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(WorktreeGitHost, { env: Effect.succeed({}) }),
                Layer.succeed(
                  FileSystem.FileSystem,
                  FileSystem.makeNoop({
                    exists: () =>
                      state === 'denied'
                        ? Effect.fail(permission)
                        : Effect.succeed(state === 'present'),
                  })
                ),
                processLayer({ nodeProcess: table.api })
              )
            )
          );
          const failure = nativeError(yield* gitCommand.pipe(Effect.provide(layer), Effect.exit));
          expect(failure).toBeInstanceOf(WorktreeGitExecutionFailed);
          expect(isGitExecutableNotFoundError(failure)).toBe(state === 'present');
          if (state === 'denied') expect(failure).toMatchObject({ cause: permission });
          else if (state === 'missing')
            expect(failure).toMatchObject({ cause: { _tag: 'SpawnFailed' } });
        }
      })
  );
  effectIt.effect('returns output after completion and retains the exact failed Git status', () =>
    Effect.gen(function* () {
      for (const code of [0, 128]) {
        const { table, started, layer } = yield* fixture;
        const command = yield* gitCommand.pipe(Effect.provide(layer), Effect.forkChild);
        const { pid, descendant } = yield* Deferred.await(started);
        table.childOf(pid)?.stdout.write('  branch-head\n');
        table.childOf(pid)?.stderr.write(code === 0 ? '' : 'fatal: corrupt repository\n');
        table.exitOnItsOwn(descendant);
        table.exitOnItsOwn(pid, code);
        const exit = yield* Fiber.await(command);
        if (code === 0) expect(exit).toEqual(Exit.succeed('branch-head'));
        else
          expect(nativeError(exit)).toMatchObject({
            _tag: 'WorktreeGitCommandFailed',
            code: 128,
            stdout: '  branch-head\n',
            stderr: 'fatal: corrupt repository\n',
          });
      }
    })
  );
  effectIt.effect('the environment is read for each command while the per-call overlay wins', () =>
    Effect.gen(function* () {
      const table = new FakeProcessTable();
      const env = yield* Ref.make<NodeJS.ProcessEnv>({
        FIXTURE: 'first',
        GIT_TERMINAL_PROMPT: '1',
      });
      const layer = WorktreeGitLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(WorktreeGitHost, { env: Ref.get(env) }),
            Layer.succeed(FileSystem.FileSystem, FileSystem.makeNoop()),
            processLayer({
              nodeProcess: {
                ...table.api,
                spawn: (command, args, options) => {
                  const child = table.api.spawn(command, args, options);
                  const pid = child.pid;
                  queueMicrotask(() => {
                    child.stdout?.push(
                      `${options.env?.FIXTURE}:${options.env?.OVERLAY}:${options.env?.GIT_TERMINAL_PROMPT}`
                    );
                    if (pid !== undefined) table.exitOnItsOwn(pid);
                  });
                  return child;
                },
              },
            })
          )
        )
      );
      yield* Effect.gen(function* () {
        const git = yield* WorktreeGit;
        expect(
          yield* git.run({
            args: ['status'],
            cwd: '/project',
            env: { OVERLAY: 'frozen-requester' },
          })
        ).toBe('first:frozen-requester:0');
        yield* Ref.set(env, { FIXTURE: 'second' });
        expect(
          yield* git.run({ args: ['status'], cwd: '/project', env: { OVERLAY: 'same-requester' } })
        ).toBe('second:same-requester:0');
      }).pipe(Effect.provide(layer));
    })
  );
  effectIt.effect('helper protocol is written and its completed response is interpreted', () =>
    Effect.gen(function* () {
      const table = new FakeProcessTable();
      const layer = WorktreeGitLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(WorktreeGitHost, { env: Effect.succeed({}) }),
            Layer.succeed(FileSystem.FileSystem, FileSystem.makeNoop()),
            processLayer({
              nodeProcess: {
                ...table.api,
                spawn: (command, args, options) => {
                  const child = table.api.spawn(command, args, options);
                  const pid = child.pid;
                  let input = '';
                  child.stdin?.on('data', (chunk) => {
                    input += String(chunk);
                  });
                  child.stdin?.once('finish', () => {
                    if (input === 'protocol=https\nhost=github.com\npath=/owner/repo.git\n\n')
                      child.stdout?.push('username=fixture\npassword=synthetic-token\n\n');
                    if (pid !== undefined) table.exitOnItsOwn(pid);
                  });
                  return child;
                },
              },
            })
          )
        )
      );
      expect(yield* helperProbe.pipe(Effect.provide(layer))).toEqual({
        exitCode: 0,
        returnedCredentials: true,
        stderrNonEmpty: false,
      });
    })
  );
  for (const kind of ['git', 'helper'] as const) {
    effectIt.effect(`${kind} deadline waits for whole-tree cleanup`, () =>
      Effect.gen(function* () {
        const { table, started, cleaning, layer } = yield* fixture;
        table.queueSpawn({ ignores: ['SIGTERM'] });
        const command = yield* (kind === 'git' ? gitCommand : helperProbe).pipe(
          Effect.provide(layer),
          Effect.forkChild
        );
        const { pid, descendant } = yield* Deferred.await(started);
        yield* TestClock.adjust(kind === 'git' ? '10 minutes' : '5 seconds');
        yield* Deferred.await(cleaning);
        expect(command.pollUnsafe()).toBeUndefined();
        expect(table.isAlive(descendant)).toBe(true);
        yield* TestClock.adjust('2 seconds');
        expect(nativeError(yield* Fiber.await(command))).toMatchObject({
          _tag: 'WorktreeGitExecutionFailed',
          cause: { _tag: 'CommandTimedOut' },
        });
        expect(table.isAlive(pid)).toBe(false);
        expect(table.isAlive(descendant)).toBe(false);
      })
    );
  }
  effectIt.effect('interruption waits for command and descendant release', () =>
    Effect.gen(function* () {
      const { table, started, cleaning, layer } = yield* fixture;
      table.queueSpawn({ ignores: ['SIGTERM'] });
      const command = yield* gitCommand.pipe(Effect.provide(layer), Effect.forkChild);
      const { pid, descendant } = yield* Deferred.await(started);
      const interrupted = yield* Fiber.interrupt(command).pipe(Effect.forkChild);
      yield* Deferred.await(cleaning);
      expect(interrupted.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust('2 seconds');
      yield* Fiber.join(interrupted);
      expect(Exit.isFailure(yield* Fiber.await(command))).toBe(true);
      expect(table.isAlive(pid)).toBe(false);
      expect(table.isAlive(descendant)).toBe(false);
    })
  );
  for (const kind of ['git', 'helper'] as const) {
    effectIt.effect(
      `${kind} failed release retains recovery ownership through a Promise fallback guard`,
      () =>
        Effect.gen(function* () {
          const { table, started, layer } = yield* fixture;
          table.queueSpawn({ ignores: ['SIGTERM', 'SIGKILL'] });
          const command = yield* (kind === 'git' ? gitCommand : helperProbe).pipe(
            Effect.provide(layer),
            Effect.forkChild
          );
          const { pid, descendant } = yield* Deferred.await(started);
          yield* TestClock.adjust(kind === 'git' ? '11 minutes' : '20 seconds');
          const exit = yield* Fiber.await(command);
          if (!Exit.isFailure(exit)) throw new Error('Expected failed release');
          const releases = exit.cause.reasons.flatMap((reason) =>
            Cause.isDieReason(reason) && reason.defect instanceof ProcessReleaseFailed
              ? [reason.defect]
              : []
          );
          expect(releases).toHaveLength(1);
          const release = releases[0];
          if (!release) throw new Error('Expected recovery owner');
          expect(yield* release.isAlive).toBe(true);
          const projected = squashProcessFailure(exit.cause);
          expect(projected).toBeInstanceOf(ProcessCleanupFailed);
          if (!(projected instanceof ProcessCleanupFailed))
            throw new Error('Expected projected recovery owner');
          expect(projected.releases).toEqual([release]);
          expect(projected.cause).toMatchObject({
            _tag: 'WorktreeGitExecutionFailed',
            cause: { _tag: 'CommandTimedOut' },
          });
          expect(() => rethrowWorktreeGitInfrastructureFailure(projected)).toThrow(projected);
          const wrapped = new Error('worktree probe failed', { cause: release });
          expect(() => rethrowWorktreeGitInfrastructureFailure(wrapped)).toThrow(wrapped);
          table.exitOnItsOwn(pid);
          table.exitOnItsOwn(descendant);
          yield* release.retryTermination();
          expect(yield* release.isAlive).toBe(false);
        })
    );
  }
  it('a cancelled compatibility entry rejects as infrastructure failure', async () => {
    await expect(
      worktreeGitLegacy.run(
        { args: ['status'], cwd: '/project' },
        {
          signal: AbortSignal.abort('synthetic cancellation'),
        }
      )
    ).rejects.toBeInstanceOf(WorktreeGitExecutionFailed);
  });
  it('only infrastructure failure is excluded from Promise domain fallbacks', () => {
    const transport = new WorktreeGitExecutionFailed({
      message: 'git unavailable',
      cause: new Error('ENOENT'),
    });
    expect(() => rethrowWorktreeGitInfrastructureFailure(transport)).toThrow(transport);
    const absent = new WorktreeGitCommandFailed({
      message: 'ref missing',
      args: [],
      cwd: '/project',
      code: 1,
      signal: null,
      stdout: '',
      stderr: '',
    });
    expect(() => rethrowWorktreeGitInfrastructureFailure(absent)).not.toThrow();
  });
});
