import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach } from 'vitest';
import { describe, expect, it } from '@effect/vitest';
import {
  Cause,
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Scope,
} from 'effect';
import { TestClock } from 'effect/testing';

import {
  LoginShellHost,
  LoginShellCache,
  LoginShellCacheLive,
  LoginShellCacheClosed,
  LoginShellCacheShutdownFailed,
  LoginShellEnvironment,
  recoverLoginShellCacheShutdown,
  LoginShellEnvironmentLive,
  loginShellEnvLayer,
  parseLoginShellEnvOutput,
  probeLoginShellEnv,
} from '../src/node/login-shell-env';
import {
  CommandTimedOut,
  SpawnFailed,
  ProcessCleanupFailed,
  squashProcessFailure,
  processLayer,
} from '../src/node/process';
import { makeApplicationRuntime } from '../src/node/application-runtime';
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

describe('application-owned login-shell cache', () => {
  it.effect(
    'a timed-out or cancelled reader leaves the shared producer available to other readers',
    () =>
      Effect.gen(function* () {
        const value = yield* Deferred.make<NodeJS.ProcessEnv>();
        const started = yield* Deferred.make<void>();
        const finished = yield* Deferred.make<void>();
        const layer = LoginShellCacheLive.pipe(
          Layer.provide(
            Layer.succeed(LoginShellEnvironment, {
              probe: () =>
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(value)),
                  Effect.ensuring(Deferred.succeed(finished, undefined))
                ),
            })
          )
        );
        yield* Effect.gen(function* () {
          const cache = yield* LoginShellCache;
          const early = yield* cache.get(3000).pipe(Effect.forkChild);
          yield* Deferred.await(started);
          const cancelled = yield* cache.get().pipe(Effect.forkChild);
          const waiting = yield* cache.get().pipe(Effect.forkChild);
          yield* Fiber.interrupt(cancelled);
          yield* TestClock.adjust(3000);
          expect(yield* Fiber.join(early)).toBeNull();
          expect(Deferred.isDoneUnsafe(finished)).toBe(false);
          const env = { PATH: '/profile/bin' };
          yield* Deferred.succeed(value, env);
          expect(yield* Fiber.join(waiting)).toBe(env);
          expect(yield* cache.peek).toBe(env);
          expect(yield* cache.get()).toBe(env);
        }).pipe(Effect.provide(layer));
        expect(Deferred.isDoneUnsafe(finished)).toBe(true);
      })
  );

  it.effect('concurrent shutdown waits for producer cleanup and refuses new requests', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const cleaning = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let held = false;
      const layer = LoginShellCacheLive.pipe(
        Layer.provide(
          Layer.succeed(LoginShellEnvironment, {
            probe: () =>
              Effect.acquireUseRelease(
                Effect.sync(() => {
                  held = true;
                }),
                () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
                () =>
                  Deferred.succeed(cleaning, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(
                      Effect.sync(() => {
                        held = false;
                      })
                    )
                  )
              ),
          })
        )
      );
      yield* Effect.gen(function* () {
        const cache = yield* LoginShellCache;
        yield* cache.warmup;
        yield* Deferred.await(started);
        const first = yield* cache.shutdown.pipe(Effect.forkChild);
        yield* Deferred.await(cleaning);
        const second = yield* cache.shutdown.pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(first.pollUnsafe()).toBeUndefined();
        expect(second.pollUnsafe()).toBeUndefined();
        expect(held).toBe(true);
        const denied = yield* cache.warmup.pipe(Effect.exit);
        expect(
          Exit.isFailure(denied) && Option.getOrUndefined(Cause.findErrorOption(denied.cause))
        ).toBeInstanceOf(LoginShellCacheClosed);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        expect(held).toBe(false);
      }).pipe(Effect.provide(layer));
    })
  );

  it.effect(
    'application disposal stops and joins the real process service producer including descendants',
    () => {
      const table = new FakeProcessTable();
      return Effect.gen(function* () {
        const ready = yield* Deferred.make<void>();
        const scope = yield* Scope.make();
        const context = yield* Layer.build(
          LoginShellCacheLive.pipe(
            Layer.provide(
              loginShellEnvLayer({
                nodeProcess: {
                  ...table.api,
                  spawn: (command, args, options) => {
                    const child = table.api.spawn(command, args, options);
                    Deferred.doneUnsafe(ready, Effect.void);
                    return child;
                  },
                },
              })
            ),
            Layer.provide(
              Layer.succeed(LoginShellHost, {
                platform: 'linux',
                env: () => ({}),
                shell: () => '/bin/sh',
              })
            )
          )
        ).pipe(Scope.provide(scope));
        yield* Effect.flatMap(LoginShellCache, (cache) => cache.warmup).pipe(
          Effect.provideContext(context)
        );
        yield* Deferred.await(ready);
        const descendant = table.addDescendant(1000);
        expect(table.isAlive(1000)).toBe(true);
        yield* Scope.close(scope, Exit.void);
        expect(table.isAlive(1000)).toBe(false);
        expect(table.isAlive(descendant)).toBe(false);
      });
    }
  );

  it.effect('keeps a late native failure for all later readers without restarting the probe', () =>
    Effect.gen(function* () {
      const failure = new Error('probe infrastructure failed');
      const result = yield* Deferred.make<never, Error>();
      yield* Effect.gen(function* () {
        const cache = yield* LoginShellCache;
        const early = yield* cache.get(3000).pipe(Effect.forkChild);
        yield* TestClock.adjust(3000);
        expect(yield* Fiber.join(early)).toBeNull();
        yield* Deferred.fail(result, failure);
        for (const read of [cache.get(), cache.peek, cache.get()]) {
          const exit = yield* read.pipe(Effect.exit);
          expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(failure);
        }
      }).pipe(
        Effect.provide(
          LoginShellCacheLive.pipe(
            Layer.provide(
              Layer.succeed(LoginShellEnvironment, {
                probe: () => Deferred.await(result).pipe(Effect.orDie),
              })
            )
          )
        )
      );
    })
  );

  it.effect(
    'application concurrent disposal joins one receipt and failed recovery keeps the original owner',
    () =>
      Effect.gen(function* () {
        const cleaning = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const resource = { held: false, denied: true };
        const leaseFailure = { resource };
        const recoveryFailure = new Error('still denied');
        const layer = Layer.effectDiscard(
          Effect.acquireRelease(
            Effect.sync(() => {
              resource.held = true;
            }),
            () =>
              Deferred.succeed(cleaning, undefined).pipe(
                Effect.andThen(Deferred.await(gate)),
                Effect.andThen(Effect.die(leaseFailure))
              )
          )
        );
        const application = makeApplicationRuntime(layer, {
          recover: (cause) =>
            Effect.gen(function* () {
              expect(
                cause.reasons.some((r) => Cause.isDieReason(r) && r.defect === leaseFailure)
              ).toBe(true);
              if (resource.denied) return yield* Effect.fail(recoveryFailure);
              resource.held = false;
              return undefined;
            }),
          project: (cause) => cause,
        });
        yield* Effect.promise(() => application.runtime.runPromise(Effect.void));
        const first = application.closeLegacy().catch((error) => error);
        yield* Deferred.await(cleaning);
        const second = application.closeLegacy().catch((error) => error);
        let settled = false;
        const observed = second.then((result) => {
          settled = true;
          return result;
        });
        yield* Effect.yieldNow;
        expect(settled).toBe(false);
        expect(resource.held).toBe(true);
        yield* Deferred.succeed(gate, undefined);
        const firstCause = yield* Effect.promise(() => first) as Cause.Cause<unknown>;
        expect(
          firstCause.reasons.some((r) => Cause.isDieReason(r) && r.defect === leaseFailure)
        ).toBe(true);
        expect(yield* Effect.promise(() => observed)).toBe(firstCause);
        const recoveryCause = yield* Effect.promise(() =>
          application.closeLegacy().catch((error) => error)
        ) as Cause.Cause<unknown>;
        expect(
          recoveryCause.reasons.some((r) => Cause.isDieReason(r) && r.defect === leaseFailure)
        ).toBe(true);
        expect(
          recoveryCause.reasons.some((r) => Cause.isFailReason(r) && r.error === recoveryFailure)
        ).toBe(true);
        expect(resource.held).toBe(true);
        resource.denied = false;
        yield* Effect.promise(() => application.closeLegacy());
        expect(resource.held).toBe(false);
      })
  );
});

