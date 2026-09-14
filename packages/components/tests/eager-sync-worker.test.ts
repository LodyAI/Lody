import { describe, expect, it, vi } from 'vitest';
import { createLoroStreamsTokenProvider } from '@lody/shared';
import { LoroDoc, VersionVector } from 'loro-crdt';
import {
  base64ToBytes,
  bytesToBase64,
  buildDocUpdateChunkPayloads,
} from '@lody/shared/local-loro-data-plane';
import { createEagerSyncWorkerClient } from '../src/providers/eager-sync-worker-client';
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
  }
) {
  const starts = [deferred<TestWorker>(), deferred<TestWorker>(), deferred<TestWorker>()];
  const workers: TestWorker[] = [];
  const sent: LocalSyncMessage[] = [];
  const listeners = new Set<(event: LocalSyncEvent) => void>();
  const client = createEagerSyncWorkerClient({
    workspaceId: 'workspace',
    scope: 'scope',
    resolveTransport,
    readSnapshot,
    auth,
    createWorker: () => {
      const index = workers.length;
      const worker = new TestWorker((started) => starts[index].resolve(started));
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
  });
  return { client, starts, workers, sent, listeners };
}

describe('eager-sync worker ownership', () => {
  it('uses a durable activity checkpoint before constructing a worker', async () => {
    const reads: Array<[string, string]> = [];
    const h = clientHarness(undefined, async (scope, roomId) => {
      reads.push([scope, roomId]);
      return {
        key: 'cached',
        scope,
        roomId,
        plane: 'local',
        lastMessageAt: 42,
        savedAt: 1,
        snapshot: new Blob(),
      };
    });

    await expect(h.client.prefetch('cached-room', 42, new AbortController().signal)).resolves.toBe(
      'synced'
    );
    expect(reads).toEqual([['scope', 'cached-room']]);
    expect(h.workers).toEqual([]);
    h.client.dispose();
  });

  it('constructs a worker when activity is newer than the durable checkpoint', async () => {
    const h = clientHarness(undefined, async (scope, roomId) => ({
      key: 'cached',
      scope,
      roomId,
      plane: 'local',
      lastMessageAt: 41,
      savedAt: 1,
      snapshot: new Blob(),
    }));
    const result = h.client.prefetch('changed-room', 42, new AbortController().signal);
    const worker = await h.starts[0].promise;

    worker.emit({ type: 'complete', outcome: 'synced' });
    await expect(result).resolves.toBe('synced');
    expect(h.workers).toEqual([worker]);
    h.client.dispose();
  });

  it('serializes jobs, terminates before advancing, and never returns snapshots to the UI', async () => {
    const h = clientHarness();
    const signal = new AbortController().signal;
    const first = h.client.prefetch('a', 1, signal);
    const second = h.client.prefetch('b', 1, signal);
    const a = await h.starts[0].promise;
    expect(h.workers.filter((worker) => !worker.terminated)).toEqual([a]);
    a.emit({ type: 'complete', outcome: 'synced' });
    expect(await first).toBe('synced');
    const b = await h.starts[1].promise;
    expect(a.terminated).toBe(true);
    expect(h.workers.filter((worker) => !worker.terminated)).toEqual([b]);
    b.emit({ type: 'complete', outcome: 'synced' });
    expect(await second).toBe('synced');
    expect(h.listeners.size).toBe(0);
    h.client.dispose();
  });

  it('cancels an in-flight import on foreground open and detaches its local peer', async () => {
    const h = clientHarness();
    const result = h.client.prefetch('long', 1, new AbortController().signal);
    const worker = await h.starts[0].promise;
    const start = worker.inputs.find((input) => input.type === 'start');
    h.client.cancel('long');
    expect(await result).toBe('skipped');
    expect(worker.terminated).toBe(true);
    expect(h.sent).toContainEqual({
      type: 'detach',
      protocolVersion: 7,
      workspaceId: 'workspace',
      peerId: start?.peerId,
    });
    expect(h.listeners.size).toBe(0);
    worker.emit({ type: 'complete', outcome: 'synced' });
    expect(await result).toBe('skipped');
    h.client.dispose();
  });

  it('releases the shared slot when transport setup is cancelled before it resolves', async () => {
    const pending = deferred<EagerSyncTransport>();
    const entered = deferred<void>();
    const h = clientHarness(() => {
      entered.resolve();
      return pending.promise;
    });
    const abort = new AbortController();
    const result = h.client.prefetch('a', 1, abort.signal);
    await entered.promise;
    abort.abort();
    expect(await result).toBe('skipped');
    const next = clientHarness();
    const nextResult = next.client.prefetch('b', 1, new AbortController().signal);
    const worker = await next.starts[0].promise;
    expect(h.workers).toHaveLength(0);
    pending.resolve({ plane: 'local' });
    worker.emit({ type: 'complete', outcome: 'synced' });
    expect(await nextResult).toBe('synced');
    expect(h.workers).toHaveLength(0);
    h.client.dispose();
    next.client.dispose();
  });

  it('releases failed workers and aborts queued jobs on disposal', async () => {
    const h = clientHarness();
    const signal = new AbortController().signal;
    const first = h.client.prefetch('a', 1, signal);
    const second = h.client.prefetch('b', 1, signal);
    const worker = await h.starts[0].promise;
    worker.onerror?.();
    expect(await first).toBe('failed');
    h.client.dispose();
    expect(await second).toBe('skipped');
    expect(h.workers.every((entry) => entry.terminated)).toBe(true);
  });
});

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
    const joinedBeforeLastChunk = deferred<void>();
    let deliverLastChunk: () => void = () => {
      throw new Error('No pending chunk');
    };
    const request = {
      type: 'start' as const,
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
  // The worker's transport reports which token the gateway rejected. Everything
  // between it and the token provider has to keep that value, otherwise the
  // provider cannot tell a real rejection from a stale one and hands the
  // rejected token straight back.

  it('forwards the whole auth context from the worker module onto the wire', async () => {
    vi.resetModules();
    let capturedAuth: ((context?: EagerSyncAuthContext) => Promise<string | undefined>) | undefined;
    vi.doMock('../src/providers/eager-sync-worker-task', () => ({
      runEagerSyncWorkerTask: async (
        _request: unknown,
        deps: { auth(context?: EagerSyncAuthContext): Promise<string | undefined> }
      ) => {
        capturedAuth = deps.auth;
        return 'synced' as const;
      },
    }));
    const posted: EagerSyncWorkerOutput[] = [];
    const fakeSelf = {
      onmessage: null as ((event: MessageEvent<EagerSyncWorkerInput>) => void) | null,
      // Clone like a real Worker boundary would, so a non-cloneable context
      // field fails here instead of only in a browser.
      postMessage: (message: EagerSyncWorkerOutput) => posted.push(structuredClone(message)),
    };
    vi.stubGlobal('self', fakeSelf);
    try {
      await import('../src/providers/eager-sync.worker');
      fakeSelf.onmessage?.({
        data: {
          type: 'start',
          scope: 'scope',
          workspaceId: 'workspace',
          roomId: 'room',
          peerId: 'peer',
          lastMessageAt: 1,
          connected: true,
          transport: await cloudTransport(),
        },
      } as MessageEvent<EagerSyncWorkerInput>);
      expect(capturedAuth).toBeDefined();

      const pending = capturedAuth?.({ reason: 'unauthorized', previousToken: 'jwt-1' });
      expect(posted.find((message) => message.type === 'auth')).toEqual({
        type: 'auth',
        id: 1,
        context: { reason: 'unauthorized', previousToken: 'jwt-1' },
      });

      // The reply still resolves the caller that is waiting on the wire id.
      fakeSelf.onmessage?.({
        data: { type: 'auth-result', id: 1, token: 'jwt-2' },
      } as MessageEvent<EagerSyncWorkerInput>);
      expect(await pending).toBe('jwt-2');
    } finally {
      vi.unstubAllGlobals();
      vi.doUnmock('../src/providers/eager-sync-worker-task');
      vi.resetModules();
    }
  });

  it('refreshes a rejected JWT through the held provider callback instead of returning it', async () => {
    const bodies: Array<{ workspaceId: string; rejectedToken?: string }> = [];
    let issued = 0;
    const provider = createLoroStreamsTokenProvider({
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
