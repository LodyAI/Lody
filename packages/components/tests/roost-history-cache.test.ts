import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { createRoostHistoryCache, roostHistoryDatabase } from '../src/lib/roost-history-cache';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('createRoostHistoryCache versionchange resilience', () => {
  it('reopens after external onversionchange (including delete) and only fences after dispose()', async () => {
    const factory = new IDBFactory();
    vi.stubGlobal('indexedDB', factory);
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);

    const namespace = 'ws-encrypted-ns';
    const cache = createRoostHistoryCache('session-1', namespace);
    const turn = {
      id: 'turn-1',
      role: 'user' as const,
      timestamp: '2026-11-26T00:00:00.000Z',
      items: [{ type: 'text' as const, text: 'hello' }],
    };

    const accepted = await cache.acceptPage(
      {
        checkpoint: 'cp-1',
        startPosition: 0,
        totalCount: 1,
        rows: [{ position: 0, turnId: 'turn-1', role: 'user' }],
        hasMoreOlder: false,
        cursor: null,
      },
      [turn],
      1
    );
    expect(accepted).toBe(true);
    expect((await cache.getHead())?.checkpoint).toBe('cp-1');

    await new Promise<void>((resolve, reject) => {
      const del = factory.deleteDatabase(roostHistoryDatabase(namespace));
      del.onsuccess = () => resolve();
      del.onerror = () => reject(del.error);
      del.onblocked = () => reject(new Error('deleteDatabase was blocked by Tab A'));
    });

    expect(await cache.getHead()).toBeUndefined();

    const reAccepted = await cache.acceptPage(
      {
        checkpoint: 'cp-2',
        startPosition: 0,
        totalCount: 1,
        rows: [{ position: 0, turnId: 'turn-1', role: 'user' }],
        hasMoreOlder: false,
        cursor: null,
      },
      [turn],
      2
    );
    expect(reAccepted).toBe(true);
    expect((await cache.getHead())?.checkpoint).toBe('cp-2');

    cache.dispose();
    await expect(cache.getHead()).rejects.toThrow('History cache is disposed');
  });
});
