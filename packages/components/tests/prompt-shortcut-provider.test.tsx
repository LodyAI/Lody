import {
  closePromptShortcutDatabase,
  promptShortcutDatabaseName,
} from '../src/lib/prompt-shortcut-storage';
import { PromptShortcutSync as ActualShortcutSync } from '../../shared/src/prompt-shortcuts/sync';
import { getShortcutBodyStreamId } from '../../shared/src/prompt-shortcuts/access';
import { LoroDoc } from 'loro-crdt';
import type { LoroRepo } from 'loro-repo';
import {
  ShortcutTokenAttempts,
  ShortcutTokenAttemptError,
} from '../src/lib/shortcut-token-attempt';
import { isConvexUnauthenticatedError } from '@lody/shared';
import type { ShortcutTokenReply, ShortcutTokenRequest } from '@lody/cloud-api';
// @vitest-environment jsdom
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PromptShortcutRuntime } from '@lody/shared/prompt-shortcuts';

const fixture = vi.hoisted(() => {
  const session = { status: 'authenticated', user: { id: 'user-a' } };
  const makePlatform = () => ({
    capabilities: new Set(['cloudAccount']),
    identity: { session: { get: () => session } },
  });
  return {
    session,
    auth: {
      authSessionId: 'session-a' as string | null,
      confirmedUnauthenticated: false,
      requestAuthRecovery: vi.fn(),
    },
    makePlatform,
    platform: makePlatform(),
    workspaceId: 'workspace-a',
    status: 'allowed' as 'allowed' | 'pending' | 'blocked',
    directory: [],
    runtime: {} as Partial<import('../src/atoms/runtime').WorkspaceRuntime>,
    queryArgs: [] as unknown[],
    syncOptions: null as null | ConstructorParameters<typeof ActualShortcutSync>[0],
    createRepo: vi.fn(),
    openStore: vi.fn(),
    closeStore: vi.fn(),
    records: [] as unknown[],
  };
});

vi.mock('@/hooks/use-authenticated-convex', () => ({
  useOptionalAuthenticatedConvex: () => fixture.auth,
}));

vi.mock('jotai', async (original) => ({
  ...(await original<typeof import('jotai')>()),
  useAtomValue: () => ({ workspaceId: fixture.workspaceId, ...fixture.runtime }),
}));
vi.mock('@/hooks/use-workspace-feature', () => ({
  useLegacyWorkspaceQueryStatus: () => fixture.status,
  useLegacyWorkspaceQueriesEnabled: () => fixture.status === 'allowed',
  useAssertLegacyWorkspaceAccess: () => () => {
    if (fixture.status !== 'allowed') throw new Error('legacy admission pending');
  },
}));
vi.mock('@/atoms/runtime', () => ({ activeWorkspaceRuntimeAtom: 'workspace' }));
vi.mock('@/hooks/use-resolved-workspace-scope', () => ({
  useResolvedWorkspaceScope: ({ enabled }: { enabled: boolean }) => ({
    enabled,
    workspaceId: fixture.workspaceId,
  }),
}));
vi.mock('@lody/platform/react', () => ({
  usePlatform: () => fixture.platform,
  usePlatformSession: () => fixture.session,
  useCloudMutation: () => vi.fn(),
  useCloudAction: () => vi.fn(),
  useCloudQuery: (_: unknown, args: unknown) => {
    fixture.queryArgs.push(args);
    return args === 'skip' ? undefined : fixture.directory;
  },
}));
vi.mock('@/lib/cloud-api-operations', () => ({ cloudOperations: { promptShortcuts: {} } }));
vi.mock('loro-repo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('loro-repo')>();
  return { ...actual, LoroRepo: { create: fixture.createRepo } };
});
vi.mock('loro-repo/storage/indexeddb', () => ({ IndexedDBStorageAdaptor: class {} }));
vi.mock('@lody/shared/prompt-shortcuts', async () => {
  const { PromptShortcutRuntime: ActualRuntime } =
    await import('../../shared/src/prompt-shortcuts/runtime');
  return {
    PromptShortcutRuntime: ActualRuntime,
    LocalShortcutStore: { open: fixture.openStore },
    PromptShortcutSync: class {
      constructor(options: ConstructorParameters<typeof ActualShortcutSync>[0]) {
        fixture.syncOptions = options;
      }
      async dispose() {}
    },
    shortcutByteLength: (value: string) => value.length,
  };
});

