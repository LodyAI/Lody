import { describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import {
  readEagerSyncRejection,
  writeEagerSyncRejection,
} from '../src/providers/eager-sync-admission';
import { createLoroStreamsTokenProviderLegacy, type SessionId } from '@lody/shared';
import {
  createBackgroundSyncCoordinator,
  WEB_EAGER_SYNC_POLICY,
  type PrefetchOutcome,
} from '../src/providers/background-sync-coordinator';
import { LoroDoc, VersionVector } from 'loro-crdt';
import {
  base64ToBytes,
  bytesToBase64,
  buildDocUpdateChunkPayloads,
} from '@lody/shared/local-loro-data-plane';
import {
  type EagerSyncWorkerClientDeps,
  createEagerSyncWorkerClient,
} from '../src/providers/eager-sync-worker-client';
import { runEagerSyncWorkerTask } from '../src/providers/eager-sync-worker-task';
import {
  EAGER_SYNC_CACHE_DB,
  readEagerSyncSnapshot,
  writeEagerSyncSnapshot,
  type EagerSyncSnapshot,
} from '../src/providers/eager-sync-snapshot-cache';
import type {
  EagerSyncAuthContext,
  EagerSyncTransport,
  EagerSyncWorkerInput,
  EagerSyncWorkerOutput,
  LocalSyncEvent,
  LocalSyncMessage,
} from '../src/providers/eager-sync-worker-protocol';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class TestWorker {
  onmessage: ((event: MessageEvent<EagerSyncWorkerOutput>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  inputs: EagerSyncWorkerInput[] = [];
  constructor(private start: (worker: TestWorker) => void) {}
  postMessage(input: EagerSyncWorkerInput) {
    if (this.terminated) throw new Error('Posting to a terminated worker');
    this.inputs.push(input);
    if (input.type === 'start') this.start(this);
  }
  terminate() {
    this.terminated = true;
  }
  emit(data: EagerSyncWorkerOutput) {
    this.onmessage?.({ data } as MessageEvent<EagerSyncWorkerOutput>);
  }
}

function clientHarness(
  resolveTransport = async (): Promise<EagerSyncTransport> => ({ plane: 'local' }),
  readSnapshot = async (_scope: string, _roomId: string): Promise<EagerSyncSnapshot | undefined> =>
    undefined,
  auth: (context?: EagerSyncAuthContext) => Promise<string | undefined> = async () => {
    throw new Error('Local prefetch must never request cloud credentials');
  },
  overrides: Partial<EagerSyncWorkerClientDeps> = {}
) {
  const starts = [deferred<TestWorker>(), deferred<TestWorker>(), deferred<TestWorker>()];
  const created = deferred<TestWorker>();
  const workers: TestWorker[] = [];
  const sent: LocalSyncMessage[] = [];
  const listeners = new Set<(event: LocalSyncEvent) => void>();
  const client = createEagerSyncWorkerClient({
    content: { mode: 'plaintext' },
    workspaceId: 'workspace',
    scope: 'scope',
    authorizationScope: 'account',
    // The real cross-window contract is covered by the Chromium integration.
    // Node 22 in CI has no browser LockManager.
    locks: {
      request: async (_name: string, _options: LockOptions, run: (lock: Lock) => unknown) =>
        run({} as Lock),
    } as Pick<LockManager, 'request'>,
    readRejection: async () => undefined,
    resolveTransport,
    readSnapshot,
    auth,
    createWorker: () => {
      const index = workers.length;
      const worker = new TestWorker((started) => starts[index].resolve(started));
      created.resolve(worker);
      workers.push(worker);
      return worker as unknown as Worker;
    },
    localConnection: () => ({
      connection: {
        send: (message) => {
          sent.push(message);
        },
        isConnected: () => true,
        onMessage: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        onStatusChange: () => () => {},
      },
      dispose() {},
    }),
    ...overrides,
  });
  return { client, starts, workers, sent, listeners, created };
}

describe('worker raw-document prefetch', () => {
  it('caches real CRDT updates and merges them without losing unsent foreground edits', async () => {
    const remote = new LoroDoc();
    remote.getList('history').push({ id: 'first' });
    remote.commit();
    const foreground = new LoroDoc();
    foreground.import(remote.export({ mode: 'snapshot' }));
    foreground.getMap('session').set('title', 'unsent local title');
    foreground.commit();
    let cached: EagerSyncSnapshot | undefined;
    const listeners = new Set<(event: LocalSyncEvent) => void>();
    let joins = 0;
    let failWrite = false;
    let rejectWrite = false;
    const joinedBeforeLastChunk = deferred<void>();
    let deliverLastChunk: () => void = () => {
      throw new Error('No pending chunk');
    };
    const request = {
      type: 'start' as const,
      content: { mode: 'plaintext' as const },
      scope: 'scope',
      roomId: 'session-doc',
      workspaceId: 'workspace',
      peerId: 'prefetch-peer',
      lastMessageAt: 1,
      connected: true,
      transport: { plane: 'local' as const },
    };
    const deps: Parameters<typeof runEagerSyncWorkerTask>[1] = {
      now: () => 100,
      readSnapshot: async () => cached,
      writeSnapshot: async (row) => {
        if (failWrite) throw new Error('disk full');
        if (rejectWrite) return false;
        cached = { ...row, key: 'snapshot' };
        return true;
      },
      auth: async () => {
        throw new Error('Unexpected cloud auth');
      },
      connection: {
        isConnected: () => true,
        onStatusChange: () => () => {},
        onMessage: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        send: (message) => {
          if (message.type !== 'join') return;
          joins++;
          const from = message.haveVersion
            ? VersionVector.decode(base64ToBytes(message.haveVersion))
            : undefined;
          const payload = remote.export({ mode: 'update', from });
          queueMicrotask(() => {
            if (joins === 1) {
              const dataBase64 = bytesToBase64(payload);
              const chunks = buildDocUpdateChunkPayloads(
                dataBase64,
                Math.ceil(dataBase64.length / 2),
                'test-transfer'
              );
              for (const listener of listeners)
                listener({
                  type: 'joined',
                  protocolVersion: 7,
                  workspaceId: 'workspace',
                  peerId: message.peerId,
                  requestId: message.requestId,
                  room: message.room,
                  serverVersion: bytesToBase64(remote.oplogVersion().encode()),
                });
              const push = (chunk: (typeof chunks)[number]) => {
                for (const listener of listeners)
                  listener({
                    type: 'update',
                    protocolVersion: 7,
                    workspaceId: 'workspace',
                    peerId: message.peerId,
                    room: message.room,
                    payload: chunk,
                  });
              };
              for (const chunk of chunks.slice(0, -1)) push(chunk);
              deliverLastChunk = () => push(chunks[chunks.length - 1]);
              joinedBeforeLastChunk.resolve();
              return;
            }
            for (const listener of listeners)
              listener({
                type: 'joined',
                protocolVersion: 7,
                workspaceId: 'workspace',
                peerId: message.peerId,
                requestId: message.requestId,
                room: message.room,
                serverVersion: bytesToBase64(remote.oplogVersion().encode()),
                payload: { kind: 'doc-update', dataBase64: bytesToBase64(payload) },
              });
          });
        },
      },
    };
    const initial = runEagerSyncWorkerTask(request, deps);
    await joinedBeforeLastChunk.promise;
    expect(cached).toBeUndefined();
    deliverLastChunk();
    expect(await initial).toBe('synced');
    expect(cached?.lastMessageAt).toBe(1);
    remote.getList('history').push({ id: 'second' });
    remote.commit();
    expect(await runEagerSyncWorkerTask({ ...request, lastMessageAt: 2 }, deps)).toBe('synced');
    expect(cached).toBeDefined();
    foreground.import(new Uint8Array(await cached!.snapshot.arrayBuffer()));
    expect(foreground.getList('history').toJSON()).toEqual([{ id: 'first' }, { id: 'second' }]);
    expect(foreground.getMap('session').get('title')).toBe('unsent local title');
    expect(listeners.size).toBe(0);
    // A durable checkpoint avoids reopening the transport, including on restart.
    expect(await runEagerSyncWorkerTask({ ...request, lastMessageAt: 2 }, deps)).toBe('synced');
    expect(joins).toBe(2);
    rejectWrite = true;
    expect(await runEagerSyncWorkerTask({ ...request, lastMessageAt: 3 }, deps)).toBe(
      'cache_rejected'
    );
    expect(cached?.lastMessageAt).toBe(2);
    rejectWrite = false;
    failWrite = true;
    await expect(runEagerSyncWorkerTask({ ...request, lastMessageAt: 3 }, deps)).rejects.toThrow(
      'disk full'
    );
    expect(cached?.lastMessageAt).toBe(2);
    expect(listeners.size).toBe(0);
    remote.free();
    foreground.free();
  });
});

describe('worker module startup', () => {
  it('accepts its start message before the WASM task module finishes loading', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const doc = new LoroDoc();
    await writeEagerSyncSnapshot({
      scope: 'startup',
      roomId: 'room',
      plane: 'local',
      lastMessageAt: 1,
      savedAt: 1,
      snapshot: new Blob([doc.export({ mode: 'snapshot' }).slice().buffer]),
    });
    doc.free();
    const loading = deferred<void>();
    const release = deferred<void>();
    const complete = deferred<EagerSyncWorkerOutput>();
    let finished = false;
    const worker = {
      onmessage: null as ((event: MessageEvent<EagerSyncWorkerInput>) => void) | null,
      postMessage: (message: EagerSyncWorkerOutput) => {
        finished = true;
        complete.resolve(message);
      },
    };
    vi.stubGlobal('self', worker);
    vi.doMock('../src/providers/eager-sync-worker-task', async (importOriginal) => {
      loading.resolve();
      await release.promise;
      return await importOriginal();
    });
    try {
      await import('../src/providers/eager-sync.worker');
      expect(worker.onmessage).toBeTypeOf('function');
      worker.onmessage!({
        data: {
          type: 'start',
          content: { mode: 'plaintext' },
          scope: 'startup',
          workspaceId: 'workspace',
          roomId: 'room',
          peerId: 'worker',
          lastMessageAt: 1,
          connected: false,
          transport: { plane: 'local' },
        },
      } as MessageEvent<EagerSyncWorkerInput>);
      await loading.promise;
      worker.onmessage!({
        data: { type: 'local-status', connected: true },
      } as MessageEvent<EagerSyncWorkerInput>);
      expect(finished).toBe(false);
      release.resolve();
      expect(await complete.promise).toEqual({ type: 'complete', outcome: 'synced' });
    } finally {
      release.resolve();
      vi.doUnmock('../src/providers/eager-sync-worker-task');
    }
  });
});

describe('worker deadline cancellation', () => {
  it('reports a timed-out room as failed, terminates its worker and releases the next task', async () => {
    const h = clientHarness();
    const controller = new AbortController();
    const first = h.client.prefetch('stuck-room', 1, controller.signal);
    const worker = await h.starts[0].promise;
    controller.abort(new DOMException('task deadline', 'TimeoutError'));
    expect(await first).toBe('failed');
    expect(worker.terminated).toBe(true);
    const next = h.client.prefetch('next-room', 1, new AbortController().signal);
    const nextWorker = await h.starts[1].promise;
    nextWorker.emit({ type: 'complete', outcome: 'synced' });
    expect(await next).toBe('synced');
    h.client.dispose();
  });
});

it('bounds a waiting catch-up through the coordinator deadline and persists its retry across workers', async () => {
  let now = 0;
  const rows = new Map<string, Parameters<typeof writeEagerSyncRejection>[0]>();
  const retryStore: Partial<EagerSyncWorkerClientDeps> = {
    now: () => now,
    readRejection: async (key) => rows.get(key),
    writeRejection: async (row) => {
      rows.set(row.key, { ...row });
    },
    clearRejection: async (key) => {
      rows.delete(key);
    },
  };
  const transport = async (): Promise<EagerSyncTransport> => ({
    plane: 'cloud',
    streamUrl: 'https://streams.example.com/ds/bucket/waiting',
  });
  const h = clientHarness(transport, undefined, undefined, retryStore);
  const restarted = clientHarness(transport, undefined, undefined, retryStore);
  const sessionId = 'waiting-session' as SessionId;
  const highWater = new Map<SessionId, number>();
  const timers = new Map<symbol, { run: () => void; delay: number }>();
  let deadline: symbol | undefined;
  const drained = deferred<void>();
  const outcome = deferred<PrefetchOutcome>();
  let activity: ((snapshot: { sessionId: SessionId; lastMessageAt: number }) => void) | undefined;
  const coordinator = createBackgroundSyncCoordinator({
    activitySource: {
      list: () => [{ sessionId, lastMessageAt: 1 }],
      subscribe: (listener) => {
        activity = listener;
        return () => {
          activity = undefined;
        };
      },
    },
    registry: {
      isJoined: () => false,
      getRecentlySynced: () => new Set(),
      subscribe: () => () => {},
    },
    prefetcher: {
      getRetryAt: () => h.client.getRetryAt('waiting-room'),
      prefetch: async (_session, at, signal) => {
        const result = await h.client.prefetch('waiting-room', at, signal);
        outcome.resolve(result);
        return result;
      },
    },
    env: { isOnline: () => true, isAppVisible: () => true, subscribe: () => () => {} },
    clock: { now: () => now },
    scheduler: {
      setTimeout: (run, delay) => {
        const handle = Symbol();
        timers.set(handle, { run, delay });
        if (delay === WEB_EAGER_SYNC_POLICY.prefetchTimeoutMs) deadline = handle;
        return handle;
      },
      clearTimeout: (handle) => {
        timers.delete(handle as symbol);
        if (handle === deadline) drained.resolve();
      },
    },
    policy: WEB_EAGER_SYNC_POLICY,
    highWaterStore: {
      get: (id) => highWater.get(id),
      set: (id, at) => {
        highWater.set(id, at);
      },
    },
  });
  try {
    coordinator.start();
    // No completion is emitted: this is the parent boundary when SDK catch-up
    // remains waiting and firstSyncedWithRemote never resolves.
    const waiting = await h.starts[0].promise;
    expect(coordinator.getState().inFlight).toEqual([sessionId]);
    const timer = timers.get(deadline!)!;
    expect(timer.delay).toBe(20_000);
    now = timer.delay;
    timer.run();
    expect(waiting.terminated).toBe(true);
    expect(await outcome.promise).toBe('failed');
    await drained.promise;
    expect(coordinator.getState().inFlight).toEqual([]);
    expect(highWater.size).toBe(0);
    expect(h.client.getRetryAt('waiting-room')).toBe(80_000);
    activity?.({ sessionId, lastMessageAt: 2 });
    expect(coordinator.getState().queued).toEqual([]);
    coordinator.stop();
    const next = h.client.prefetch('another-room', 1, new AbortController().signal);
    const nextWorker = await h.starts[1].promise;
    nextWorker.emit({ type: 'complete', outcome: 'synced' });
    expect(await next).toBe('synced');
    expect(await restarted.client.prefetch('waiting-room', 3, new AbortController().signal)).toBe(
      'failed'
    );
    expect(restarted.workers).toEqual([]);
    expect(highWater.size).toBe(0);
  } finally {
    coordinator.stop();
    h.client.dispose();
    restarted.client.dispose();
  }
});

describe('eager-sync cloud auth bridge', () => {
  const cloudTransport = async (): Promise<EagerSyncTransport> => ({
    plane: 'cloud',
    streamUrl: 'https://streams.example.com/ds/bucket/stream',
  });

  it('refreshes a rejected JWT through the held provider callback instead of returning it', async () => {
    const bodies: Array<{ workspaceId: string; rejectedToken?: string }> = [];
    let issued = 0;
    const provider = createLoroStreamsTokenProviderLegacy({
      endpoint: 'https://convex.example.com/api/loro-streams/token',
      workspaceId: 'workspace',
      authToken: 'raw-token',
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as { workspaceId: string });
        return new Response(JSON.stringify({ token: `jwt-${++issued}`, expiresIn: 900 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    // Mirrors createWorkspaceRuntime: exactly one callback for the provider's
    // lifetime, so its last-token memory survives across worker jobs.
    const authCallback = provider.createAuthCallback();
    // Await the provider's own promise rather than a tick count: the encrypted
    // cache path is genuinely async, so counting microtasks would be a race.
    const settled: Array<Promise<string | undefined>> = [];
    const h = clientHarness(cloudTransport, undefined, (context) => {
      const pending = authCallback(context);
      settled.push(pending);
      return pending;
    });
    const result = h.client.prefetch('room', 1, new AbortController().signal);
    const worker = await h.starts[0].promise;
    const settle = async (index: number) => {
      // The client registers its reply handler before this await.
      await settled[index];
    };

    worker.emit({ type: 'auth', id: 1, context: { reason: 'request' } });
    await settle(0);
    expect(worker.inputs).toContainEqual({ type: 'auth-result', id: 1, token: 'jwt-1' });

    worker.emit({
      type: 'auth',
      id: 2,
      context: { reason: 'unauthorized', previousToken: 'jwt-1' },
    });
    await settle(1);
    expect(worker.inputs).toContainEqual({ type: 'auth-result', id: 2, token: 'jwt-2' });
    expect(bodies).toEqual([
      { workspaceId: 'workspace' },
      { workspaceId: 'workspace', rejectedToken: 'jwt-1' },
    ]);

    // A transport that reports no previousToken still refreshes: the held
    // callback remembers the token it last handed to that worker.
    worker.emit({ type: 'auth', id: 3, context: { reason: 'unauthorized' } });
    await settle(2);
    expect(worker.inputs).toContainEqual({ type: 'auth-result', id: 3, token: 'jwt-3' });
    expect(bodies.at(-1)).toEqual({ workspaceId: 'workspace', rejectedToken: 'jwt-2' });

    // A stale 401 naming a token the cache has already moved past must NOT
    // invalidate the replacement. This is the case the last-token fallback
    // cannot mask: if `previousToken` were dropped anywhere on the way, the
    // callback would fall back to jwt-3 and throw away a perfectly good token.
    worker.emit({
      type: 'auth',
      id: 4,
      context: { reason: 'unauthorized', previousToken: 'jwt-2' },
    });
    await settle(3);
    expect(worker.inputs).toContainEqual({ type: 'auth-result', id: 4, token: 'jwt-3' });
    expect(bodies).toHaveLength(3);

    worker.emit({ type: 'complete', outcome: 'synced' });
    expect(await result).toBe('synced');
    h.client.dispose();
  });
});

it.each(['snapshot', 'rejection'] as const)(
  'releases the claim and serial slot when a %s read never answers',
  async (stage) => {
    const reading = deferred<void>();
    const staleRead = deferred<undefined>();
    const released = deferred<void>();
    let held = false;
    const wait = async () => {
      reading.resolve();
      return staleRead.promise;
    };
    const h = clientHarness(undefined, undefined, undefined, {
      ...(stage === 'snapshot' ? { readSnapshot: wait } : { readRejection: wait }),
      locks: {
        request: async (_name: string, _options: LockOptions, run: (lock: Lock) => unknown) => {
          held = true;
          try {
            return await run({} as Lock);
          } finally {
            held = false;
            released.resolve();
          }
        },
      } as Pick<LockManager, 'request'>,
    });
    const controller = new AbortController();
    const outcome = h.client.prefetch('stuck', 1, controller.signal);
    await reading.promise;
    expect(held).toBe(true);
    controller.abort();
    expect(await outcome).toBe('skipped');
    await released.promise;
    expect(held).toBe(false);
    expect(h.workers).toEqual([]);
    // Another task must actually run while the abandoned read is still pending.
    const next = clientHarness();
    const successor = next.client.prefetch('independent', 1, new AbortController().signal);
    const worker = await next.starts[0].promise;
    worker.emit({ type: 'complete', outcome: 'synced' });
    expect(await successor).toBe('synced');
    staleRead.resolve(undefined);
    h.client.dispose();
    next.client.dispose();
  }
);

it('aborts the actual refusal transaction and cannot leave a late cooldown write', async () => {
  const controller = new AbortController();
  vi.stubGlobal('indexedDB', new IDBFactory());
  const original = IDBObjectStore.prototype.put;
  const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    const request = original.apply(this, args);
    // Cancel after a real request has entered the actual transaction.
    controller.abort();
    return request;
  });
  try {
    await expect(
      writeEagerSyncRejection(
        { key: 'cancelled-refusal', lastMessageAt: 1, rejectedAt: 1 },
        controller.signal
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
    put.mockRestore();
    expect(await readEagerSyncRejection('cancelled-refusal')).toBeUndefined();
    await writeEagerSyncRejection({ key: 'cancelled-refusal', lastMessageAt: 2, rejectedAt: 2 });
    expect(await readEagerSyncRejection('cancelled-refusal')).toMatchObject({ lastMessageAt: 2 });
  } finally {
    put.mockRestore();
    vi.unstubAllGlobals();
  }
});

it('retires an unanswered refusal database open without starting a late writer', async () => {
  const controller = new AbortController();
  const opening = deferred<void>();
  let closed = false;
  let transactions = 0;
  const request = {} as IDBOpenDBRequest;
  vi.stubGlobal('indexedDB', {
    open: () => {
      opening.resolve();
      return request;
    },
  });
  try {
    const writing = writeEagerSyncRejection(
      { key: 'late-open', lastMessageAt: 1, rejectedAt: 1 },
      controller.signal
    );
    await opening.promise;
    controller.abort();
    await expect(writing).rejects.toMatchObject({ name: 'AbortError' });
    Object.defineProperty(request, 'result', {
      value: {
        close: () => {
          closed = true;
        },
        transaction: () => {
          transactions++;
          throw new Error('Retired writer must not start');
        },
      },
    });
    request.onsuccess?.call(request, new Event('success'));
    expect(closed).toBe(true);
    expect(transactions).toBe(0);
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each(['write', 'clear'] as const)(
  'releases the claim and queue when a retry metadata %s never settles',
  async (stage) => {
    const writing = deferred<void>();
    const abortSeen = deferred<void>();
    const deadline = deferred<() => void>();
    const released = deferred<void>();
    let held = false;
    const stuck = async (signal?: AbortSignal) => {
      writing.resolve();
      signal?.addEventListener('abort', () => abortSeen.resolve(), { once: true });
      await new Promise<void>(() => {});
    };
    const h = clientHarness(undefined, undefined, undefined, {
      readRejection: async (key) =>
        stage === 'clear' && key.includes('"receipt"')
          ? { key, lastMessageAt: 1, rejectedAt: 0, retryAt: 60_000 }
          : undefined,
      readSnapshot: async (_scope, roomId) =>
        stage === 'clear' && roomId === 'receipt'
          ? {
              key: 'key',
              scope: 'scope',
              roomId,
              plane: 'local',
              lastMessageAt: 1,
              savedAt: 1,
              snapshot: new Blob(),
            }
          : undefined,
      writeRejection: (_row, signal) => stuck(signal),
      clearRejection: (_key, signal) => stuck(signal),
      scheduler: {
        setTimeout: (handler, ms) => {
          expect(ms).toBe(1000);
          deadline.resolve(handler);
          return handler;
        },
        clearTimeout: () => {},
      },
      locks: {
        request: async (_name: string, _options: LockOptions, run: (lock: Lock) => unknown) => {
          held = true;
          try {
            return await run({} as Lock);
          } finally {
            held = false;
            released.resolve();
          }
        },
      } as Pick<LockManager, 'request'>,
    });
    const outcome = h.client.prefetch('receipt', 1, new AbortController().signal);
    if (stage === 'write') {
      const worker = await h.starts[0].promise;
      worker.emit({ type: 'complete', outcome: 'cache_rejected' });
      expect(worker.terminated).toBe(true);
    }
    await writing.promise;
    expect(held).toBe(true);
    (await deadline.promise)();
    await abortSeen.promise;
    expect(await outcome).toBe(stage === 'write' ? 'cache_rejected' : 'synced');
    await released.promise;
    expect(held).toBe(false);
    const next = clientHarness();
    const successor = next.client.prefetch('independent', 1, new AbortController().signal);
    const nextWorker = await next.starts[0].promise;
    nextWorker.emit({ type: 'complete', outcome: 'synced' });
    expect(await successor).toBe('synced');
    h.client.dispose();
    next.client.dispose();
  }
);

it('bounds observed retry metadata even when every room was deferred by another window', async () => {
  const h = clientHarness(undefined, undefined, undefined, {
    now: () => 0,
    readRejection: async (key) => ({
      key,
      lastMessageAt: 1,
      rejectedAt: 0,
      kind: 'failed',
      retryAt: 60_000,
    }),
  });
  try {
    for (let room = 0; room <= 1000; room++) {
      expect(await h.client.prefetch(`deferred-${room}`, 2, new AbortController().signal)).toBe(
        'failed'
      );
    }
    expect(h.client.getRetryAt('deferred-0')).toBeUndefined();
    expect(h.client.getRetryAt('deferred-1000')).toBe(60_000);
    expect(h.workers).toEqual([]);
  } finally {
    h.client.dispose();
  }
});

it('bounds the separate timeout metadata owner before releasing its slot', async () => {
  const writing = deferred<void>();
  let expire: () => void = () => {
    throw new Error('No metadata deadline');
  };
  const h = clientHarness(undefined, undefined, undefined, {
    now: () => 0,
    scheduler: {
      setTimeout: (handler, ms) => {
        expect(ms).toBe(1000);
        expire = handler;
        return 1;
      },
      clearTimeout: () => {},
    },
    writeRejection: async (_row, signal) => {
      writing.resolve();
      await new Promise<void>((_resolve, reject) =>
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
      );
    },
  });
  const controller = new AbortController();
  const result = h.client.prefetch('deadline', 1, controller.signal);
  const worker = await h.starts[0].promise;
  controller.abort(new DOMException('deadline', 'TimeoutError'));
  await writing.promise;
  expect(worker.terminated).toBe(true);
  const next = clientHarness();
  const successor = next.client.prefetch('independent', 1, new AbortController().signal);
  expect(next.workers).toEqual([]);
  expire();
  expect(await result).toBe('failed');
  const nextWorker = await next.starts[0].promise;
  nextWorker.emit({ type: 'complete', outcome: 'synced' });
  expect(await successor).toBe('synced');
  expect(h.client.getRetryAt('deadline')).toBe(60_000);
  h.client.dispose();
  next.client.dispose();
});

describe('cloud prefetch checkpoints', () => {
  function harness() {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const remote = new LoroDoc();
    remote.setPeerId('1');
    remote.getMap('fields').set('remote', 'first');
    remote.commit();
    const request = {
      type: 'start' as const,
      content: { mode: 'plaintext' as const },
      scope: 'scope',
      roomId: 'room',
      workspaceId: 'workspace',
      peerId: 'worker',
      lastMessageAt: 1,
      connected: false,
      transport: {
        plane: 'cloud' as const,
        streamUrl: 'https://streams.example.com/ds/bucket/room',
      },
    };
    const reads: URL[] = [];
    let delta: Uint8Array | undefined;
    let tail = '100';
    let gone = false;
    let status = 200;
    let bootstrapOverride: Uint8Array | undefined;
    const fetch = async (input: string, init?: RequestInit) => {
      expect(init?.method ?? 'GET').toBe('GET');
      const url = new URL(input);
      reads.push(url);
      if (status !== 200) return new Response(null, { status });
      if (url.pathname.endsWith('/bootstrap')) {
        return new Response(
          new Blob([
            '--cp\r\nContent-Type: application/octet-stream\r\n\r\n',
            (bootstrapOverride ?? remote.export({ mode: 'snapshot' })).slice().buffer,
            '\r\n--cp--\r\n',
          ]),
          {
            headers: {
              'Content-Type': 'multipart/mixed; boundary=cp',
              'Stream-Snapshot-Offset': tail,
              'Stream-Next-Offset': tail,
              'Stream-Up-To-Date': 'true',
            },
          }
        );
      }
      if (gone) {
        gone = false;
        return new Response(null, { status: 410 });
      }
      const body = delta ? new Uint8Array(delta.length + 4) : undefined;
      if (body && delta) {
        new DataView(body.buffer).setUint32(0, delta.length, false);
        body.set(delta, 4);
      }
      return new Response(body?.buffer, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Stream-Next-Offset': tail,
          'Stream-Up-To-Date': 'true',
        },
      });
    };
    const deps: Parameters<typeof runEagerSyncWorkerTask>[1] = {
      fetch,
      now: () => 100,
      auth: async () => 'token',
      connection: {
        isConnected: () => false,
        send: () => {
          throw new Error('cloud must not use local');
        },
        onMessage: () => () => {},
        onStatusChange: () => () => {},
      },
    };
    return {
      request,
      deps,
      remote,
      reads,
      fetch,
      change() {
        const before = remote.oplogVersion();
        remote.getMap('fields').set('remote', 'second');
        remote.commit();
        delta = remote.export({ mode: 'update', from: before });
        tail = '200';
      },
      setBootstrap(value: Uint8Array) {
        bootstrapOverride = value;
      },
      setDelta(value: Uint8Array) {
        delta = value;
        tail = '200';
      },
      gone() {
        gone = true;
      },
      fail() {
        status = 403;
      },
      read: () => readEagerSyncSnapshot('scope', 'room'),
    };
  }

  it('keeps old v1 windows readable while writing checkpoints and separate refusal metadata', async () => {
    const h = harness();
    let oldWindow: IDBDatabase | undefined;
    try {
      const snapshot = new Blob([h.remote.export({ mode: 'snapshot' }).slice().buffer]);
      await writeEagerSyncSnapshot({
        scope: 'legacy',
        roomId: 'old-room',
        plane: 'cloud',
        lastMessageAt: 1,
        savedAt: 1,
        snapshot,
      });
      oldWindow = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(EAGER_SYNC_CACHE_DB, 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      // Leave the old version-1 connection open: an in-place DB version bump
      // would block this new writer or make a later old-window open fail.
      expect(await runEagerSyncWorkerTask(h.request, h.deps)).toBe('synced');
      await writeEagerSyncRejection({ key: 'refused', lastMessageAt: 2, rejectedAt: 1 });
      const rows = await new Promise<EagerSyncSnapshot[]>((resolve, reject) => {
        const request = oldWindow!
          .transaction('snapshots', 'readonly')
          .objectStore('snapshots')
          .getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      expect(oldWindow.version).toBe(1);
      expect(rows).toHaveLength(2);
      // These are the actual operations performed by the legacy LRU/foreground.
      expect(rows.every((row) => row.snapshot.size > 0)).toBe(true);
      expect(
        (await Promise.all(rows.map((row) => row.snapshot.arrayBuffer()))).every(
          (bytes) => bytes.byteLength > 0
        )
      ).toBe(true);
      expect((await readEagerSyncSnapshot('legacy', 'old-room'))?.cloudCheckpoint).toBeUndefined();
      expect((await h.read())?.cloudCheckpoint?.format).toBe(1);
      expect(await readEagerSyncRejection('refused')).toBeDefined();
    } finally {
      oldWindow?.close();
      h.remote.free();
    }
  });

  it('restarts from its own atomic snapshot and cursor and downloads only the suffix', async () => {
    const h = harness();
    try {
      expect(await runEagerSyncWorkerTask(h.request, h.deps)).toBe('synced');
      const first = await h.read();
      expect(first?.cloudCheckpoint?.cursor.nextOffset).toBe('100');
      h.change();
      h.reads.length = 0;
      expect(await runEagerSyncWorkerTask({ ...h.request, lastMessageAt: 2 }, h.deps)).toBe(
        'synced'
      );
      expect(h.reads.map((url) => [url.pathname, url.searchParams.get('offset')])).toEqual([
        ['/ds/bucket/room', '100'],
      ]);
      const second = await h.read();
      const restored = LoroDoc.fromSnapshot(new Uint8Array(await second!.snapshot.arrayBuffer()));
      expect(restored.toJSON()).toEqual(h.remote.toJSON());
      expect(second?.cloudCheckpoint?.cursor.nextOffset).toBe('200');
      restored.free();
    } finally {
      h.remote.free();
    }
  });

  it.each(['legacy', 'lost', 'uncovered', 'snapshot-version', 'stream', 'format'] as const)(
    'bootstraps safely for a %s checkpoint',
    async (kind) => {
      const h = harness();
      try {
        await runEagerSyncWorkerTask(h.request, h.deps);
        const row = (await h.read())!;
        if (kind === 'legacy' || kind === 'lost') delete row.cloudCheckpoint;
        else if (kind === 'uncovered')
          row.cloudCheckpoint!.cursor = {
            ...row.cloudCheckpoint!.cursor,
            serverLowerBoundVersion: { '1': 999 },
          };
        else if (kind === 'snapshot-version') row.cloudCheckpoint!.snapshotVersion = { '1': 999 };
        else if (kind === 'stream')
          row.cloudCheckpoint!.cursor = {
            ...row.cloudCheckpoint!.cursor,
            streamUrl: 'https://other.example.com/ds/bucket/room',
          };
        else row.cloudCheckpoint!.format = 99 as 1;
        await writeEagerSyncSnapshot(row);
        h.change();
        h.reads.length = 0;
        await runEagerSyncWorkerTask({ ...h.request, lastMessageAt: 2 }, h.deps);
        expect(h.reads[0].pathname).toBe('/ds/bucket/room/bootstrap');
        const restored = LoroDoc.fromSnapshot(
          new Uint8Array(await (await h.read())!.snapshot.arrayBuffer())
        );
        expect(restored.toJSON()).toEqual(h.remote.toJSON());
        restored.free();
      } finally {
        h.remote.free();
      }
    }
  );

  it('retains the previous atomic pair on network failure, rejected writes and interrupted saves', async () => {
    const h = harness();
    try {
      await runEagerSyncWorkerTask(h.request, h.deps);
      const before = (await h.read())!;
      h.change();
      expect(
        await runEagerSyncWorkerTask(
          { ...h.request, lastMessageAt: 2 },
          { ...h.deps, writeSnapshot: async () => false }
        )
      ).toBe('cache_rejected');
      const saving = deferred<void>();
      const release = deferred<void>();
      const interrupted = runEagerSyncWorkerTask(
        { ...h.request, lastMessageAt: 2 },
        {
          ...h.deps,
          writeSnapshot: async () => {
            saving.resolve();
            await release.promise;
            throw new Error('worker terminated before commit');
          },
        }
      );
      await saving.promise;
      expect((await h.read())?.cloudCheckpoint).toEqual(before.cloudCheckpoint);
      release.resolve();
      await expect(interrupted).rejects.toThrow('worker terminated');
      h.fail();
      await expect(
        runEagerSyncWorkerTask({ ...h.request, lastMessageAt: 2 }, h.deps)
      ).rejects.toBeDefined();
      expect((await h.read())?.lastMessageAt).toBe(1);
      expect((await h.read())?.cloudCheckpoint).toEqual(before.cloudCheckpoint);
    } finally {
      h.remote.free();
    }
  });

  it('persists incomplete-room backoff across clients without advancing the atomic checkpoint', async () => {
    const h = harness();
    let now = 0;
    const clients: Array<ReturnType<typeof clientHarness>> = [];
    const create = () => {
      const client = clientHarness(
        async () => h.request.transport,
        h.read,
        async () => 'token',
        {
          now: () => now,
          readRejection: readEagerSyncRejection,
          createWorker: () =>
            new TestWorker((worker) => {
              const input = worker.inputs.find((message) => message.type === 'start')!;
              void runEagerSyncWorkerTask(input, h.deps).then(
                (outcome) => worker.emit({ type: 'complete', outcome }),
                () => worker.emit({ type: 'complete', outcome: 'failed' })
              );
            }) as unknown as Worker,
        }
      );
      clients.push(client);
      return client.client;
    };
    try {
      await runEagerSyncWorkerTask(h.request, h.deps);
      const before = (await h.read())!;
      // A recovery bootstrap cannot supply the missing predecessor yet either.
      h.setBootstrap(h.remote.export({ mode: 'snapshot' }));
      const predecessor = h.remote.oplogVersion();
      h.remote.getText('body').insert(0, 'missing');
      h.remote.commit();
      const afterMissing = h.remote.oplogVersion();
      h.remote.getText('body').insert(7, 'pending');
      h.remote.commit();
      h.setDelta(h.remote.export({ mode: 'update', from: afterMissing }));
      const first = create();
      expect(await first.prefetch('room', 2, new AbortController().signal)).toBe('failed');
      expect(first.getRetryAt('room')).toBe(60_000);
      first.dispose();
      h.reads.length = 0;
      const restarted = create();
      expect(await restarted.prefetch('room', 3, new AbortController().signal)).toBe('failed');
      expect(h.reads).toEqual([]);
      expect((await h.read())?.cloudCheckpoint).toEqual(before.cloudCheckpoint);
      expect((await h.read())?.lastMessageAt).toBe(1);
      h.setDelta(h.remote.export({ mode: 'update', from: predecessor }));
      now = 60_000;
      expect(await restarted.prefetch('room', 3, new AbortController().signal)).toBe('synced');
      expect((await h.read())?.lastMessageAt).toBe(3);
      expect(restarted.getRetryAt('room')).toBeUndefined();
      const recovered = LoroDoc.fromSnapshot(
        new Uint8Array(await (await h.read())!.snapshot.arrayBuffer())
      );
      expect(recovered.toJSON()).toEqual(h.remote.toJSON());
      recovered.free();
    } finally {
      for (const client of clients) client.client.dispose();
      h.remote.free();
    }
  });

  it('does not persist pending imports or activity progress', async () => {
    const h = harness();
    try {
      await runEagerSyncWorkerTask(h.request, h.deps);
      h.setBootstrap(h.remote.export({ mode: 'snapshot' }));
      const beforeA = h.remote.oplogVersion();
      h.remote.getText('body').insert(0, 'missing');
      h.remote.commit();
      const beforeB = h.remote.oplogVersion();
      h.remote.getText('body').insert(7, 'pending');
      h.remote.commit();
      h.setDelta(h.remote.export({ mode: 'update', from: beforeB }));
      await expect(
        runEagerSyncWorkerTask({ ...h.request, lastMessageAt: 2 }, h.deps)
      ).rejects.toBeDefined();
      expect((await h.read())?.lastMessageAt).toBe(1);
      h.setDelta(h.remote.export({ mode: 'update', from: beforeA }));
      expect(await runEagerSyncWorkerTask({ ...h.request, lastMessageAt: 2 }, h.deps)).toBe(
        'synced'
      );
    } finally {
      h.remote.free();
    }
  });

  it('recovers a gone worker cursor through bootstrap', async () => {
    const h = harness();
    try {
      await runEagerSyncWorkerTask(h.request, h.deps);
      h.change();
      h.gone();
      h.reads.length = 0;
      await runEagerSyncWorkerTask({ ...h.request, lastMessageAt: 2 }, h.deps);
      expect(h.reads.some((url) => url.pathname.endsWith('/bootstrap'))).toBe(true);
      const restored = LoroDoc.fromSnapshot(
        new Uint8Array(await (await h.read())!.snapshot.arrayBuffer())
      );
      expect(restored.toJSON()).toEqual(h.remote.toJSON());
      restored.free();
    } finally {
      h.remote.free();
    }
  });
});
