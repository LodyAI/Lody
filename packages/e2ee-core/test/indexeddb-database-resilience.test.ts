import { afterEach, describe, expect, it, vi } from 'vitest';
import { Effect, Result } from 'effect';
import { DatabaseOwner, type DatabaseLayout } from '../src/adapters/indexeddb/database';

const scope = {
  accountId: 'acc-1',
  workspaceId: 'ws-1',
  genesis: '11'.repeat(32),
};

const simpleLayout: DatabaseLayout = {
  tables: ['meta', 'items'],
  initialize: () => {},
};

function makeFakeIdb() {
  const stores = new Map<string, Map<string, Map<IDBValidKey, unknown>>>();
  let blockedRemaining = 0;
  let openCalls = 0;
  const openHandles: {
    db: IDBDatabase;
    closed: boolean;
    fireVersionChange: (newVersion: number | null) => void;
  }[] = [];

  const createDb = (dbName: string) => {
    const dbStores = stores.get(dbName)!;
    const handle = {
      closed: false,
      db: undefined as unknown as IDBDatabase,
      fireVersionChange: (newVersion: number | null) => {
        if (newVersion === null) stores.delete(dbName);
        handle.db.onversionchange?.({ oldVersion: 1, newVersion } as IDBVersionChangeEvent);
      },
    };
    const db = {
      name: dbName,
      version: 1,
      objectStoreNames: {
        get length() {
          return dbStores.size;
        },
        contains: (name: string) => dbStores.has(name),
      },
      onversionchange: null,
      onclose: null,
      close() {
        handle.closed = true;
      },
      createObjectStore(name: string) {
        const map = new Map<IDBValidKey, unknown>();
        dbStores.set(name, map);
        return makeObjectStore(map);
      },
      transaction(tableNames: string[]) {
        if (handle.closed) {
          throw new DOMException('Database connection is closing', 'InvalidStateError');
        }
        let aborted = false;
        let pending = 0;
        let completed = false;
        const tx = {
          error: null as DOMException | null,
          oncomplete: null as (() => void) | null,
          onabort: null as (() => void) | null,
          onerror: null as (() => void) | null,
          abort() {
            if (aborted || completed) return;
            aborted = true;
            queueMicrotask(() => tx.onabort?.());
          },
          objectStore(name: string) {
            if (!tableNames.includes(name) || !dbStores.has(name)) {
              throw new DOMException(`Missing store ${name}`, 'NotFoundError');
            }
            const map = dbStores.get(name)!;
            const schedule = <T>(work: () => T): IDBRequest<T> => {
              pending++;
              const req = {
                result: undefined as unknown as T,
                error: null as DOMException | null,
                onsuccess: null as (() => void) | null,
                onerror: null as (() => void) | null,
              } as unknown as IDBRequest<T>;
              queueMicrotask(() => {
                if (aborted) return;
                try {
                  (req as { result: T }).result = work();
                  req.onsuccess?.(new Event('success'));
                } catch (err) {
                  (req as { error: DOMException }).error = err as DOMException;
                  req.onerror?.(new Event('error'));
                } finally {
                  pending--;
                  if (pending === 0 && !aborted && !completed) {
                    completed = true;
                    queueMicrotask(() => {
                      if (!aborted) tx.oncomplete?.();
                    });
                  }
                }
              });
              return req;
            };
            return {
              get: (key: IDBValidKey) => schedule(() => map.get(key)),
              put: (value: unknown, key: IDBValidKey) =>
                schedule(() => {
                  map.set(key, value);
                  return key;
                }),
            };
          },
        };
        return tx;
      },
    } as unknown as IDBDatabase;
    handle.db = db;
    openHandles.push(handle);
    return db;
  };

  function makeObjectStore(map: Map<IDBValidKey, unknown>) {
    return {
      put: (value: unknown, key: IDBValidKey) => {
        map.set(key, value);
        return {} as IDBRequest;
      },
      get: (key: IDBValidKey) => ({ result: map.get(key) }) as IDBRequest,
    };
  }

  const factory = {
    open(name: string) {
      openCalls++;
      const req = {
        result: undefined as unknown as IDBDatabase,
        error: null as DOMException | null,
        transaction: null as unknown as IDBTransaction,
        onblocked: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onupgradeneeded: null as ((event: IDBVersionChangeEvent) => void) | null,
        onsuccess: null as (() => void) | null,
      };
      queueMicrotask(() => {
        if (blockedRemaining > 0) {
          blockedRemaining--;
          req.onblocked?.();
          return;
        }
        const existed = stores.has(name);
        if (!existed) stores.set(name, new Map());
        const db = createDb(name);
        req.result = db;
        if (!existed) {
          let upgradeAborted = false;
          req.transaction = {
            objectStore: (storeName: string) => makeObjectStore(stores.get(name)!.get(storeName)!),
            abort: () => {
              upgradeAborted = true;
              stores.delete(name);
            },
          } as unknown as IDBTransaction;
          req.onupgradeneeded?.({ oldVersion: 0, newVersion: 1 } as IDBVersionChangeEvent);
          if (upgradeAborted) {
            req.error = new DOMException('Aborted', 'AbortError');
            req.onerror?.();
            return;
          }
        }
        req.onsuccess?.();
      });
      return req as unknown as IDBOpenDBRequest;
    },
  };

  return {
    factory,
    openHandles,
    setBlocked: (count: number) => {
      blockedRemaining = count;
    },
    getOpenCalls: () => openCalls,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('DatabaseOwner multi-tab resilience', () => {
  it('retries transient onblocked with bounded backoff and stays reusable after conflict', async () => {
    vi.useFakeTimers();
    const idb = makeFakeIdb();
    vi.stubGlobal('indexedDB', idb.factory);
    const owner = new DatabaseOwner(scope, 'resilient-blocked', 'create-or-open', simpleLayout);

    idb.setBlocked(2);
    const opening = Effect.runPromise(owner.open);
    await vi.advanceTimersByTimeAsync(200);
    await opening;
    expect(idb.getOpenCalls()).toBe(3);
    await Effect.runPromise(owner.close);

    const owner2 = new DatabaseOwner(scope, 'resilient-conflict', 'create-or-open', simpleLayout);
    idb.setBlocked(4);
    const failedPromise = Effect.runPromise(Effect.result(owner2.open));
    await vi.advanceTimersByTimeAsync(500);
    const failed = await failedPromise;
    expect(Result.isFailure(failed) && failed.failure.reason).toBe('conflict');

    idb.setBlocked(0);
    await Effect.runPromise(owner2.open);
    await Effect.runPromise(owner2.close);
  });

  it('closes old handle on onversionchange and transparently reopens on next operation', async () => {
    const idb = makeFakeIdb();
    vi.stubGlobal('indexedDB', idb.factory);
    const owner = new DatabaseOwner(
      scope,
      'resilient-versionchange',
      'create-or-open',
      simpleLayout
    );
    const checkBinding = (row: unknown) => {
      if (!row || typeof row !== 'object') throw new Error('missing meta');
    };

    await Effect.runPromise(owner.open);
    await Effect.runPromise(
      owner.run('TestStore', ['items'], 'readwrite', checkBinding, (tx, done) =>
        tx.request(tx.store('items').put('v1', 'k'), () => done(undefined))
      )
    );

    const firstHandle = idb.openHandles[0]!;
    firstHandle.fireVersionChange(null);
    expect(firstHandle.closed).toBe(true);

    const value = await Effect.runPromise(
      owner.run('TestStore', ['items'], 'readonly', checkBinding, (tx, done) =>
        tx.request(tx.store('items').get('k'), (v) => done(v))
      )
    );
    expect(value).toBeUndefined();
    expect(idb.getOpenCalls()).toBe(2);

    await Effect.runPromise(owner.close);
    const afterClose = await Effect.runPromise(
      Effect.result(
        owner.run('TestStore', ['items'], 'readonly', checkBinding, (tx, done) =>
          tx.request(tx.store('items').get('k'), (v) => done(v))
        )
      )
    );
    expect(Result.isFailure(afterClose) && afterClose.failure.reason).toBe('closed');
    const reopenAfterClose = await Effect.runPromise(Effect.result(owner.open));
    expect(Result.isFailure(reopenAfterClose) && reopenAfterClose.failure.reason).toBe('closed');
  });

  it('serializes open/upgrade through navigator.locks when available and falls back on SecurityError', async () => {
    const idb = makeFakeIdb();
    vi.stubGlobal('indexedDB', idb.factory);
    const lockNames: string[] = [];
    vi.stubGlobal('navigator', {
      locks: {
        request: async (name: string, _options: unknown, work: () => Promise<unknown>) => {
          lockNames.push(name);
          return work();
        },
      },
    });
    const owner = new DatabaseOwner(scope, 'locked-db', 'create-or-open', simpleLayout);
    await Effect.runPromise(owner.open);
    expect(lockNames).toEqual(['lody:idb-open:locked-db']);
    await Effect.runPromise(owner.close);

    vi.stubGlobal('navigator', {
      locks: {
        request: async () => {
          throw new DOMException('Opaque origin', 'SecurityError');
        },
      },
    });
    const fallbackOwner = new DatabaseOwner(scope, 'opaque-db', 'create-or-open', simpleLayout);
    await Effect.runPromise(fallbackOwner.open);
    await Effect.runPromise(fallbackOwner.close);
  });
});
