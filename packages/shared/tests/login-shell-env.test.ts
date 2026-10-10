import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach } from 'vitest';
import { describe, expect, it } from '@effect/vitest';
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option } from 'effect';
import { TestClock } from 'effect/testing';

import {
  LoginShellHost,
  LoginShellEnvironmentLive,
  loginShellEnvLayer,
  parseLoginShellEnvOutput,
  probeLoginShellEnv,
  probeLoginShellEnvLegacy,
} from '../src/node/login-shell-env';
import {
  CommandTimedOut,
  SpawnFailed,
  ProcessCleanupFailed,
  squashProcessFailure,
  processLayer,
} from '../src/node/process';
import { FakeProcessTable } from '../src/node/process-testing';

// Real shells under a throwaway HOME: the probe's contract is what a login
// shell's rc files leave in its environment.
describe.skipIf(process.platform === 'win32')('probeLoginShellEnvLegacy', () => {
  let home: string;
  const env = () => ({ HOME: home, PATH: '/usr/bin:/bin', ZDOTDIR: home });

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'lody-login-shell-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('recovers what the login profile exports, whatever the profile prints', async () => {
    await writeFile(
      path.join(home, '.profile'),
      'echo "welcome banner"\nexport LODY_PROBE_VALUE="$(printf \'one\\ntwo=three\')"\n'
    );

    const result = await probeLoginShellEnvLegacy({
      shell: '/bin/sh',
      env: env(),
      timeout: '10 seconds',
    });

    expect(result?.LODY_PROBE_VALUE).toBe('one\ntwo=three');
    expect(result?.HOME).toBe(home);
    // Every variable keeps its name, including the first one after the
    // delimiter (macOS /bin/sh prints `echo -n` literally).
    expect(result?.PATH).toBeDefined();
    expect(Object.keys(result ?? {}).filter((key) => /\s/u.test(key))).toEqual([]);
  });

  // The probe disables oh-my-zsh auto-update and tmux autostart for itself;
  // passing them on would disable them in every Lody terminal too.
  it('returns none of the variables the probe injected into its own shell', async () => {
    const result = await probeLoginShellEnvLegacy({
      shell: '/bin/sh',
      env: { ...env(), ZSH_TMUX_AUTOSTART: 'true' },
      timeout: '10 seconds',
    });

    expect(result?.DISABLE_AUTO_UPDATE).toBeUndefined();
    expect(result?.ZSH_TMUX_AUTOSTARTED).toBeUndefined();
    expect(result?.ZSH_TMUX_AUTOSTART).toBe('true');
  });

  it.skipIf(!existsSync('/bin/zsh') && !existsSync('/bin/bash'))(
    'falls back to zsh or bash when the login shell cannot start',
    async () => {
      const exportLine = 'export LODY_PROBE_VALUE=fallback\n';
      await writeFile(path.join(home, '.zshenv'), exportLine);
      await writeFile(path.join(home, '.bash_profile'), exportLine);

      const result = await probeLoginShellEnvLegacy({
        shell: '/nonexistent/lody-shell',
        env: env(),
        timeout: '10 seconds',
      });

      expect(result?.LODY_PROBE_VALUE).toBe('fallback');
    }
  );
});

describe('parseLoginShellEnvOutput', () => {
  // BusyBox `env` has no -0; the probe then prints one variable per line.
  it('reads newline-separated output from an env without -0', () => {
    expect(
      parseLoginShellEnvOutput(
        'banner_LODY_SHELL_ENV_DELIMITER_PATH=/usr/bin\nHOME=/root\n_LODY_SHELL_ENV_DELIMITER_'
      )
    ).toEqual({ PATH: '/usr/bin', HOME: '/root' });
  });

  it('reports nothing when the shell never reached the probe', () => {
    expect(parseLoginShellEnvOutput('command not found: env')).toBeNull();
  });
});

