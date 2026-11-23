import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Cause, Effect, Layer } from 'effect';
import { makeApplicationRuntime } from '@lody/shared/node/application-runtime';
import { LoginShellCacheLive, LoginShellEnvironment } from '@lody/shared/node/login-shell-env';
import {
  bindLoginShellCacheLegacy,
  closeLoginShellApplicationLegacy,
  getCachedLoginShellEnvSyncLegacy,
  getLoginShellEnvLegacy,
} from '../src/agent/login-shell-env';

const bind = (probe: Effect.Effect<NodeJS.ProcessEnv | null>) => {
  const owner = makeApplicationRuntime(
    LoginShellCacheLive.pipe(
      Layer.provide(
        Layer.succeed(LoginShellEnvironment, {
          probe: () => probe,
        })
      )
    ),
    { recover: Effect.failCause, project: Cause.squash }
  );
  bindLoginShellCacheLegacy(owner);
  return owner;
};

describe('application-owned login shell launcher boundary', () => {
  beforeEach(() => {
    delete process.env.LODY_DISABLE_SHELL_ENV;
  });
  afterEach(async () => {
    await closeLoginShellApplicationLegacy();
    delete process.env.LODY_DISABLE_SHELL_ENV;
    vi.useRealTimers();
  });

  it('disabled probing yields an empty overlay without requiring an owner', async () => {
    process.env.LODY_DISABLE_SHELL_ENV = '1';
    expect(getCachedLoginShellEnvSyncLegacy()).toEqual({});
    await expect(getLoginShellEnvLegacy()).resolves.toEqual({});
  });

  it('a cold synchronous read starts the owned probe and both readers receive its late result', async () => {
    vi.useFakeTimers();
    const result = Promise.withResolvers<NodeJS.ProcessEnv>();
    bind(Effect.promise(() => result.promise));
    expect(getCachedLoginShellEnvSyncLegacy()).toEqual({});
    const first = getLoginShellEnvLegacy();
    await vi.advanceTimersByTimeAsync(3000);
    await expect(first).resolves.toEqual({});
    const env = { PATH: '/profile/bin' };
    result.resolve(env);
    await vi.advanceTimersByTimeAsync(0);
    expect(getCachedLoginShellEnvSyncLegacy()).toBe(env);
    await expect(getLoginShellEnvLegacy()).resolves.toBe(env);
  });

  it('an early failed probe remains visible to synchronous and asynchronous launchers', async () => {
    const failure = new Error('shell cleanup failed');
    bind(Effect.die(failure));
    await expect(getLoginShellEnvLegacy()).rejects.toBe(failure);
    expect(() => getCachedLoginShellEnvSyncLegacy()).toThrow(failure);
    await expect(getLoginShellEnvLegacy()).rejects.toBe(failure);
  });

  it('a late failure replaces the pending empty overlay and a closed generation cannot supply a new one', async () => {
    vi.useFakeTimers();
    const result = Promise.withResolvers<NodeJS.ProcessEnv>();
    const owner = bind(Effect.promise(() => result.promise));
    const early = getLoginShellEnvLegacy();
    await vi.advanceTimersByTimeAsync(3000);
    await expect(early).resolves.toEqual({});
    const failure = new Error('unreleased shell');
    result.reject(failure);
    await vi.advanceTimersByTimeAsync(0);
    expect(() => getCachedLoginShellEnvSyncLegacy()).toThrow(failure);
    await expect(getLoginShellEnvLegacy()).rejects.toBe(failure);
    await owner.closeLegacy();
    bind(Effect.succeed({ PATH: '/next-generation/bin' }));
    const next = getLoginShellEnvLegacy();
    await vi.advanceTimersByTimeAsync(0);
    await expect(next).resolves.toEqual({ PATH: '/next-generation/bin' });
  });

  it('application close waits for pending producer cleanup and rejects new launchers', async () => {
    const started = Promise.withResolvers<void>();
    const cleaning = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let held = false;
    bind(
      Effect.acquireUseRelease(
        Effect.sync(() => {
          held = true;
        }),
        () => Effect.sync(() => started.resolve()).pipe(Effect.andThen(Effect.never)),
        () =>
          Effect.sync(() => cleaning.resolve()).pipe(
            Effect.andThen(Effect.promise(() => release.promise)),
            Effect.andThen(
              Effect.sync(() => {
                held = false;
              })
            )
          )
      )
    );
    getCachedLoginShellEnvSyncLegacy();
    await started.promise;
    const closing = closeLoginShellApplicationLegacy();
    await cleaning.promise;
    expect(held).toBe(true);
    expect(() => bind(Effect.succeed({ PATH: '/unsafe-replacement' }))).toThrow('already bound');
    await expect(getLoginShellEnvLegacy()).rejects.toMatchObject({ _tag: 'LoginShellCacheClosed' });
    release.resolve();
    await closing;
    expect(held).toBe(false);
  });
});
