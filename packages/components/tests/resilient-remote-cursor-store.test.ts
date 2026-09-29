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
  it('uses the primary store when it responds before the timeout', async () => {
    const primary = new MemoryRemoteCursorStore();
    const fallback = new MemoryRemoteCursorStore();
    const warnings: unknown[] = [];
    const cursor = createCursor(`${LEGACY_LORO_STREAMS_BASE_URL}/ds/lody/workspace:meta`);
    await primary.save(cursor);

    const store = new ResilientRemoteCursorStore({
      dbName: 'cursor-db',
      timeoutMs: 10,
      createPrimaryStore: () => primary,
      createFallbackStore: () => fallback,
      onWarning: (message, context) => warnings.push({ message, context }),
    });

    expect(await store.load(cursor.streamUrl)).toEqual(cursor);
    expect(warnings).toHaveLength(0);
  });

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

  it('fails open to memory when primary load hangs', async () => {
    vi.useFakeTimers();
    const fallback = new MemoryRemoteCursorStore();
    const warnings: unknown[] = [];
    const store = new ResilientRemoteCursorStore({
      dbName: 'cursor-db',
      timeoutMs: 10,
      createPrimaryStore: createNeverSettlingStore,
      createFallbackStore: () => fallback,
      onWarning: (message, context) => warnings.push({ message, context }),
    });

    const loadPromise = store.load(`${LEGACY_LORO_STREAMS_BASE_URL}/ds/lody/workspace:meta`);
    await vi.advanceTimersByTimeAsync(10);

    await expect(loadPromise).resolves.toBeNull();
    expect(warnings).toHaveLength(1);
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

  it('degrades to memory when the primary store throws', async () => {
    const fallback = new MemoryRemoteCursorStore();
    const warnings: unknown[] = [];
    const cursor = createCursor(`${LEGACY_LORO_STREAMS_BASE_URL}/ds/lody/workspace:meta`);
    await fallback.save(cursor);
    const primary: RemoteCursorStore<JsonObject> = {
      load: async () => {
        throw new Error('bad cursor cache');
      },
      save: async () => {},
      delete: async () => {},
    };
    const store = new ResilientRemoteCursorStore({
      dbName: 'cursor-db',
      timeoutMs: 10,
      createPrimaryStore: () => primary,
      createFallbackStore: () => fallback,
      onWarning: (message, context) => warnings.push({ message, context }),
    });

    expect(await store.load(cursor.streamUrl)).toEqual(cursor);
    expect(warnings).toHaveLength(1);
  });
});
