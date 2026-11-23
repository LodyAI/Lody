import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach } from 'vitest';
import { describe, expect, it } from '@effect/vitest';
import { Cause, Deferred, Effect, Exit, Fiber, Option } from 'effect';
import { TestClock } from 'effect/testing';

import { loginShellEnvLayer, probeLoginShellEnv } from '../src/node/login-shell-env';
import { CommandTimedOut, SpawnFailed } from '../src/node/process';

import { FakeProcessTable } from '../src/node/process-testing';

const runProbe = (options: Parameters<typeof probeLoginShellEnv>[0]) =>
  Effect.runPromise(probeLoginShellEnv(options).pipe(Effect.provide(loginShellEnvLayer())));

// Real shells under a throwaway HOME: the probe's contract is what a login
// shell's rc files leave in its environment.
describe.skipIf(process.platform === 'win32')('login-shell probe profiles', () => {
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

    const result = await runProbe({
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
    const result = await runProbe({
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

      const result = await runProbe({
        shell: '/nonexistent/lody-shell',
        env: env(),
        timeout: '10 seconds',
      });

      expect(result?.LODY_PROBE_VALUE).toBe('fallback');
    }
  );
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
});
