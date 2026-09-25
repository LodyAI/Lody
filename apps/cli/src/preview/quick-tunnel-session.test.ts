import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREVIEW_IDLE_TIMEOUT_MS, type SessionId } from '@lody/shared';
import { createLogger } from '@/utils/logger';
import { CloudflaredError } from './cloudflared-process';
import { QuickTunnelSession } from './quick-tunnel-session';

const logger = createLogger({ level: 'silent', transports: 'console' });

function fixture(overrides: Partial<ConstructorParameters<typeof QuickTunnelSession>[0]> = {}) {
  let now = 1_800_000_000_000;
  let proxyOrigin = '';
  const exited = Promise.withResolvers<CloudflaredError | null>();
  const session = new QuickTunnelSession({
    sessionId: 'session-quick-test' as SessionId,
    target: { protocol: 'http', host: '127.0.0.1', port: 5173 },
    logger,
    runtimeBaseUrl: 'https://runtime.example.test',
    now: () => now,
    download: async () => '/synthetic/cloudflared',
    start: async (options) => {
      proxyOrigin = options.proxyOrigin;
      return {
        origin: 'https://synthetic-preview.trycloudflare.com',
        closed: exited.promise,
        diagnostic: () => undefined,
        stop: async () => {
          exited.resolve(null);
        },
      };
    },
    verify: async () => undefined,
    ...overrides,
  });
  return {
    session,
    exited,
    advance: (ms: number) => {
      now += ms;
    },
    proxyOrigin: () => proxyOrigin,
  };
}

describe('QuickTunnelSession ownership and idle expiry', () => {
  afterEach(() => vi.useRealTimers());

  it('expires at one hour without renewal from status/probes and releases its listener', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { session, advance, proxyOrigin } = fixture();
    await session.ready;
    const deadline = session.expiresAt;
    advance(59 * 60_000);
    await vi.advanceTimersByTimeAsync(59 * 60_000);
    expect(session.active).toBe(true);
    expect(session.activity(false)).toBe(true);
    expect(session.expiresAt).toBe(deadline);
    advance(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await session.closed).toEqual({ reason: 'idle_timeout' });
    expect(session.active).toBe(false);
    vi.useRealTimers();
    await expect(fetch(proxyOrigin())).rejects.toThrow();
  });

  it('renews real activity but never revives an expired endpoint after a delayed timer', async () => {
    const { session, advance } = fixture();
    await session.ready;
    const firstDeadline = session.expiresAt;
    advance(30 * 60_000);
    expect(session.activity(true)).toBe(true);
    expect(session.expiresAt).toBe((firstDeadline ?? 0) + 30 * 60_000);
    // Simulate sleep: wall time advanced, but the event-loop timer has not fired.
    advance(DEFAULT_PREVIEW_IDLE_TIMEOUT_MS);
    expect(session.activity(true)).toBe(false);
    expect(await session.closed).toEqual({ reason: 'idle_timeout' });
    expect(session.activity(true)).toBe(false);
  });

  it('cancels acquisition and rejects a late download result without activating', async () => {
    const downloaded = Promise.withResolvers<string>();
    const { session } = fixture({ download: async () => downloaded.promise });
    const ready = expect(session.ready).rejects.toThrow('revoked');
    session.cancel('revoked');
    downloaded.resolve('/synthetic/cloudflared');
    await ready;
    expect(await session.closed).toEqual({ reason: 'revoked' });
    expect(session.active).toBe(false);
  });

  it('closes an active endpoint on child exit and retains the actual error', async () => {
    const { session, exited, proxyOrigin } = fixture();
    await session.ready;
    const error = new CloudflaredError('connection', 'synthetic process exit');
    exited.resolve(error);
    expect((await session.closed).error).toBe(error);
    expect(session.active).toBe(false);
    await expect(fetch(proxyOrigin())).rejects.toThrow();
  });

  it('does not turn failed process cleanup into successful closure', async () => {
    const { session } = fixture({
      start: async () => ({
        origin: 'https://synthetic-preview.trycloudflare.com',
        closed: new Promise(() => undefined),
        diagnostic: () => undefined,
        stop: async () => {
          throw new Error('synthetic cleanup failure');
        },
      }),
    });
    await session.ready;
    await expect(session.close('revoked')).rejects.toThrow('cleanup failed');
    const result = await session.closed;
    expect(result.error).toBeInstanceOf(AggregateError);
    expect(session.active).toBe(false);
  });

  it('shares concurrent health observations without renewing or recreating the endpoint', async () => {
    const entered = Promise.withResolvers<void>();
    const checked = Promise.withResolvers<void>();
    let healthRequests = 0;
    const { session, advance } = fixture({
      verify: async ({ mode }) => {
        if (mode !== 'health') return;
        if (++healthRequests > 1) throw new Error('Duplicate concurrent health request');
        entered.resolve();
        await checked.promise;
      },
    });
    await session.ready;
    const deadline = session.expiresAt;
    advance(30 * 60_000);
    const first = session.checkHealth();
    await entered.promise;
    const second = session.checkHealth();
    checked.resolve();
    await Promise.all([first, second]);
    expect(session.active).toBe(true);
    expect(session.expiresAt).toBe(deadline);
    await session.close('revoked');
  });

  it('retains the public failure cause and last sanitized connector diagnostic', async () => {
    const original = new Error('Public route timed out');
    let proxyOrigin = '';
    const { session } = fixture({
      verify: async () => {
        throw original;
      },
      start: async (options) => {
        proxyOrigin = options.proxyOrigin;
        return {
          origin: 'https://synthetic-preview.trycloudflare.com',
          closed: new Promise(() => undefined),
          diagnostic: () => 'Failed to dial edge: connection timeout',
          stop: async () => {
            // Actual listener release is checked below; no arbitrary process exists.
            expect(options.signal.aborted).toBe(true);
          },
        };
      },
    });
    await expect(session.ready).rejects.toThrow(
      'last cloudflared error: Failed to dial edge: connection timeout'
    );
    const outcome = await session.closed;
    expect(outcome.error?.cause).toBe(original);
    expect(session.active).toBe(false);
    await expect(fetch(proxyOrigin)).rejects.toThrow();
  });
});