describe('native login-shell probe ownership', () => {
  it.effect(
    'times out the whole shell tree and reports failure instead of an absent environment',
    () => {
      const table = new FakeProcessTable();
      table.queueSpawn({ ignores: ['SIGTERM'] });
      return Effect.gen(function* () {
        const ready = yield* Deferred.make<void>();
        let descendant = -1;
        const layer = loginShellEnvLayer({
          nodeProcess: {
            ...table.api,
            spawn: (command, args, options) => {
              const child = table.api.spawn(command, args, options);
              descendant = table.addDescendant(child.pid!, { ignores: ['SIGTERM'] });
              Deferred.doneUnsafe(ready, Effect.void);
              return child;
            },
          },
        });
        const fiber = yield* Effect.forkChild(
          probeLoginShellEnv({ shell: '/bin/sh', env: {}, timeout: 1000 }).pipe(
            Effect.provide(layer)
          )
        );
        yield* Deferred.await(ready);
        yield* TestClock.adjust(999);
        expect(table.isAlive(1000)).toBe(true);
        expect(table.isAlive(descendant)).toBe(true);
        yield* TestClock.adjust(1);
        const exit = yield* Fiber.await(fiber);
        if (!Exit.isFailure(exit)) throw new Error('Expected probe timeout');
        expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toBeInstanceOf(
          CommandTimedOut
        );
        expect(table.isAlive(1000)).toBe(false);
        expect(table.isAlive(descendant)).toBe(false);
      });
    }
  );

  it.effect('interruption joins cleanup before returning, including an orphaned descendant', () => {
    const table = new FakeProcessTable();
    return Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      const layer = loginShellEnvLayer({
        nodeProcess: {
          ...table.api,
          spawn: (command, args, options) => {
            const child = table.api.spawn(command, args, options);
            Deferred.doneUnsafe(ready, Effect.void);
            return child;
          },
        },
      });
      const fiber = yield* Effect.forkChild(
        probeLoginShellEnv({ shell: '/bin/sh', env: {} }).pipe(Effect.provide(layer))
      );
      yield* Deferred.await(ready);
      const descendant = table.addDescendant(1000);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(table.isAlive(1000)).toBe(false);
      expect(table.isAlive(descendant)).toBe(false);
    });
  });

  it.effect(
    'retains a failed release owner alongside the timeout and can retry its cleanup',
    () => {
      const table = new FakeProcessTable();
      table.queueSpawn({ ignores: ['SIGTERM', 'SIGKILL'] });
      return Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          probeLoginShellEnv({ shell: '/bin/sh', env: {}, timeout: 1000 })
        );
        yield* TestClock.adjust(1000);
        yield* TestClock.adjust(1000);
        const exit = yield* Fiber.await(fiber);
        if (!Exit.isFailure(exit)) throw new Error('Expected timeout and failed release');
        expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toBeInstanceOf(
          CommandTimedOut
        );
        const failure = squashProcessFailure(exit.cause);
        expect(failure).toBeInstanceOf(ProcessCleanupFailed);
        if (!(failure instanceof ProcessCleanupFailed)) throw new Error('Missing recovery owner');
        const owner = failure.releases[0]!;
        expect(yield* owner.isAlive).toBe(true);
        table.exitOnItsOwn(1000);
        yield* owner.retryTermination();
        expect(yield* owner.isAlive).toBe(false);
      }).pipe(Effect.provide(loginShellEnvLayer({ nodeProcess: table.api })));
    }
  );

  it.effect(
    'fallbacks share the original Clock deadline instead of receiving a fresh budget',
    () => {
      const table = new FakeProcessTable();
      return Effect.gen(function* () {
        const ready = yield* Deferred.make<void>();
        const fallbackReady = yield* Deferred.make<void>();
        const layer = loginShellEnvLayer({
          nodeProcess: {
            ...table.api,
            spawn: (command, args, options) => {
              const child = table.api.spawn(command, args, options);
              Deferred.doneUnsafe(command === '/bin/sh' ? ready : fallbackReady, Effect.void);
              return child;
            },
          },
        });
        const fiber = yield* Effect.forkChild(
          probeLoginShellEnv({ shell: '/bin/sh', env: {}, timeout: 1000 }).pipe(
            Effect.provide(layer)
          )
        );
        yield* Deferred.await(ready);
        yield* TestClock.adjust(600);
        table.exitOnItsOwn(1000, 1);
        yield* Deferred.await(fallbackReady);
        yield* TestClock.adjust(400);
        expect(table.isAlive(1001)).toBe(false);
        const exit = yield* Fiber.await(fiber);
        if (!Exit.isFailure(exit)) throw new Error('Expected shared deadline failure');
        expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toBeInstanceOf(
          CommandTimedOut
        );
        expect(table.isAlive(1001)).toBe(false);
      });
    }
  );

  it.effect(
    'an inaccessible shell remains a startup failure rather than trying a different identity',
    () => {
      const table = new FakeProcessTable();
      table.queueSpawn({
        failWith: Object.assign(new Error('permission denied'), { code: 'EACCES' }),
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(probeLoginShellEnv({ shell: '/private/shell', env: {} }));
        if (!Exit.isFailure(exit)) throw new Error('Expected startup failure');
        const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
        expect(error).toBeInstanceOf(SpawnFailed);
        expect((error as SpawnFailed).cause).toMatchObject({ code: 'EACCES' });
      }).pipe(
        Effect.provide(
          loginShellEnvLayer({
            nodeProcess: {
              ...table.api,
              spawn: (command, args, options) => {
                const child = table.api.spawn(command, args, options);
                if (child.pid !== undefined) {
                  table
                    .childOf(child.pid)!
                    .stdout.write(
                      '_LODY_SHELL_ENV_DELIMITER_PATH=/wrong-fallback\0_LODY_SHELL_ENV_DELIMITER_'
                    );
                  queueMicrotask(() => table.exitOnItsOwn(child.pid!));
                }
                return child;
              },
            },
          })
        )
      );
    }
  );

  it.effect('the Legacy entry signal cancels the native probe and awaits its tree cleanup', () => {
    const table = new FakeProcessTable();
    return Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      const controller = new AbortController();
      const promise = probeLoginShellEnvLegacy({
        shell: '/bin/sh',
        env: {},
        processOptions: {
          signal: controller.signal,
          nodeProcess: {
            ...table.api,
            spawn: (command, args, options) => {
              const child = table.api.spawn(command, args, options);
              Deferred.doneUnsafe(ready, Effect.void);
              return child;
            },
          },
        },
      });
      // Attach rejection handling before the cancellation signal fires.
      const result = promise.then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error })
      );
      yield* Deferred.await(ready);
      const descendant = table.addDescendant(1000);
      controller.abort();
      expect((yield* Effect.promise(() => result)).ok).toBe(false);
      expect(table.isAlive(1000)).toBe(false);
      expect(table.isAlive(descendant)).toBe(false);
    });
  });

  it.effect(
    'restores probe-only variables from the invocation snapshot even when input mutates',
    () => {
      const table = new FakeProcessTable();
      return Effect.gen(function* () {
        const ready = yield* Deferred.make<void>();
        const env = { HOME: '/profile', ZSH_TMUX_AUTOSTART: 'true' };
        const layer = loginShellEnvLayer({
          nodeProcess: {
            ...table.api,
            spawn: (command, args, options) => {
              const child = table.api.spawn(command, args, options);
              Deferred.doneUnsafe(ready, Effect.void);
              return child;
            },
          },
        });
        const fiber = yield* Effect.forkChild(
          probeLoginShellEnv({ shell: '/bin/sh', env }).pipe(Effect.provide(layer))
        );
        yield* Deferred.await(ready);
        env.ZSH_TMUX_AUTOSTART = 'changed-after-start';
        table
          .childOf(1000)!
          .stdout.write(
            '_LODY_SHELL_ENV_DELIMITER_PATH=/profile/bin\0ZSH_TMUX_AUTOSTART=false\0DISABLE_AUTO_UPDATE=true\0_LODY_SHELL_ENV_DELIMITER_'
          );
        table.exitOnItsOwn(1000);
        expect(yield* Fiber.join(fiber)).toEqual({
          PATH: '/profile/bin',
          ZSH_TMUX_AUTOSTART: 'true',
        });
      });
    }
  );

  it.effect('Windows absence does not evaluate host environment or launch a POSIX process', () =>
    probeLoginShellEnv().pipe(
      Effect.provide(
        LoginShellEnvironmentLive.pipe(
          Layer.provide(
            Layer.merge(
              Layer.succeed(LoginShellHost, {
                platform: 'win32',
                env: Effect.die('unexpected env read'),
                shellFor: () => Effect.die('unexpected shell read'),
              }),
              processLayer({ nodeProcess: new FakeProcessTable('win32').api })
            )
          )
        )
      ),
      Effect.tap((env) => Effect.sync(() => expect(env).toBeNull()))
    )
  );
});
