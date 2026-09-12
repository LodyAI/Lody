import { describe, expect, it } from 'vitest';
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
  resolveTransport = async (): Promise<EagerSyncTransport> => ({ plane: 'local' })
) {
  const starts = [deferred<TestWorker>(), deferred<TestWorker>(), deferred<TestWorker>()];
  const workers: TestWorker[] = [];
  const sent: LocalSyncMessage[] = [];
  const listeners = new Set<(event: LocalSyncEvent) => void>();
  const client = createEagerSyncWorkerClient({
    workspaceId: 'workspace',
    scope: 'scope',
    resolveTransport,
    auth: async () => {
      throw new Error('Local prefetch must never request cloud credentials');
    },
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