import {
  PromptShortcutProvider,
  usePromptShortcuts,
} from '../src/providers/prompt-shortcut-provider';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('PromptShortcutProvider lifecycle', () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: PromptShortcutRuntime | null;
  let rendered: (PromptShortcutRuntime | null)[];

  function Consumer() {
    const shortcuts = usePromptShortcuts();
    current = shortcuts.runtime;
    rendered.push(current);
    return createElement('p', null, shortcuts.loading ? 'loading' : current?.workspaceId);
  }

  async function render(enabled = true) {
    await act(async () => {
      root.render(
        <StrictMode>
          <PromptShortcutProvider enabled={enabled}>
            <Consumer />
          </PromptShortcutProvider>
        </StrictMode>
      );
    });
    // The provider defers its loro/streams stack behind dynamic imports, which
    // settle on the event loop rather than inside act's microtask drain.
    await act(async () => {
      await vi.dynamicImportSettled();
    });
  }

  beforeEach(() => {
    fixture.workspaceId = 'workspace-a';
    fixture.auth.authSessionId = 'session-a';
    fixture.auth.confirmedUnauthenticated = false;
    fixture.status = 'allowed';
    fixture.runtime = {};
    fixture.queryArgs = [];
    fixture.syncOptions = null;
    fixture.platform = fixture.makePlatform();
    fixture.records = [];
    fixture.closeStore.mockReset().mockResolvedValue(undefined);
    fixture.createRepo.mockReset().mockImplementation(async () => ({ destroy: async () => {} }));
    fixture.openStore.mockReset().mockImplementation(async (identity) => ({
      ...identity,
      discovery: () => ({ directory: [], entries: [] }),
      list: () => fixture.records,
      applyRemoteDeletions: async () => {},
      cacheDiscovery: async () => {},
      dispose: () => fixture.closeStore(),
    }));
    current = null;
    rendered = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(['readiness', 'workspace'] as const)(
    'never resurrects a disposed runtime after %s returns to the same scope',
    async (transition) => {
      await render();
      const first = current!;
      expect(container.textContent).toBe('workspace-a');

      if (transition === 'workspace') fixture.workspaceId = 'workspace-b';
      await render(transition !== 'readiness');
      expect(() => first.setDirectory([])).toThrow('Shortcut runtime disposed');

      const opening = deferred();
      fixture.createRepo.mockImplementationOnce(async () => {
        await opening.promise;
        return { destroy: async () => {} };
      });
      fixture.workspaceId = 'workspace-a';
      rendered = [];
      await render();
      expect(current).toBeNull();
      expect(container.textContent).toBe('loading');
      expect(rendered).not.toContain(first);
      await act(async () => window.dispatchEvent(new Event('online')));

      await act(async () => opening.resolve());
      expect(current).not.toBeNull();
      expect(current).not.toBe(first);
      expect(container.textContent).toBe('workspace-a');
      await expect(current!.setDirectory([])).resolves.toBeUndefined();
    }
  );

  it('opens verified encrypted shortcuts while legacy access is blocked, uses protected grants and exposes guest read-only state', async () => {
    fixture.status = 'blocked';
    const localDataScope = {
      accountId: 'user-a',
      workspaceId: 'workspace-a',
      windowId: 'window',
      genesisHash: '11'.repeat(32),
      signingPublicKey: '22'.repeat(32),
    };
    fixture.runtime = {
      contentMode: 'e2ee',
      cloudStreamsEnabled: true,
      localDataScope,
      streamsContent: {
        mode: 'protected',
        namespace: 'test',
        resolve: () => {
          throw new Error('unused');
        },
        snapshotUpload: { canUpload: () => false },
      },
      shortcutRole: { get: () => 'read', subscribe: () => () => {} },
      getWorkspaceStreamsGrant: async (options) => {
        if (options?.write) throw new Error('guest write');
        return {
          token: 'encrypted-token',
          gatewayBaseUrl: 'https://gateway.test',
          bucketId: 'encrypted-content',
          shardHostSuffix: 'test',
        };
      },
    };
    await render();
    expect(current?.workspaceId).toBe('workspace-a');
    expect(current?.canWrite).toBe(false);
    expect(fixture.queryArgs.every((args) => args === 'skip')).toBe(true);
    const grant = await fixture.syncOptions!.grant(
      { kind: 'workspace-index', workspaceId: 'workspace-a' },
      false
    );
    expect(grant).toMatchObject({
      token: 'encrypted-token',
      bucketId: 'encrypted-content',
      shardHostSuffix: 'test',
      streamId: 'workspace-a:shortcut-index',
    });
    await expect(
      fixture.syncOptions!.grant({ kind: 'workspace-index', workspaceId: 'workspace-a' }, true)
    ).rejects.toThrow('read_only');
    await expect(
      fixture.syncOptions!.grant({ kind: 'body', bodyDocId: 'legacy' }, false)
    ).rejects.toThrow('legacy_forbidden');
    const captured = current!;
    const drain = deferred();
    fixture.closeStore.mockImplementationOnce(() => drain.promise);
    let closed = false;
    let closing!: Promise<void>;
    await act(async () => {
      closing = closePromptShortcutDatabase(
        promptShortcutDatabaseName('workspace-a', 'user-a', localDataScope)
      ).then(() => {
        closed = true;
      });
    });
    expect(current).toBeNull();
    expect(closed).toBe(false);
    expect(() => captured.flush()).toThrow('disposed');
    await act(async () => {
      drain.resolve();
      await closing;
    });
    expect(closed).toBe(true);
    fixture.auth.confirmedUnauthenticated = true;
    await render();
    expect(current).toBeNull();
  });

  it('retires the previous auth-session runtime even when the same account signs in again', async () => {
    await render();
    const first = current!;
    fixture.auth.authSessionId = null;
    await render();
    expect(current).toBe(first);
    fixture.auth.authSessionId = 'session-b';
    rendered = [];
    await render();
    expect(rendered).not.toContain(first);
    expect(current).not.toBe(first);
    expect(() => first.setDirectory([])).toThrow('Shortcut runtime disposed');
    fixture.auth.confirmedUnauthenticated = true;
    await render();
    expect(current).toBeNull();
  });

  it('keeps the old runtime hidden until its durable close finishes', async () => {
    await render();
    const first = current!;
    const closing = deferred();
    fixture.closeStore.mockImplementationOnce(() => closing.promise);
    await render(false);
    rendered = [];
    await render();
    expect(current).toBeNull();
    expect(rendered).not.toContain(first);
    expect(container.textContent).toBe('loading');

    await act(async () => closing.resolve());
    expect(current).not.toBeNull();
    expect(current).not.toBe(first);
    expect(container.textContent).toBe('workspace-a');
  });
  it('retires cloud shortcuts while admission is pending or encrypted and reopens after ordinary admission', async () => {
    fixture.status = 'allowed';
    await render();
    expect(container.textContent).toBe('workspace-a');
    fixture.status = 'pending';
    await render();
    expect(current).toBeNull();
    expect(container.textContent).toBe('loading');
    fixture.status = 'blocked';
    await render();
    expect(current).toBeNull();
    fixture.status = 'allowed';
    await render();
    expect(current).not.toBeNull();
  });

  it('keeps the local shortcut store available without cloud admission', async () => {
    fixture.platform.capabilities.clear();
    fixture.status = 'pending';
    await render();
    expect(current?.workspaceId).toBe('workspace-a');
    expect(container.textContent).toBe('workspace-a');
  });

  it('passes independent workspace webSocketAuth that keeps refreshing after provider auth-session disposal', async () => {
    const grantSpy = vi.fn(async (opts?: { forceRefresh?: boolean }) => ({
      token: opts?.forceRefresh ? 'ws-fresh-token' : 'ws-cached-token',
      gatewayBaseUrl: 'https://gateway.test',
    }));
    fixture.runtime = {
      streamsWebSocketEnabled: true,
      getWorkspaceStreamsGrant: grantSpy,
    };

    await render();
    expect(fixture.syncOptions?.webSocketEnabled).toBe(true);
    const webSocketAuth = fixture.syncOptions?.webSocketAuth;
    expect(webSocketAuth).toBeTypeOf('function');

    fixture.auth.authSessionId = 'session-b';
    await render();

    await expect(webSocketAuth!({ reason: 'request' })).resolves.toBe('ws-cached-token');
    await expect(
      webSocketAuth!({ reason: 'renew', previousToken: 'ws-cached-token' })
    ).resolves.toBe('ws-fresh-token');
    await expect(webSocketAuth!({ reason: 'reauth' })).resolves.toBe('ws-fresh-token');
    expect(grantSpy).toHaveBeenNthCalledWith(1, { forceRefresh: false });
    expect(grantSpy).toHaveBeenNthCalledWith(2, { forceRefresh: false });
    expect(grantSpy).toHaveBeenNthCalledWith(3, { forceRefresh: true });
    expect(grantSpy).toHaveBeenNthCalledWith(4, { forceRefresh: true });
  });
});

describe('Shortcut token attempt ownership', () => {
  const request: ShortcutTokenRequest = {
    workspaceId: 'ws',
    target: { kind: 'body', bodyDocId: 'body-a' },
    write: false,
  };
  const failure: ShortcutTokenReply = {
    ok: false,
    failure: { kind: 'retryable', code: 'exchange_unavailable', phase: 'exchange' },
  };
  const success: ShortcutTokenReply = {
    ok: true,
    grant: {
      token: 'synthetic-jwt',
      expiresIn: 900,
      gatewayBaseUrl: 'https://gateway.test',
      streamId: 'shortcut-body:body-a',
    },
  };
  function owner(attempt: (request: ShortcutTokenRequest) => Promise<ShortcutTokenReply>) {
    const reports: unknown[] = [];
    let recoveries = 0;
    const instance = new ShortcutTokenAttempts({
      attempt,
      legacy: async () => {
        if (!success.ok) throw new Error('fixture');
        return success.grant;
      },
      report: (value) => {
        reports.push(value);
      },
      authRejected: () => {
        recoveries++;
      },
      active: () => true,
    });
    return { instance, reports, recoveries: () => recoveries };
  }
  it('100 attempts retain one diagnostic and local count, success resets only that operation, and distinct faults remain visible', async () => {
    let reply = failure;
    const a = owner(async () => reply);
    for (let i = 0; i < 100; i++)
      await expect(a.instance.grant(request)).rejects.toBeInstanceOf(ShortcutTokenAttemptError);
    expect(a.reports).toEqual([failure.ok ? undefined : failure.failure]);
    expect(a.instance.counts()).toEqual([100]);
    await expect(
      a.instance.grant({ ...request, target: { kind: 'body', bodyDocId: 'body-b' } })
    ).rejects.toThrow();
    expect(a.reports).toHaveLength(2);
    reply = { ok: false, failure: { kind: 'fatal', code: 'exchange_invalid', phase: 'exchange' } };
    await expect(a.instance.grant(request)).rejects.toThrow();
    expect(a.reports).toHaveLength(3);
    reply = success;
    await expect(a.instance.grant(request)).resolves.toMatchObject({ token: 'synthetic-jwt' });
    reply = failure;
    await expect(a.instance.grant(request)).rejects.toThrow();
    expect(a.reports).toHaveLength(4);
    const b = owner(async () => failure);
    await expect(b.instance.grant(request)).rejects.toThrow();
    expect(b.reports).toHaveLength(1);
    a.instance.dispose();
    b.instance.dispose();
  });
  it('handled auth refusals keep the supervisor contract and do not generate diagnostics or replay', async () => {
    let calls = 0;
    const a = owner(async () => {
      calls++;
      return {
        ok: false,
        failure: { kind: 'denied', code: 'unauthenticated', phase: 'authorize' },
      };
    });
    for (let i = 0; i < 100; i++) {
      try {
        await a.instance.grant(request);
        throw new Error('unexpected success');
      } catch (error) {
        expect(isConvexUnauthenticatedError(error)).toBe(true);
      }
    }
    expect(calls).toBe(100);
    expect(a.reports).toEqual([]);
    expect(a.recoveries()).toBe(1);
    a.instance.dispose();
  });
  it('retirement fences late errors and late success cannot clear a newer completed failure', async () => {
    let release!: (reply: ShortcutTokenReply) => void;
    const a = owner(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const pending = a.instance.grant(request);
    const rejected = expect(pending).rejects.toThrow();
    a.instance.dispose();
    release(failure);
    await rejected;
    expect(a.reports).toEqual([]);
    expect(a.instance.counts()).toEqual([]);
    let first!: (reply: ShortcutTokenReply) => void;
    let calls = 0;
    const b = owner(() =>
      ++calls === 1
        ? new Promise((resolve) => {
            first = resolve;
          })
        : Promise.resolve(failure)
    );
    const stale = b.instance.grant(request);
    await expect(b.instance.grant(request)).rejects.toThrow();
    first(success);
    await stale;
    await expect(b.instance.grant(request)).rejects.toThrow();
    expect(b.reports).toHaveLength(1);
    expect(b.instance.counts()).toEqual([2]);
    b.instance.dispose();
  });
  it('real Streams auth refresh retains the handled failure identity instead of creating another reportable error', async () => {
    const doc = new LoroDoc();
    let now = 0;
    let grants = 0;
    const failure = new ShortcutTokenAttemptError({
      kind: 'retryable',
      code: 'exchange_unavailable',
      phase: 'exchange',
    });
    const sync = new ActualShortcutSync({
      content: { mode: 'plaintext' },
      now: () => now,
      repo: {
        acquireDoc: async () => ({ doc, release: async () => {} }),
        persistDocNow: async () => {},
      } as unknown as LoroRepo,
      grant: async () => {
        if (++grants > 1) throw failure;
        return {
          token: 'synthetic',
          expiresIn: 900,
          gatewayBaseUrl: 'https://gateway.test',
          streamId: getShortcutBodyStreamId('body-a'),
        };
      },
    });
    const lease = await sync.acquire({ kind: 'body', bodyDocId: 'body-a' }, false);
    now = 900_000;
    try {
      await expect(lease.sync()).rejects.toBe(failure);
    } finally {
      await lease.release();
      await sync.dispose();
      doc.free();
    }
  });

  it('only an explicit missing V2 endpoint negotiates legacy; unknown platform failures retain their identity', async () => {
    let attempts = 0;
    let legacy = 0;
    const a = new ShortcutTokenAttempts({
      attempt: async () => {
        attempts++;
        throw new Error('Could not find public function for promptShortcuts:getStreamTokenV2');
      },
      legacy: async () => {
        legacy++;
        if (!success.ok) throw new Error('fixture');
        return success.grant;
      },
      active: () => true,
      authRejected: () => {},
      report: () => {
        throw new Error('unexpected report');
      },
    });
    await a.grant(request);
    await a.grant(request);
    expect(attempts).toBe(1);
    expect(legacy).toBe(2);
    a.dispose();
    const fault = new Error('synthetic platform failure');
    const b = owner(async () => {
      throw fault;
    });
    await expect(b.instance.grant(request)).rejects.toBe(fault);
    expect(b.reports).toEqual([]);
    b.instance.dispose();
  });
});

describe('PromptShortcutSync workspace-index replica checkpoints', () => {
  function createFakeStreamsServer() {
    const batches: Uint8Array[] = [];
    const requests: Array<{ method: string; pathname: string; offset: string | null }> = [];
    const tail = () =>
      String(batches.reduce((sum, batch) => sum + batch.length, 0)).padStart(20, '0');
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const method = init?.method ?? 'GET';
      requests.push({
        method,
        pathname: url.pathname,
        offset: url.searchParams.get('offset'),
      });
      if (method === 'POST') {
        batches.push(new Uint8Array(await new Response(init?.body).arrayBuffer()));
        return new Response(null, {
          headers: {
            'Stream-Next-Offset': tail(),
            'Stream-Up-To-Date': 'true',
            'Producer-Epoch': new Headers(init?.headers).get('Producer-Epoch') ?? '0',
            'Producer-Seq': new Headers(init?.headers).get('Producer-Seq') ?? '0',
          },
        });
      }
      if (method === 'PUT') {
        return new Response(null, { status: 201, headers: { 'Stream-Next-Offset': tail() } });
      }
      if (url.pathname.endsWith('/bootstrap')) {
        return new Response(
          '--bytes\r\nContent-Type: application/octet-stream\r\n\r\n\r\n--bytes--\r\n',
          {
            headers: {
              'Content-Type': 'multipart/mixed; boundary=bytes',
              'Stream-Snapshot-Offset': '-1',
              'Stream-Next-Offset': '-1',
              'Stream-Up-To-Date': String(batches.length === 0),
            },
          }
        );
      }
      const offsetParam = url.searchParams.get('offset');
      const offsetBytes =
        offsetParam && /^\d+$/.test(offsetParam) ? Number.parseInt(offsetParam, 10) : 0;
      const all = Buffer.concat(batches);
      return new Response(all.subarray(offsetBytes), {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Stream-Next-Offset': tail(),
          'Stream-Up-To-Date': 'true',
        },
      });
    };
    return { fetchImpl, requests, tail };
  }

  it('persists workspace-index checkpoint across restart without re-bootstrapping and recovers cleanly after persist failure', async () => {
    const { indexedDB, IDBKeyRange } = await import('fake-indexeddb');
    vi.stubGlobal('indexedDB', indexedDB);
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    const { LoroRepo: RealLoroRepo } =
      await vi.importActual<typeof import('loro-repo')>('loro-repo');
    const { IndexedDBStorageAdaptor: RealIdbStorage } = await vi.importActual<
      typeof import('loro-repo/storage/indexeddb')
    >('loro-repo/storage/indexeddb');
    const { PromptShortcutCatalog } = await import('../../shared/src/prompt-shortcuts/catalog');
    const { getWorkspaceShortcutIndexStreamId } =
      await import('../../shared/src/prompt-shortcuts/access');

    const server = createFakeStreamsServer();
    vi.stubGlobal('fetch', server.fetchImpl);

    const workspaceId = 'ws-checkpoint';
    const streamId = getWorkspaceShortcutIndexStreamId(workspaceId);
    const resource = { kind: 'workspace-index', workspaceId } as const;
    const grant = async () => ({
      token: 'synthetic',
      expiresIn: 300,
      gatewayBaseUrl: 'https://gateway.test',
      streamId,
    });

    const entry1 = {
      v: 1 as const,
      id: 'sc-1',
      workspaceId,
      ownerUserId: 'user-a',
      name: 'First',
      slug: 'first',
      bodyDocId: 'sc-1',
      dependencySummary: [],
      scope: {},
      revision: 'rev-1',
      createdAt: 100,
      updatedAt: 100,
    };
    const entry2 = {
      v: 1 as const,
      id: 'sc-2',
      workspaceId,
      ownerUserId: 'user-a',
      name: 'Second',
      slug: 'second',
      bodyDocId: 'sc-2',
      dependencySummary: [],
      scope: {},
      revision: 'rev-2',
      createdAt: 200,
      updatedAt: 200,
    };

    const writerRepo = await RealLoroRepo.create({});
    const writerSync = new ActualShortcutSync({
      content: { mode: 'plaintext' },
      repo: writerRepo,
      workspaceId,
      now: () => 0,
      grant,
    });
    try {
      // Seed entry 1 on the fake Streams server.
      const wFlock = await writerRepo.acquireFlockDoc(streamId);
      new PromptShortcutCatalog(wFlock.flock).put(entry1);
      await wFlock.release();
      const wLease = await writerSync.acquire(resource, true);
      await wLease.sync();

      // Cold start on durable IndexedDB repo: bootstraps and persists checkpoint.
      const dbName = `shortcut-checkpoint-warm-${Date.now()}`;
      const repo1 = await RealLoroRepo.create({
        storageAdapter: new RealIdbStorage({ dbName }),
      });
      const sync1 = new ActualShortcutSync({
        content: { mode: 'plaintext' },
        repo: repo1,
        workspaceId,
        now: () => 0,
        grant,
      });
      server.requests.length = 0;
      const lease1 = await sync1.acquire(resource, false);
      await lease1.sync();
      const coldFlock = await repo1.acquireFlockDoc(streamId);
      expect(new PromptShortcutCatalog(coldFlock.flock).list().map((e) => e.id)).toEqual(['sc-1']);
      await coldFlock.release();
      expect(server.requests.some((r) => r.pathname.endsWith('/bootstrap'))).toBe(true);
      const offsetAfterCold = server.tail();
      await lease1.release();
      await sync1.dispose();
      await repo1.destroy();

      // Push entry 2 while client is offline.
      const wFlock2 = await writerRepo.acquireFlockDoc(streamId);
      new PromptShortcutCatalog(wFlock2.flock).put(entry2);
      await wFlock2.release();
      await wLease.sync();
      await wLease.release();

      // Warm restart on the same IndexedDB: must resume from persisted offset without /bootstrap.
      const repo2 = await RealLoroRepo.create({
        storageAdapter: new RealIdbStorage({ dbName }),
      });
      const sync2 = new ActualShortcutSync({
        content: { mode: 'plaintext' },
        repo: repo2,
        workspaceId,
        now: () => 0,
        grant,
      });
      server.requests.length = 0;
      const lease2 = await sync2.acquire(resource, false);
      await lease2.sync();
      expect(server.requests.some((r) => r.pathname.endsWith('/bootstrap'))).toBe(false);
      expect(server.requests.some((r) => r.offset === offsetAfterCold)).toBe(true);
      const warmFlock = await repo2.acquireFlockDoc(streamId);
      expect(
        new PromptShortcutCatalog(warmFlock.flock)
          .list()
          .map((e) => e.id)
          .sort()
      ).toEqual(['sc-1', 'sc-2']);
      await warmFlock.release();
      await lease2.release();
      await sync2.dispose();
      await repo2.destroy();

      // Persistence failure barrier: checkpoint must not advance when persistFlockDocNow rejects,
      // so reopening recovers the full catalog.
      const failDbName = `shortcut-checkpoint-fail-${Date.now()}`;
      const failRepo = await RealLoroRepo.create({
        storageAdapter: new RealIdbStorage({ dbName: failDbName }),
      });
      const persistSpy = vi
        .spyOn(failRepo, 'persistFlockDocNow')
        .mockRejectedValueOnce(new Error('disk full'));
      const failSync = new ActualShortcutSync({
        content: { mode: 'plaintext' },
        repo: failRepo,
        workspaceId,
        now: () => 0,
        grant,
      });
      const failLease = await failSync.acquire(resource, false);
      await expect(failLease.sync()).rejects.toThrow();
      persistSpy.mockRestore();
      await failLease.release();
      await failSync.dispose();
      await failRepo.destroy();

      const recoveredRepo = await RealLoroRepo.create({
        storageAdapter: new RealIdbStorage({ dbName: failDbName }),
      });
      const recoveredSync = new ActualShortcutSync({
        content: { mode: 'plaintext' },
        repo: recoveredRepo,
        workspaceId,
        now: () => 0,
        grant,
      });
      server.requests.length = 0;
      const recoveredLease = await recoveredSync.acquire(resource, false);
      await recoveredLease.sync();
      expect(server.requests.some((r) => r.pathname.endsWith('/bootstrap'))).toBe(true);
      const recoveredFlock = await recoveredRepo.acquireFlockDoc(streamId);
      expect(
        new PromptShortcutCatalog(recoveredFlock.flock)
          .list()
          .map((e) => e.id)
          .sort()
      ).toEqual(['sc-1', 'sc-2']);
      await recoveredFlock.release();
      await recoveredLease.release();
      await recoveredSync.dispose();
      await recoveredRepo.destroy();
    } finally {
      await writerSync.dispose();
      await writerRepo.destroy();
      vi.unstubAllGlobals();
    }
  });
});