it.effect(
  'failed shell application disposal retains process leases across repeated recovery and releases before replacement',
  () => {
    const table = new FakeProcessTable();
    let denied = true;
    return Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      let cleanup = false;
      let now = 0;
      // The application runtime is an external entry, so explicitly inject its
      // deterministic Clock as well as the process boundary. Its probe deadline
      // stays pending; cleanup polling advances only after shutdown is requested.
      const clock: Clock.Clock = {
        currentTimeMillisUnsafe: () => now,
        currentTimeMillis: Effect.sync(() => now),
        currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
        currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
        monotonicTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
        monotonicTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
        sleep: (duration) =>
          Effect.suspend(() =>
            cleanup
              ? Effect.sync(() => {
                  now += Duration.toMillis(duration);
                })
              : Effect.never
          ),
      };
      const application = makeApplicationRuntime(
        LoginShellCacheLive.pipe(
          Layer.provide(
            loginShellEnvLayer({
              nodeProcess: {
                ...table.api,
                spawn: (command, args, options) => {
                  const child = table.api.spawn(command, args, options);
                  Deferred.doneUnsafe(ready, Effect.void);
                  return child;
                },
                kill: (target, signal) => {
                  if (signal !== 0 && denied)
                    throw Object.assign(new Error('denied'), { code: 'EPERM' });
                  table.api.kill(target, signal);
                },
              },
            })
          ),
          Layer.provideMerge(Layer.succeed(Clock.Clock, clock))
        ),
        { recover: recoverLoginShellCacheShutdown, project: Cause.squash }
      );
      yield* Effect.promise(() =>
        application.runtime.runPromise(Effect.flatMap(LoginShellCache, (cache) => cache.warmup))
      );
      yield* Deferred.await(ready);
      const descendant = table.addDescendant(1000);
      cleanup = true;
      const first = yield* Effect.promise(() => application.closeLegacy().catch((error) => error));
      expect(first).toBeInstanceOf(LoginShellCacheShutdownFailed);
      if (!(first instanceof LoginShellCacheShutdownFailed))
        throw new Error('missing shutdown owner');
      expect(first.releases.length).toBeGreaterThan(0);
      expect(application.isReleased()).toBe(false);
      expect(table.isAlive(1000)).toBe(true);
      yield* Effect.promise(() => application.closeLegacy().catch((error) => error));
      expect(application.isReleased()).toBe(false);
      expect(table.isAlive(descendant)).toBe(true);
      denied = false;
      yield* Effect.promise(() => application.closeLegacy());
      expect(application.isReleased()).toBe(true);
      expect(table.isAlive(1000)).toBe(false);
      expect(table.isAlive(descendant)).toBe(false);
    });
  }
);
