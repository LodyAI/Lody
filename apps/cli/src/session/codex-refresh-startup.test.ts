import { describe, expect, it } from 'vitest';
import { runCodexRefreshStartupWithRetry } from './codex-refresh-startup';

const contention = () =>
  Object.assign(new Error('Internal error'), {
    data: {
      kind: 'codex_refresh_contention',
      message: 'This Codex account could not refresh.',
    },
  });

describe('managed Codex refresh startup recovery', () => {
  it('releases the failed process, waits, revalidates the provider, and starts a new process once', async () => {
    const events: string[] = [];
    let releaseWait: (() => void) | undefined;
    let markWaiting: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      markWaiting = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      releaseWait = resolve;
    });
    const recovery = runCodexRefreshStartupWithRetry({
      attempt: async () => {
        events.push('spawn');
        throw contention();
      },
      retryAttempt: async () => {
        events.push('provider-current');
        events.push('spawn');
        return 'new-native-process';
      },
      cleanupFailedAttempt: async () => {
        events.push('old-process-exited');
      },
      waitForRetry: async () => {
        events.push('waiting');
        markWaiting?.();
        await wait;
      },
    });

    await waiting;
    expect(events).toEqual(['spawn', 'old-process-exited', 'waiting']);
    releaseWait?.();
    expect(await recovery).toBe('new-native-process');
    expect(events).toEqual(['spawn', 'old-process-exited', 'waiting', 'provider-current', 'spawn']);
  });

  it('does not retry unrelated errors or unmanaged profiles', async () => {
    const attempts: string[] = [];
    const attempt = async () => {
      attempts.push('spawn');
      throw contention();
    };
    await expect(
      runCodexRefreshStartupWithRetry({
        attempt,
        cleanupFailedAttempt: async () => {
          attempts.push('cleanup');
        },
      })
    ).rejects.toThrow('Internal error');
    await expect(
      runCodexRefreshStartupWithRetry({
        attempt: async () => {
          attempts.push('unrelated');
          throw new Error('The account was revoked');
        },
        cleanupFailedAttempt: async () => {
          attempts.push('cleanup');
        },
        retryAttempt: async () => {
          attempts.push('revalidate');
          return 'unexpected';
        },
      })
    ).rejects.toThrow('The account was revoked');
    expect(attempts).toEqual(['spawn', 'unrelated']);
  });

  it('does not launch after the provider is removed while waiting', async () => {
    const events: string[] = [];
    await expect(
      runCodexRefreshStartupWithRetry({
        attempt: async () => {
          events.push('spawn');
          throw contention();
        },
        cleanupFailedAttempt: async () => {
          events.push('old-process-exited');
        },
        waitForRetry: async () => {
          events.push('waited');
        },
        retryAttempt: async () => {
          events.push('provider-removed');
          throw new Error('This Codex provider account is no longer available');
        },
      })
    ).rejects.toThrow('This Codex provider account is no longer available');
    expect(events).toEqual(['spawn', 'old-process-exited', 'waited', 'provider-removed']);
  });

  it('stops after one retry even when the new native process also fails', async () => {
    const events: string[] = [];
    await expect(
      runCodexRefreshStartupWithRetry({
        attempt: async () => {
          events.push('spawn');
          throw new Error('Still unavailable', { cause: contention() });
        },
        retryAttempt: async () => {
          events.push('provider-current');
          events.push('spawn');
          throw new Error('Still unavailable', { cause: contention() });
        },
        cleanupFailedAttempt: async () => {
          events.push('old-process-exited');
        },
        waitForRetry: async () => {
          events.push('waited');
        },
      })
    ).rejects.toThrow('Still unavailable');
    expect(events).toEqual(['spawn', 'old-process-exited', 'waited', 'provider-current', 'spawn']);
  });

  it('does not restart after cancellation during the wait', async () => {
    const controller = new AbortController();
    const events: string[] = [];
    await expect(
      runCodexRefreshStartupWithRetry({
        attempt: async () => {
          events.push('spawn');
          throw contention();
        },
        cleanupFailedAttempt: async () => {
          events.push('old-process-exited');
        },
        waitForRetry: async () => {
          controller.abort();
        },
        retryAttempt: async () => {
          events.push('provider-current');
          throw new Error('unexpected retry');
        },
        abortSignal: controller.signal,
      })
    ).rejects.toThrow();
    expect(events).toEqual(['spawn', 'old-process-exited']);
  });
});
