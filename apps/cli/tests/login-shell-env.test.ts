import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the underlying probe so we can drive its timing deterministically. The
// opt-out test never reaches it (shouldSkip short-circuits), so the default
// vi.fn() is harmless there.
vi.mock('shell-env', () => ({ shellEnv: vi.fn() }));

import { shellEnv } from 'shell-env';

import {
  getCachedLoginShellEnvSync,
  getLoginShellEnv,
  resetLoginShellEnvCache,
} from '../src/agent/login-shell-env';

describe('login-shell-env opt-out', () => {
  afterEach(() => {
    delete process.env.LODY_DISABLE_SHELL_ENV;
    resetLoginShellEnvCache();
  });

  it('LODY_DISABLE_SHELL_ENV=1 yields an empty overlay without spawning a shell', async () => {
    process.env.LODY_DISABLE_SHELL_ENV = '1';

    // Both accessors must short-circuit to {} so the withDefaultAcpPathEntries
    // fallback is the only thing that touches PATH when the user opts out.
    expect(getCachedLoginShellEnvSync()).toEqual({});
    await expect(getLoginShellEnv()).resolves.toEqual({});
  });
});

describe('login-shell-env slow-probe recovery', () => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    delete process.env.LODY_DISABLE_SHELL_ENV;
    resetLoginShellEnvCache();
    vi.mocked(shellEnv).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetLoginShellEnvCache();
  });

  it('skips the shell probe on Windows', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    expect(getCachedLoginShellEnvSync()).toEqual({});
    await expect(getLoginShellEnv()).resolves.toEqual({});
    expect(shellEnv).not.toHaveBeenCalled();
  });

  it('serves the real env to later awaiters once a slow probe lands after the timeout', async () => {
    vi.useFakeTimers();
    let resolveProbe!: (env: NodeJS.ProcessEnv) => void;
    vi.mocked(shellEnv).mockReturnValue(
      new Promise<NodeJS.ProcessEnv>((resolve) => {
        resolveProbe = resolve;
      })
    );

    // First awaiter kicks off the probe + the 3s timeout; the timeout wins so the
    // early caller gets the empty overlay (and falls back to default PATH dirs).
    const firstAwait = getLoginShellEnv();
    await vi.advanceTimersByTimeAsync(3000);
    await expect(firstAwait).resolves.toEqual({});

    // The slow profile finally lands.
    resolveProbe({ PATH: '/opt/homebrew/bin' });
    await vi.runAllTimersAsync();

    // The memoized promise must now serve the real env — otherwise async callers
    // (acp-runner aux sessions, history-sync) would be stuck on {} for the whole
    // process while the sync accessor recovered, a permanent disagreement.
    expect(getCachedLoginShellEnvSync()).toEqual({ PATH: '/opt/homebrew/bin' });
    await expect(getLoginShellEnv()).resolves.toEqual({ PATH: '/opt/homebrew/bin' });
  });
});
