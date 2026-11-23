import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JsonObject, RemoteCursor, RemoteCursorStore } from '@loro-dev/streams-crdt';
import { DEFAULT_LORO_STREAMS_BASE_URL, LEGACY_LORO_STREAMS_BASE_URL } from '@lody/shared';

import { ResilientRemoteCursorStore } from '../src/providers/resilient-remote-cursor-store';

class MemoryRemoteCursorStore<
  TVersion extends JsonObject = JsonObject,
> implements RemoteCursorStore<TVersion> {
  private readonly cursors = new Map<string, RemoteCursor<TVersion>>();

  async load(streamUrl: string): Promise<RemoteCursor<TVersion> | null> {
    return this.cursors.get(streamUrl) ?? null;
  }

  async save(cursor: RemoteCursor<TVersion>): Promise<void> {
    this.cursors.set(cursor.streamUrl, cursor);
  }

  async delete(streamUrl: string): Promise<void> {
    this.cursors.delete(streamUrl);
  }
}

const createCursor = (streamUrl: string): RemoteCursor<JsonObject> => ({
  streamUrl,
  nextOffset: '42',
  serverLowerBoundVersion: { version: '1' },
  updatedAtMs: 123,
});

const createNeverSettlingStore = (): RemoteCursorStore<JsonObject> => ({
  load: () => new Promise<RemoteCursor<JsonObject> | null>(() => {}),
  save: () => new Promise<void>(() => {}),
  delete: () => new Promise<void>(() => {}),
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ResilientRemoteCursorStore', () => {
  it('loads and deletes cursors saved under the legacy gateway URL', async () => {
    const primary = new MemoryRemoteCursorStore();
    const fallback = new MemoryRemoteCursorStore();
    const legacyUrl = `${LEGACY_LORO_STREAMS_BASE_URL}/ds/lody/workspace:meta`;
    const proxyUrl = `${DEFAULT_LORO_STREAMS_BASE_URL}/ds/lody/workspace:meta`;
    const legacyCursor = createCursor(legacyUrl);
    await primary.save(legacyCursor);

    const store = new ResilientRemoteCursorStore({
      dbName: 'cursor-db',
      timeoutMs: 10,
      createPrimaryStore: () => primary,
      createFallbackStore: () => fallback,
    });

    await expect(store.load(proxyUrl)).resolves.toEqual({ ...legacyCursor, streamUrl: proxyUrl });

    await store.delete(proxyUrl);
    await expect(primary.load(legacyUrl)).resolves.toBeNull();
    await expect(primary.load(proxyUrl)).resolves.toBeNull();
  });

  it('loads and deletes cursors saved under the previous proxy gateway URL', async () => {
    const primary = new MemoryRemoteCursorStore();
    const fallback = new MemoryRemoteCursorStore();
    const previousProxyUrl = 'https://previous.streams.invalid/ds/lody/workspace:meta';
    const currentUrl = `${DEFAULT_LORO_STREAMS_BASE_URL}/ds/lody/workspace:meta`;
    const previousProxyCursor = createCursor(previousProxyUrl);
    await primary.save(previousProxyCursor);

    const store = new ResilientRemoteCursorStore({
      dbName: 'cursor-db',
      timeoutMs: 10,
      createPrimaryStore: () => primary,
      createFallbackStore: () => fallback,
    });

    await expect(store.load(currentUrl)).resolves.toEqual({
      ...previousProxyCursor,
      streamUrl: currentUrl,
    });

    await store.delete(currentUrl);
    await expect(primary.load(previousProxyUrl)).resolves.toBeNull();
    await expect(primary.load(currentUrl)).resolves.toBeNull();
  });

  it('stores future cursors in memory after a primary timeout', async () => {
    vi.useFakeTimers();
    const fallback = new MemoryRemoteCursorStore();
    const warnings: unknown[] = [];
    const cursor = createCursor(`${LEGACY_LORO_STREAMS_BASE_URL}/ds/lody/workspace:session`);
    const store = new ResilientRemoteCursorStore({
      dbName: 'cursor-db',
      timeoutMs: 10,
      createPrimaryStore: createNeverSettlingStore,
      createFallbackStore: () => fallback,
      onWarning: (message, context) => warnings.push({ message, context }),
    });

    const savePromise = store.save(cursor);
    await vi.advanceTimersByTimeAsync(10);
    await savePromise;

    expect(await fallback.load(cursor.streamUrl)).toEqual(cursor);
    expect(await store.load(cursor.streamUrl)).toEqual(cursor);
    expect(warnings).toHaveLength(1);
  });
  it('conditionally seeds cold progress across instances without overwriting concurrent UI saves', async () => {
    const indexedDb = new IDBFactory();
    const queues = new Map<string, Promise<unknown>>();
    const locks = {
      request: <T>(name: string, _options: LockOptions, callback: (lock: Lock) => T) => {
        const task = (queues.get(name) ?? Promise.resolve()).then(() => callback({ name } as Lock));
        queues.set(
          name,
          task.catch(() => {})
        );
        return task;
      },
    } as Pick<LockManager, 'request'>;
    const first = new ResilientRemoteCursorStore({
      dbName: 'shared-cold-cursor',
      indexedDb,
      locks,
    });
    const second = new ResilientRemoteCursorStore({
      dbName: 'shared-cold-cursor',
      indexedDb,
      locks,
    });
    const stream = 'https://streams.example.com/ds/bucket/session';
    const worker = createCursor(stream);
    const foreground = { ...worker, nextOffset: 'ui-progress' };
    const writing = first.save(foreground);
    const adopting = second.saveIfAbsent(worker);
    await writing;
    expect(await adopting).toBe(false);
    expect(await second.load(stream)).toEqual(foreground);
    await first.delete(stream);
    const results = await Promise.all([
      first.saveIfAbsent(worker),
      second.saveIfAbsent(foreground),
    ]);
    expect(results).toEqual([true, false]);
    expect(await first.load(stream)).toEqual(worker);
  });

  it('keeps ordinary synchronization available when conditional adoption has no cross-window lock', async () => {
    vi.stubGlobal('navigator', {});
    const primary = new MemoryRemoteCursorStore();
    const store = new ResilientRemoteCursorStore({
      dbName: 'no-locks',
      createPrimaryStore: () => primary,
    });
    const cursor = createCursor('https://streams.example.com/ds/bucket/session');
    expect(await store.saveIfAbsent(cursor)).toBe(false);
    await store.save(cursor);
    expect(await store.load(cursor.streamUrl)).toEqual(cursor);
  });
});
