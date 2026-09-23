import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildLoroStreamsTokenEndpoint,
  createLoroStreamsTokenProvider,
  LORO_STREAMS_TOKEN_STORAGE_KEY_PREFIX,
  LoroStreamsTokenRequestSchema,
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
    vi.useFakeTimers();
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

  it('builds the token endpoint from a base url', () => {
    expect(buildLoroStreamsTokenEndpoint('https://convex.example.com/')).toBe(
      'https://convex.example.com/api/loro-streams/token'
    );
  });

  it('normalizes and validates token request workspace ids', () => {
    expect(LoroStreamsTokenRequestSchema.parse({ workspaceId: ' workspace-1 ' })).toEqual({
      workspaceId: 'workspace-1',
    });

    expect(LoroStreamsTokenRequestSchema.safeParse({ workspaceId: 'workspace/1' }).success).toBe(
      false
    );
    expect(LoroStreamsTokenRequestSchema.safeParse({ workspaceId: '' }).success).toBe(false);
  });

  it('caches the token until it is near expiry', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            token: 'jwt-1',
            expiresIn: 900,
            gatewayBaseUrl: 'https://streams-api.example.com',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );

    const provider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token',
      fetchImpl,
    });

    await expect(provider.getToken()).resolves.toBe('jwt-1');
    await expect(provider.getToken()).resolves.toBe('jwt-1');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(provider.getGatewayBaseUrl()).toBe('https://streams-api.example.com');
  });

  it('refreshes the token after the cache window', async () => {
    let counter = 0;
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            token: `jwt-${++counter}`,
            expiresIn: 60,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );

    const provider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token',
      fetchImpl,
      refreshSkewMs: 5_000,
    });

    await expect(provider.getToken()).resolves.toBe('jwt-1');
    vi.advanceTimersByTime(54_000);
    await expect(provider.getToken()).resolves.toBe('jwt-1');
    vi.advanceTimersByTime(2_000);
    await expect(provider.getToken()).resolves.toBe('jwt-2');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('supports a getter function for authToken that is called on each fetch', async () => {
    let currentToken = 'token-v1';
    let counter = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const authHeader = (init?.headers as Record<string, string>)?.Authorization;
      return new Response(
        JSON.stringify({
          token: `jwt-${++counter}-${authHeader}`,
          expiresIn: 60,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const provider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: () => currentToken,
      fetchImpl,
      refreshSkewMs: 5_000,
    });

    // First fetch uses token-v1
    const jwt1 = await provider.getToken();
    expect(jwt1).toBe('jwt-1-Bearer token-v1');

    // Simulate auth token refresh (e.g. after sleep/wake)
    currentToken = 'token-v2';

    // Advance past cache window to force re-fetch
    vi.advanceTimersByTime(56_000);
    const jwt2 = await provider.getToken();
    expect(jwt2).toBe('jwt-2-Bearer token-v2');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('supports an async getter function for authToken', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: 'jwt-async', expiresIn: 900 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );

    const provider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: async () => 'async-token',
      fetchImpl,
    });

    await expect(provider.getToken()).resolves.toBe('jwt-async');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://convex.example.com/api/loro-streams/token',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer async-token',
        }),
      })
    );
  });

  it('fails closed when the current login cannot be resolved', async () => {
    let available = true;
    const provider = createLoroStreamsTokenProvider({
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

  it('invalidate() forces a fresh token fetch on the next getToken() call', async () => {
    let counter = 0;
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: `jwt-${++counter}`, expiresIn: 900 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );

    const provider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token',
      fetchImpl,
    });

    // First fetch
    await expect(provider.getToken()).resolves.toBe('jwt-1');
    // Still within cache window — should reuse cached token
    await expect(provider.getToken()).resolves.toBe('jwt-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Invalidate clears cache, forcing a fresh fetch
    provider.invalidate();
    await expect(provider.getToken()).resolves.toBe('jwt-2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('invalidate() prevents a stale in-flight fetch from populating the cache', async () => {
    let resolveFetch: ((res: Response) => void) | null = null;

    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );

    const provider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token',
      fetchImpl,
    });

    // Start a fetch (goes in-flight); flush microtasks so resolveAuthToken() completes
    const tokenPromise1 = provider.getToken();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const staleResolve = resolveFetch!;

    // Invalidate while the first fetch is still in-flight
    provider.invalidate();

    // Start a new fetch (should create a new in-flight request)
    const tokenPromise2 = provider.getToken();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const freshResolve = resolveFetch!;

    // Resolve the stale fetch first — it must NOT overwrite the cache
    staleResolve(
      new Response(JSON.stringify({ token: 'stale-jwt', expiresIn: 900 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    await expect(tokenPromise1).rejects.toThrow('superseded');

    // Resolve the fresh fetch
    freshResolve(
      new Response(JSON.stringify({ token: 'fresh-jwt', expiresIn: 900 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    await expect(tokenPromise2).resolves.toBe('fresh-jwt');

    // Subsequent calls must return the fresh token, not the stale one
    await expect(provider.getToken()).resolves.toBe('fresh-jwt');
    // No additional fetch — the fresh token is cached
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('createAuthCallback() invalidates on unauthorized and returns a fresh token', async () => {
    let counter = 0;
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: `jwt-${++counter}`, expiresIn: 900 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );

    const provider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token',
      fetchImpl,
    });

    const authCallback = provider.createAuthCallback();

    // Normal request — fetches and caches
    await expect(authCallback({ reason: 'request' })).resolves.toBe('jwt-1');
    await expect(authCallback({ reason: 'request' })).resolves.toBe('jwt-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Unauthorized — invalidates cache, fetches fresh token
    await expect(authCallback({ reason: 'unauthorized' })).resolves.toBe('jwt-2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('createAuthCallback() returns undefined for permanent auth rejection', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('revoked', {
          status: 401,
        })
    );

    const provider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'revoked-token',
      fetchImpl,
    });

    const authCallback = provider.createAuthCallback();

    await expect(authCallback({ reason: 'request' })).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('createAuthCallback() does not refetch after permanent auth rejection for the same auth token', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('forbidden', {
          status: 403,
        })
    );

    const provider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'forbidden-token',
      fetchImpl,
    });

    const authCallback = provider.createAuthCallback();

    await expect(authCallback({ reason: 'request' })).resolves.toBeUndefined();
    await expect(authCallback({ reason: 'request' })).resolves.toBeUndefined();
    await expect(authCallback({ reason: 'unauthorized' })).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('terminal auth failure clears automatically once the auth token changes', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('forbidden', {
          status: 403,
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: 'jwt-after-rotation', expiresIn: 900 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

    let currentAuthToken: string = 'forbidden-token';
    const provider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: () => currentAuthToken,
      fetchImpl,
    });

    await expect(provider.getToken()).rejects.toThrow('status=403');
    await expect(provider.getToken()).rejects.toThrow('status=403');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    currentAuthToken = 'fresh-token';

    await expect(provider.getToken()).resolves.toBe('jwt-after-rotation');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
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

    const provider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'forbidden-token',
      fetchImpl,
    });

    await expect(provider.getToken()).rejects.toThrow('status=403');
    await expect(provider.getToken()).rejects.toThrow('status=403');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    provider.invalidate();

    await expect(provider.getToken()).resolves.toBe('jwt-after-recovery');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('createAuthCallback() returns undefined when the caller has no auth token', async () => {
    const fetchImpl = vi.fn();

    const provider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: () => null,
      fetchImpl,
    });

    const authCallback = provider.createAuthCallback();

    await expect(authCallback({ reason: 'request' })).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('createAuthCallback() keeps transient token fetch failures retryable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('token service unavailable');
    });

    const provider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token',
      fetchImpl,
    });

    const authCallback = provider.createAuthCallback();

    await expect(authCallback({ reason: 'request' })).rejects.toThrow('token service unavailable');
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

    const firstProvider = createLoroStreamsTokenProvider({
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
    const secondProvider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token',
      fetchImpl: secondFetchImpl,
    });

    await expect(secondProvider.getToken()).resolves.toBe('jwt-from-network');
    expect(secondFetchImpl).not.toHaveBeenCalled();
    expect(secondProvider.getGatewayBaseUrl()).toBe('https://streams-api.example.com');
  });

  it('emits non-sensitive events for cache and fetch decisions', async () => {
    const events: unknown[] = [];
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: 'jwt-from-network', expiresIn: 900 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );

    const provider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token',
      fetchImpl,
      onEvent: (event) => events.push(event),
    });

    await expect(provider.getToken()).resolves.toBe('jwt-from-network');
    await expect(provider.getToken()).resolves.toBe('jwt-from-network');

    expect(events).toEqual([
      expect.objectContaining({ type: 'cache-miss', reason: 'missing' }),
      expect.objectContaining({ type: 'fetch-start' }),
      expect.objectContaining({ type: 'fetch-success' }),
      expect.objectContaining({ type: 'cache-hit' }),
    ]);
    expect(JSON.stringify(events)).not.toContain('jwt-from-network');
  });

  it('writes fetched tokens to localStorage without storing plaintext JWTs', async () => {
    const storageKey = `${LORO_STREAMS_TOKEN_STORAGE_KEY_PREFIX}:${JSON.stringify(['https://convex.example.com/api/loro-streams/token', 'workspace-1'])}`;
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            token: 'jwt-1',
            expiresIn: 900,
            gatewayBaseUrl: 'https://streams-api.example.com',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );

    const provider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token',
      fetchImpl,
    });

    await provider.getToken();

    const stored = localStorageMock.getItem(storageKey);
    expect(stored).not.toBeNull();
    expect(stored).not.toContain('jwt-1');
    expect(JSON.parse(stored!)).toEqual({
      version: 2,
      algorithm: 'AES-GCM',
      iv: expect.any(String),
      ciphertext: expect.any(String),
    });

    provider.invalidate();

    expect(localStorageMock.getItem(storageKey)).toBeNull();
  });

  it('ignores an encrypted cache when the auth token changes and fetches a fresh JWT', async () => {
    const storageKey = `${LORO_STREAMS_TOKEN_STORAGE_KEY_PREFIX}:${JSON.stringify(['https://convex.example.com/api/loro-streams/token', 'workspace-1'])}`;
    const firstProvider = createLoroStreamsTokenProvider({
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
    const secondProvider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token-v2',
      fetchImpl: secondFetchImpl,
    });

    await expect(secondProvider.getToken()).resolves.toBe('jwt-v2');
    expect(secondFetchImpl).toHaveBeenCalledTimes(1);
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

    const provider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token',
      fetchImpl,
    });

    await expect(provider.getToken()).resolves.toBe('jwt-fresh');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const stored = localStorageMock.getItem(storageKey);
    expect(stored).not.toBeNull();
    expect(stored).not.toContain('legacy-plaintext-jwt');
    expect(stored).not.toContain('jwt-fresh');
  });

  it('ignores encrypted localStorage cache entries inside the refresh skew', async () => {
    const firstProvider = createLoroStreamsTokenProvider({
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
    const secondProvider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token',
      fetchImpl: secondFetchImpl,
      refreshSkewMs: 30_000,
    });

    await expect(secondProvider.getToken()).resolves.toBe('jwt-fresh');
    expect(secondFetchImpl).toHaveBeenCalledTimes(1);
  });
  it('coalesces staggered unauthorized calls and ignores late failures on a shared callback', async () => {
    let finish!: (response: Response) => void;
    let started!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let requests = 0;
    const provider = createLoroStreamsTokenProvider({
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
    const provider = createLoroStreamsTokenProvider({
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

  it('rejects an old login response after a new login has populated the cache', async () => {
    let login = 'alice';
    let finish!: (response: Response) => void;
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const provider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: () => login,
      fetchImpl: async (_url, init) => {
        if (new Headers(init?.headers).get('Authorization') === 'Bearer alice') {
          started();
          return new Promise<Response>((resolve) => {
            finish = resolve;
          });
        }
        return new Response(JSON.stringify({ token: 'bob-token', expiresIn: 900 }));
      },
    });
    const old = provider.getToken();
    await requestStarted;
    login = 'bob';
    expect(await provider.getToken()).toBe('bob-token');
    finish(new Response(JSON.stringify({ token: 'alice-token', expiresIn: 900 })));
    await expect(old).rejects.toThrow('superseded');
    expect(await provider.getToken()).toBe('bob-token');
  });

  it('does not hydrate a token issued by another endpoint or workspace', async () => {
    const make = (endpoint: string, workspaceId: string) =>
      createLoroStreamsTokenProvider({
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

  it('fences publication when login changes between async validation and its continuation', async () => {
    Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true });
    let login = 'alice';
    let resolutions = 0;
    let newer: Promise<unknown> | undefined;
    const provider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: () => {
        const captured = login;
        if (++resolutions === 5)
          queueMicrotask(() => {
            login = 'bob';
            newer = provider.getToken().catch((error) => error);
          });
        return captured;
      },
      fetchImpl: async (_url, init) =>
        new Headers(init?.headers).get('Authorization') === 'Bearer alice'
          ? new Response(JSON.stringify({ token: 'alice-token', expiresIn: 900 }))
          : new Response('', { status: 500 }),
    });
    await expect(provider.getToken()).rejects.toThrow('superseded');
    await newer;
    await expect(provider.getToken()).rejects.toThrow('status=500');
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
    let armed = false;
    const provider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token',
      refreshSkewMs: 5_000,
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
    const hydrated = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token',
      refreshSkewMs: 5_000,
      fetchImpl: hydratedFetch,
    });
    expect(await hydrated.getToken()).toBe('jwt-2');
    expect(hydratedFetch).not.toHaveBeenCalled();
  });

  it('keeps the rejection marker and the cache clean when the issuer ignores rejectedToken', async () => {
    const storageKey = `${LORO_STREAMS_TOKEN_STORAGE_KEY_PREFIX}:${JSON.stringify(['https://convex.example.com/api/loro-streams/token', 'workspace-1'])}`;
    const bodies: Array<{ workspaceId: string; rejectedToken?: string }> = [];
    const provider = createLoroStreamsTokenProvider({
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
      const provider = createLoroStreamsTokenProvider({
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
    let armed = false;
    let failRetry = true;
    const provider = createLoroStreamsTokenProvider({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace-1',
      authToken: 'raw-token',
      refreshSkewMs: 5_000,
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
