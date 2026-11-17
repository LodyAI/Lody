import { describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import {
  readEagerSyncRejection,
  writeEagerSyncRejection,
} from '../src/providers/eager-sync-admission';
import { createLoroStreamsTokenProviderLegacy } from '@lody/shared';
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
import type { EagerSyncSnapshot } from '../src/providers/eager-sync-snapshot-cache';
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
  constructor(
    private start: (worker: TestWorker) => void,
    ready = true
  ) {
    if (ready) queueMicrotask(() => this.emit({ type: 'ready' }));
  }
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
  ready = true,
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
      const worker = new TestWorker((started) => starts[index].resolve(started), ready);
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

describe('eager-sync cloud auth bridge', () => {
  const cloudTransport = async (): Promise<EagerSyncTransport> => ({
    plane: 'cloud',
    streamId: 'stream',
    options: {
      bucketId: 'bucket',
      metaStreamId: 'meta',
      baseUrl: 'https://streams.example.com',
      shardUrls: undefined,
    },
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

it('cancels a worker still initializing WASM without attaching a local peer', async () => {
  const h = clientHarness(undefined, undefined, undefined, false);
  const controller = new AbortController();
  const outcome = h.client.prefetch('initializing', 1, controller.signal);
  const worker = await h.created.promise;
  expect(worker.inputs).toEqual([]);
  controller.abort();
  expect(await outcome).toBe('skipped');
  expect(worker.terminated).toBe(true);
  // Late ready cannot resurrect the retired task or start a download.
  worker.emit({ type: 'ready' });
  expect(worker.inputs).toEqual([]);
  expect(h.sent).toEqual([]);
  h.client.dispose();
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
    const h = clientHarness(undefined, undefined, undefined, true, {
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

it('retains the claim until the cancelled refusal writer confirms its transaction ended', async () => {
  const writing = deferred<void>();
  const abortSeen = deferred<void>();
  const transactionEnded = deferred<void>();
  let held = false;
  const h = clientHarness(undefined, undefined, undefined, true, {
    writeRejection: async (_row, signal) => {
      writing.resolve();
      signal?.addEventListener('abort', () => abortSeen.resolve(), { once: true });
      await transactionEnded.promise;
      signal?.throwIfAborted();
    },
    locks: {
      request: async (_name: string, _options: LockOptions, run: (lock: Lock) => unknown) => {
        held = true;
        try {
          return await run({} as Lock);
        } finally {
          held = false;
        }
      },
    } as Pick<LockManager, 'request'>,
  });
  const controller = new AbortController();
  const outcome = h.client.prefetch('refused', 1, controller.signal);
  const worker = await h.starts[0].promise;
  worker.emit({ type: 'complete', outcome: 'cache_rejected' });
  await writing.promise;
  expect(worker.terminated).toBe(true);
  controller.abort();
  await abortSeen.promise;
  expect(await outcome).toBe('skipped');
  expect(held).toBe(true);
  const next = clientHarness();
  const successor = next.client.prefetch('independent', 1, new AbortController().signal);
  expect(next.workers).toEqual([]);
  transactionEnded.resolve();
  const nextWorker = await next.starts[0].promise;
  expect(held).toBe(false);
  nextWorker.emit({ type: 'complete', outcome: 'synced' });
  expect(await successor).toBe('synced');
  h.client.dispose();
  next.client.dispose();
});
