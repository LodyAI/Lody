import { it as effectIt } from '@effect/vitest';
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createLoroStreamsTokenProviderLegacy,
  LORO_STREAMS_TOKEN_STORAGE_KEY_PREFIX,
  LoroStreamsTokenPorts,
  LoroStreamsTokens,
  LoroStreamsTokensLive,
  LoroStreamsTokenWebLive,
  LoroStreamsTokenAuthError,
  describeLoroStreamsTokenCause,
  makeLoroStreamsTokenProvider,
  makeLoroStreamsTokenWebPorts,
  type LoroStreamsTokenProviderOptions,
} from '../src/loro-streams-auth';

type LocalStorageMock = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
};

function createLocalStorageMock(): LocalStorageMock {
  let store: Record<string, string> = {};
  return {
    getItem(key: string) {
      return store[key] ?? null;
    },
    setItem(key: string, value: string) {
      store[key] = value;
    },
    removeItem(key: string) {
      delete store[key];
    },
    clear() {
      store = {};
    },
  };
}

describe('loro streams auth helpers', () => {
  let localStorageMock: LocalStorageMock;

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    vi.setSystemTime(new Date('2026-03-19T00:00:00.000Z'));
    localStorageMock = createLocalStorageMock();
    Object.defineProperty(globalThis, 'localStorage', {
      value: localStorageMock,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(globalThis, 'localStorage', {
      value: undefined,
      writable: true,
      configurable: true,
    });
  });

  it('fails closed when the current login cannot be resolved', async () => {
    let available = true;
    const provider = createLoroStreamsTokenProviderLegacy({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: () => {
        if (!available) throw new Error('session unavailable');
        return 'auth';
      },
      fetchImpl: async () => new Response(JSON.stringify({ token: 'jwt', expiresIn: 900 })),
    });
    expect(await provider.getToken()).toBe('jwt');
    available = false;
    await expect(provider.getToken()).rejects.toThrow('session unavailable');
  });

  it('manual invalidate clears a permanent auth rejection so callers can retry', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('forbidden', {
          status: 403,
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: 'jwt-after-recovery', expiresIn: 900 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

    const provider = createLoroStreamsTokenProviderLegacy({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'forbidden-token',
      fetchImpl,
    });

    await expect(provider.getToken()).rejects.toThrow('status=403');
    await expect(provider.getToken()).rejects.toThrow('status=403');

    provider.invalidate();

    await expect(provider.getToken()).resolves.toBe('jwt-after-recovery');
  });

  it('reads an encrypted cached token from localStorage on initialization and avoids fetching', async () => {
    const storageKey = `${LORO_STREAMS_TOKEN_STORAGE_KEY_PREFIX}:${JSON.stringify(['https://convex.example.com/api/loro-streams/token', 'workspace-1'])}`;
    const firstFetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            token: 'jwt-from-network',
            expiresIn: 900,
            gatewayBaseUrl: 'https://streams-api.example.com',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );

    const firstProvider = createLoroStreamsTokenProviderLegacy({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token',
      fetchImpl: firstFetchImpl,
    });
    await expect(firstProvider.getToken()).resolves.toBe('jwt-from-network');
    const stored = localStorageMock.getItem(storageKey);
    expect(stored).not.toBeNull();
    expect(stored).not.toContain('jwt-from-network');

    const secondFetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: 'jwt-refetched', expiresIn: 900 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    const secondProvider = createLoroStreamsTokenProviderLegacy({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token',
      fetchImpl: secondFetchImpl,
    });

    await expect(secondProvider.getToken()).resolves.toBe('jwt-from-network');
    expect(secondProvider.getGatewayBaseUrl()).toBe('https://streams-api.example.com');
  });

  it('ignores an encrypted cache when the auth token changes and fetches a fresh JWT', async () => {
    const storageKey = `${LORO_STREAMS_TOKEN_STORAGE_KEY_PREFIX}:${JSON.stringify(['https://convex.example.com/api/loro-streams/token', 'workspace-1'])}`;
    const firstProvider = createLoroStreamsTokenProviderLegacy({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token-v1',
      fetchImpl: vi.fn(
        async () =>
          new Response(JSON.stringify({ token: 'jwt-v1', expiresIn: 900 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
      ),
    });
    await expect(firstProvider.getToken()).resolves.toBe('jwt-v1');
    const encryptedWithV1 = localStorageMock.getItem(storageKey);
    expect(encryptedWithV1).not.toBeNull();

    const secondFetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: 'jwt-v2', expiresIn: 900 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    const secondProvider = createLoroStreamsTokenProviderLegacy({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token-v2',
      fetchImpl: secondFetchImpl,
    });

    await expect(secondProvider.getToken()).resolves.toBe('jwt-v2');
    expect(localStorageMock.getItem(storageKey)).not.toBe(encryptedWithV1);
  });

  it('replaces legacy plaintext localStorage cache entries with encrypted cache entries', async () => {
    const storageKey = `${LORO_STREAMS_TOKEN_STORAGE_KEY_PREFIX}:${JSON.stringify(['https://convex.example.com/api/loro-streams/token', 'workspace-1'])}`;
    localStorageMock.setItem(
      storageKey,
      JSON.stringify({
        token: 'legacy-plaintext-jwt',
        expiresAtMs: Date.now() + 900_000,
        gatewayBaseUrl: 'https://streams-api.example.com',
      })
    );
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: 'jwt-fresh', expiresIn: 900 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );

    const provider = createLoroStreamsTokenProviderLegacy({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token',
      fetchImpl,
    });

    await expect(provider.getToken()).resolves.toBe('jwt-fresh');
    const stored = localStorageMock.getItem(storageKey);
    expect(stored).not.toBeNull();
    expect(stored).not.toContain('legacy-plaintext-jwt');
    expect(stored).not.toContain('jwt-fresh');
  });

  it('ignores encrypted localStorage cache entries inside the refresh skew', async () => {
    const firstProvider = createLoroStreamsTokenProviderLegacy({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token',
      fetchImpl: vi.fn(
        async () =>
          new Response(JSON.stringify({ token: 'jwt-stale', expiresIn: 10 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
      ),
    });
    await expect(firstProvider.getToken()).resolves.toBe('jwt-stale');

    const secondFetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: 'jwt-fresh', expiresIn: 900 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    const secondProvider = createLoroStreamsTokenProviderLegacy({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token',
      fetchImpl: secondFetchImpl,
      refreshSkewMs: 30_000,
    });

    await expect(secondProvider.getToken()).resolves.toBe('jwt-fresh');
  });
  it('coalesces staggered unauthorized calls and ignores late failures on a shared callback', async () => {
    let finish!: (response: Response) => void;
    let started!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let requests = 0;
    const provider = createLoroStreamsTokenProviderLegacy({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'auth',
      fetchImpl: async (_url, init) => {
        requests++;
        if (requests === 1) return new Response(JSON.stringify({ token: 'old', expiresIn: 900 }));
        expect(JSON.parse(String(init?.body)).rejectedToken).toBe('old');
        started();
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      },
    });
    const auth = provider.createAuthCallback();
    expect(await auth()).toBe('old');
    const first = auth({ reason: 'unauthorized', previousToken: 'old' });
    await refreshStarted;
    const rest = Array.from({ length: 19 }, () =>
      auth({ reason: 'unauthorized', previousToken: 'old' })
    );
    finish(new Response(JSON.stringify({ token: 'new', expiresIn: 900 })));
    expect(await Promise.all([first, ...rest])).toEqual(Array(20).fill('new'));
    expect(await auth({ reason: 'unauthorized', previousToken: 'old' })).toBe('new');
    expect(await provider.getToken()).toBe('new');
    expect(requests).toBe(2);
  });

  it('does not return a cached token across login changes or logout', async () => {
    let login: string | null = 'alice';
    const provider = createLoroStreamsTokenProviderLegacy({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: () => login,
      fetchImpl: async (_url, init) =>
        new Response(
          JSON.stringify({
            token: String(init?.headers && (init.headers as Record<string, string>).Authorization),
            expiresIn: 900,
          })
        ),
    });
    expect(await provider.getToken()).toBe('Bearer alice');
    login = 'bob';
    expect(await provider.getToken()).toBe('Bearer bob');
    login = null;
    expect(await provider.createAuthCallback()()).toBeUndefined();
  });

  it('retires the old login raw response before populating the new login cache', async () => {
    let login = 'alice';
    let finish!: (response: Response) => void;
    let start!: () => void;
    let abort!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      abort = resolve;
    });
    const provider = createLoroStreamsTokenProviderLegacy({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: () => login,
      fetchImpl: (_url, init) => {
        if (new Headers(init?.headers).get('Authorization') === 'Bearer alice') {
          init?.signal?.addEventListener('abort', abort, { once: true });
          start();
          return new Promise<Response>((resolve) => {
            finish = resolve;
          });
        }
        return Promise.resolve(
          new Response(JSON.stringify({ token: 'bob-token', expiresIn: 900 }))
        );
      },
    });
    const old = provider.getToken().catch((error: unknown) => error);
    await started;
    login = 'bob';
    const next = provider.getToken();
    await aborted;
    finish(new Response(JSON.stringify({ token: 'alice-token', expiresIn: 900 })));
    expect(await old).toBeInstanceOf(Error);
    expect(await next).toBe('bob-token');
    expect(await provider.getToken()).toBe('bob-token');
    await provider.close();
  });

  it('does not hydrate a token issued by another endpoint or workspace', async () => {
    const make = (endpoint: string, workspaceId: string) =>
      createLoroStreamsTokenProviderLegacy({
        endpoint,
        workspaceId,
        authToken: 'same-auth',
        fetchImpl: async () =>
          new Response(JSON.stringify({ token: endpoint + workspaceId, expiresIn: 900 })),
      });
    expect(await make('https://one.example', 'a').getToken()).toBe('https://one.examplea');
    expect(await make('https://two.example', 'a').getToken()).toBe('https://two.examplea');
    expect(await make('https://one.example', 'b').getToken()).toBe('https://one.exampleb');
  });

  it('does not republish a rejected JWT when unauthorized joins an earlier refresh', async () => {
    // The expiry-driven refresh below is sent before any rejection is known, so
    // its body cannot carry `rejectedToken`. An issuer that keeps handing back
    // its cached version would otherwise reinstate the token the gateway just
    // rejected, and clear the marker that would have told the issuer about it.
    const bodies: Array<{ workspaceId: string; rejectedToken?: string }> = [];
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refreshStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    // Armed explicitly rather than by counting calls, so inserting a request
    // cannot silently move which one is held open.
    let joined = 0;
    let signalJoined!: () => void;
    const allJoined = new Promise<void>((resolve) => {
      signalJoined = resolve;
    });
    let armed = false;
    const provider = createLoroStreamsTokenProviderLegacy({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token',
      refreshSkewMs: 5_000,
      onEvent: (event) => {
        if (event.type === 'in-flight-reuse' && ++joined === 20) signalJoined();
      },
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          workspaceId: string;
          rejectedToken?: string;
        };
        bodies.push(body);
        if (armed) {
          armed = false;
          started();
          await gate;
        }
        return new Response(
          JSON.stringify({
            token: body.rejectedToken === 'jwt-1' ? 'jwt-2' : 'jwt-1',
            expiresIn: 60,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      },
    });

    const auth = provider.createAuthCallback();
    expect(await auth({ reason: 'request' })).toBe('jwt-1');
    vi.advanceTimersByTime(56_000);
    armed = true;
    const expiryRefresh = auth({ reason: 'request' });
    await refreshStarted;

    // Twenty streams report the rejection while that refresh is still open.
    const rejections = Array.from({ length: 20 }, () =>
      auth({ reason: 'unauthorized', previousToken: 'jwt-1' })
    );
    await allJoined;
    release();

    expect(await expiryRefresh).toBe('jwt-2');
    expect(await Promise.all(rejections)).toEqual(Array(20).fill('jwt-2'));
    // The fan-out costs exactly one extra round trip, and only that one carries
    // the rejection: single-flight is preserved.
    expect(bodies).toEqual([
      { workspaceId: 'workspace-1' },
      { workspaceId: 'workspace-1' },
      { workspaceId: 'workspace-1', rejectedToken: 'jwt-1' },
    ]);
    expect(await provider.getToken()).toBe('jwt-2');

    // The persistent cache must hold the replacement, never the rejected JWT:
    // a fresh provider on the same credential hydrates without any network.
    const hydratedFetch = vi.fn();
    const hydrated = createLoroStreamsTokenProviderLegacy({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token',
      refreshSkewMs: 5_000,
      onEvent: (event) => {
        if (event.type === 'in-flight-reuse' && ++joined === 20) signalJoined();
      },
      fetchImpl: hydratedFetch,
    });
    expect(await hydrated.getToken()).toBe('jwt-2');
  });

  it('keeps the rejection marker and the cache clean when the issuer ignores rejectedToken', async () => {
    const storageKey = `${LORO_STREAMS_TOKEN_STORAGE_KEY_PREFIX}:${JSON.stringify(['https://convex.example.com/api/loro-streams/token', 'workspace-1'])}`;
    const bodies: Array<{ workspaceId: string; rejectedToken?: string }> = [];
    const provider = createLoroStreamsTokenProviderLegacy({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token',
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as { workspaceId: string });
        return new Response(JSON.stringify({ token: 'jwt-stuck', expiresIn: 900 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    const auth = provider.createAuthCallback();
    expect(await auth({ reason: 'request' })).toBe('jwt-stuck');
    expect(localStorageMock.getItem(storageKey)).not.toBeNull();

    // An older issuer ignores the field and returns the rejected version again.
    expect(await auth({ reason: 'unauthorized', previousToken: 'jwt-stuck' })).toBe('jwt-stuck');
    expect(bodies).toHaveLength(2);
    expect(bodies.at(-1)).toEqual({ workspaceId: 'workspace-1', rejectedToken: 'jwt-stuck' });
    // A rejected JWT must not outlive this process in the persistent cache: a
    // fresh provider would hydrate it with no marker left to suppress it.
    expect(localStorageMock.getItem(storageKey)).toBeNull();

    // The marker keeps travelling until the issuer honours it; retrying stays
    // bounded at one request per reported rejection.
    expect(await auth({ reason: 'unauthorized', previousToken: 'jwt-stuck' })).toBe('jwt-stuck');
    expect(bodies).toHaveLength(3);
    expect(bodies.at(-1)).toEqual({ workspaceId: 'workspace-1', rejectedToken: 'jwt-stuck' });
    expect(localStorageMock.getItem(storageKey)).toBeNull();
  });
  it('does not persist a JWT rejected while its encrypted write was in flight', async () => {
    // Encryption is several async WebCrypto calls, and `reset('unauthorized')`
    // keeps the generation, so the generation fence cannot see a rejection that
    // lands inside that window. Without a marker re-check at `setItem` time the
    // rejected JWT is written back after the invalidation already removed it.
    const storageKey = `${LORO_STREAMS_TOKEN_STORAGE_KEY_PREFIX}:${JSON.stringify(['https://convex.example.com/api/loro-streams/token', 'workspace-1'])}`;
    const subtle = globalThis.crypto.subtle;
    const realEncrypt = subtle.encrypt.bind(subtle);
    let releaseEncrypt!: () => void;
    let encryptStarted!: () => void;
    const encrypting = new Promise<void>((resolve) => {
      encryptStarted = resolve;
    });
    const encryptGate = new Promise<void>((resolve) => {
      releaseEncrypt = resolve;
    });
    let armed = false;
    const encryptSpy = vi
      .spyOn(subtle, 'encrypt')
      .mockImplementation(async (algorithm: never, key: never, data: never) => {
        if (armed) {
          armed = false;
          encryptStarted();
          await encryptGate;
        }
        return realEncrypt(algorithm, key, data);
      });

    try {
      const bodies: Array<{ workspaceId: string; rejectedToken?: string }> = [];
      const provider = createLoroStreamsTokenProviderLegacy({
        endpoint: 'https://convex.example.com/api/loro-streams/token',
        workspaceId: 'workspace-1',
        authToken: 'raw-token',
        fetchImpl: async (_url, init) => {
          const body = JSON.parse(String(init?.body)) as {
            workspaceId: string;
            rejectedToken?: string;
          };
          bodies.push(body);
          return new Response(
            JSON.stringify({
              token: body.rejectedToken === 'jwt-1' ? 'jwt-2' : 'jwt-1',
              expiresIn: 900,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        },
      });

      const auth = provider.createAuthCallback();
      // jwt-1 is genuinely published, so a stream can legitimately hold it.
      expect(await auth({ reason: 'request' })).toBe('jwt-1');

      // An expiry refresh gets the issuer's cached jwt-1 back; hold its write open.
      vi.advanceTimersByTime(880_000);
      armed = true;
      const refresh = auth({ reason: 'request' });
      await encrypting;
      // Only now does the stream holding jwt-1 report the gateway's 401.
      const rejected = auth({ reason: 'unauthorized', previousToken: 'jwt-1' });
      releaseEncrypt();
      await refresh;
      await rejected;

      expect(localStorageMock.getItem(storageKey)).toBeNull();
      // The marker survived, so the next refresh still delivers the rejection
      // and the provider recovers within one further round trip.
      expect(await auth({ reason: 'unauthorized', previousToken: 'jwt-1' })).toBe('jwt-2');
      expect(bodies.at(-1)).toEqual({ workspaceId: 'workspace-1', rejectedToken: 'jwt-1' });
    } finally {
      encryptSpy.mockRestore();
    }
  });

  it('keeps a failed rejection-carrying retry retryable and preserves the marker', async () => {
    const bodies: Array<{ workspaceId: string; rejectedToken?: string }> = [];
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refreshStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let joined = 0;
    let signalJoined!: () => void;
    const allJoined = new Promise<void>((resolve) => {
      signalJoined = resolve;
    });
    let armed = false;
    let failRetry = true;
    const provider = createLoroStreamsTokenProviderLegacy({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token',
      refreshSkewMs: 5_000,
      onEvent: (event) => {
        if (event.type === 'in-flight-reuse' && ++joined === 2) signalJoined();
      },
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          workspaceId: string;
          rejectedToken?: string;
        };
        bodies.push(body);
        if (armed) {
          armed = false;
          started();
          await gate;
        }
        if (body.rejectedToken === undefined) {
          return new Response(JSON.stringify({ token: 'jwt-1', expiresIn: 60 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (failRetry) {
          failRetry = false;
          return new Response('', { status: 500 });
        }
        return new Response(JSON.stringify({ token: 'jwt-2', expiresIn: 900 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    const auth = provider.createAuthCallback();
    expect(await auth({ reason: 'request' })).toBe('jwt-1');
    vi.advanceTimersByTime(56_000);
    armed = true;
    const expiryRefresh = auth({ reason: 'request' });
    await refreshStarted;
    const rejections = [
      auth({ reason: 'unauthorized', previousToken: 'jwt-1' }),
      auth({ reason: 'unauthorized', previousToken: 'jwt-1' }),
    ];
    await allJoined;
    release();

    // A transient failure on the retry stays a transient failure for every
    // joined caller: it must not be converted into a fatal auth rejection.
    await expect(expiryRefresh).rejects.toThrow('status=500');
    for (const pending of rejections) {
      await expect(pending).rejects.toThrow('status=500');
    }
    // The marker is not lost by the failure; the next attempt still carries it.
    expect(await auth({ reason: 'unauthorized', previousToken: 'jwt-1' })).toBe('jwt-2');
    expect(bodies.at(-1)).toEqual({ workspaceId: 'workspace-1', rejectedToken: 'jwt-1' });
  });
});

/** A synthetic raw HTTP boundary: abort signals and actual settlement are separate. */
function tokenHttpFixture(settleOnAbort = false) {
  const started = Deferred.makeUnsafe<void>();
  const aborted = Deferred.makeUnsafe<void>();
  let settle: ((response: Response) => void) | undefined;
  let signal: AbortSignal | null | undefined;
  let alive = false;
  const fetchImpl = (_url: string, init?: RequestInit) => {
    signal = init?.signal;
    alive = true;
    signal?.addEventListener(
      'abort',
      () => {
        Deferred.doneUnsafe(aborted, Effect.void);
        if (settleOnAbort)
          settle?.(new Response(JSON.stringify({ token: 'aborted', expiresIn: 900 })));
      },
      { once: true }
    );
    const pending = new Promise<Response>((resolve) => {
      settle = (response) => {
        alive = false;
        resolve(response);
      };
    });
    Deferred.doneUnsafe(started, Effect.void);
    return pending;
  };
  return {
    started: Deferred.await(started),
    aborted: Deferred.await(aborted),
    fetchImpl,
    alive: () => alive,
    signal: () => signal,
    finish: (token = 'jwt') => {
      if (!settle) throw new Error('HTTP fixture not started');
      settle(new Response(JSON.stringify({ token, expiresIn: 900 })));
    },
  };
}

const tokenOptions = { endpoint: 'https://tokens.example.test', workspaceId: 'workspace' };
const nativeProvider = (
  ports: LoroStreamsTokenPorts['Service'],
  options: LoroStreamsTokenProviderOptions = tokenOptions
) =>
  makeLoroStreamsTokenProvider(options).pipe(Effect.provideService(LoroStreamsTokenPorts, ports));

describe('native shared Streams token ownership', () => {
  effectIt.effect('one cancelled waiter preserves the other lease and the HTTP work', () =>
    Effect.gen(function* () {
      const http = tokenHttpFixture(true);
      const reused = Deferred.makeUnsafe<void>();
      const ports = makeLoroStreamsTokenWebPorts({
        credential: Effect.succeed('auth'),
        fetchImpl: http.fetchImpl,
      });
      const provider = yield* nativeProvider(ports, {
        ...tokenOptions,
        onEvent: (event) => {
          if (event.type === 'in-flight-reuse') Deferred.doneUnsafe(reused, Effect.void);
        },
      });
      const first = yield* Effect.forkChild(provider.getToken());
      yield* http.started;
      const second = yield* Effect.forkChild(provider.getToken());
      yield* Deferred.await(reused);
      yield* Fiber.interrupt(first);
      expect(http.alive()).toBe(true);
      expect(http.signal()?.aborted).toBe(false);
      http.finish('shared');
      expect(yield* Fiber.join(second)).toBe('shared');
      expect(http.alive()).toBe(false);
      yield* provider.close;
    })
  );

  effectIt.effect('deadline is failure, cancels raw HTTP, and does not become auth undefined', () =>
    Effect.gen(function* () {
      const http = tokenHttpFixture();
      const provider = yield* makeLoroStreamsTokenProvider({
        ...tokenOptions,
        requestTimeoutMs: 100,
      }).pipe(
        Effect.provideService(
          LoroStreamsTokenPorts,
          makeLoroStreamsTokenWebPorts({
            credential: Effect.succeed('auth'),
            fetchImpl: http.fetchImpl,
          })
        )
      );
      const waiter = yield* Effect.forkChild(provider.createAuthCallback()());
      yield* http.started;
      yield* TestClock.adjust(100);
      yield* http.aborted;
      http.finish('too-late');
      const exit = yield* Fiber.await(waiter);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit))
        expect(
          exit.cause.reasons.some(
            (reason) => Cause.isFailReason(reason) && Cause.isTimeoutError(reason.error)
          )
        ).toBe(true);
      expect(http.alive()).toBe(false);
      expect(provider.getGatewayBaseUrl()).toBeUndefined();
      yield* provider.close;
    })
  );

  effectIt.effect(
    'native Service/Layer keeps terminal auth suppression isolated to its credential',
    () =>
      Effect.gen(function* () {
        let login = 'revoked';
        const authorization: string[] = [];
        const program = Effect.gen(function* () {
          const provider = yield* LoroStreamsTokens;
          const auth = provider.createAuthCallback();
          const first = yield* Effect.exit(auth());
          const suppressed = yield* Effect.exit(auth({ reason: 'unauthorized' }));
          for (const result of [first, suppressed]) {
            expect(Exit.isFailure(result)).toBe(true);
            if (Exit.isFailure(result)) {
              const failure = result.cause.reasons.find(Cause.isFailReason)?.error;
              expect(failure).toBeInstanceOf(LoroStreamsTokenAuthError);
              expect(describeLoroStreamsTokenCause(result.cause)).toEqual({
                kinds: ['auth'],
                authStatuses: [403],
              });
            }
          }
          expect(yield* provider.health).toMatchObject({
            terminalAuthStatus: 403,
            hasCachedToken: false,
          });
          expect(authorization).toEqual(['Bearer revoked']);
          login = 'valid';
          expect(yield* auth()).toBe('valid-jwt');
          expect(authorization).toEqual(['Bearer revoked', 'Bearer valid']);
        });
        yield* program.pipe(
          Effect.provide(
            LoroStreamsTokensLive(tokenOptions).pipe(
              Layer.provide(
                LoroStreamsTokenWebLive({
                  credential: Effect.sync(() => login),
                  fetchImpl: async (_url, init) => {
                    const value = new Headers(init?.headers).get('Authorization') ?? '';
                    authorization.push(value);
                    return value === 'Bearer revoked'
                      ? new Response('', { status: 403 })
                      : new Response(JSON.stringify({ token: 'valid-jwt', expiresIn: 900 }));
                  },
                })
              )
            )
          )
        );
      })
  );

  effectIt.effect('encryption completion cannot write across a credential fence', () =>
    Effect.gen(function* () {
      let login = 'alice';
      const encrypting = yield* Deferred.make<void>();
      const encrypted = yield* Deferred.make<string>();
      const storage = createLocalStorageMock();
      const ports = makeLoroStreamsTokenWebPorts({
        credential: Effect.sync(() => login),
        storage,
        fetchImpl: async () => new Response(JSON.stringify({ token: 'alice', expiresIn: 900 })),
      });
      const provider = yield* nativeProvider({
        ...ports,
        encrypt: () =>
          Deferred.succeed(encrypting, undefined).pipe(Effect.andThen(Deferred.await(encrypted))),
        now: Clock.currentTimeMillis,
      });
      const waiter = yield* Effect.forkChild(provider.getToken());
      yield* Deferred.await(encrypting);
      login = 'bob';
      yield* Deferred.succeed(encrypted, 'ciphertext-from-alice');
      const exit = yield* Fiber.await(waiter);
      expect(Exit.isFailure(exit)).toBe(true);
      const key = `${LORO_STREAMS_TOKEN_STORAGE_KEY_PREFIX}:${JSON.stringify([tokenOptions.endpoint, tokenOptions.workspaceId])}`;
      expect(storage.getItem(key)).toBeNull();
      yield* provider.close;
    })
  );
});
