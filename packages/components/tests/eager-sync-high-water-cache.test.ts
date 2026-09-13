import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionId, WorkspaceId } from '@lody/shared';
import {
  createEagerSyncHighWaterStore,
  EAGER_SYNC_HIGH_WATER_DB_NAME,
} from '../src/lib/eager-sync-high-water-cache';

const originalIndexedDbDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

const sid = (id: string) => id as SessionId;
const wid = (id: string) => id as WorkspaceId;

type RequestHandler = ((event: Event) => void) | null;

type FakeRequest<T> = IDBRequest<T> & {
  result: T;
  error: DOMException | null;
  onsuccess: RequestHandler;
  onerror: RequestHandler;
};

type FakeOpenRequest = FakeRequest<IDBDatabase> & {
  onblocked: RequestHandler;
  onupgradeneeded: ((event: IDBVersionChangeEvent) => void) | null;
  transaction: IDBTransaction | null;
};

const createRequest = <T>(): FakeRequest<T> =>
  ({
    result: undefined as T,
    error: null,
    onsuccess: null,
    onerror: null,
  }) as FakeRequest<T>;

class FakeTransaction {
  error: DOMException | null = null;
  onabort: RequestHandler = null;
  oncomplete: RequestHandler = null;
  onerror: RequestHandler = null;

  private pending = 0;
  private completed = false;
  private completionScheduled = false;

  constructor(private readonly db: FakeDatabase) {
    this.scheduleCompletion();
  }

  objectStore(name: string): IDBObjectStore {
    if (name !== this.db.storeName) {
      throw new Error(`Unknown object store: ${name}`);
    }
    return new FakeObjectStore(this.db, this) as unknown as IDBObjectStore;
  }

  trackRequest(): void {
    this.pending += 1;
  }

  settleRequest(): void {
    this.pending -= 1;
    this.scheduleCompletion();
  }

  private scheduleCompletion(): void {
    if (this.completed || this.completionScheduled) {
      return;
    }
    this.completionScheduled = true;
    setTimeout(() => {
      this.completionScheduled = false;
      if (this.pending !== 0 || this.completed) {
        return;
      }
      this.completed = true;
      this.oncomplete?.({} as Event);
    }, 0);
  }
}

class FakeObjectStore {
  constructor(
    private readonly db: FakeDatabase,
    private readonly tx: FakeTransaction | null = null
  ) {}

  get indexNames(): DOMStringList {
    return {
      contains: (name: string) => this.db.indexes.has(name),
    } as DOMStringList;
  }

  createIndex(name: string, keyPath: string | string[]): IDBIndex {
    this.db.indexes.set(name, Array.isArray(keyPath) ? keyPath[0] : keyPath);
    return {} as IDBIndex;
  }

  index(name: string): IDBIndex {
    const keyPath = this.db.indexes.get(name);
    if (!keyPath) {
      throw new Error(`Unknown index: ${name}`);
    }
    return {
      getAll: (query?: IDBValidKey | IDBKeyRange) => {
        const rows = Array.from(this.db.rows.values()).filter((row) => {
          if (typeof query !== 'string') {
            return true;
          }
          return (row as Record<string, unknown>)[keyPath] === query;
        });
        return this.completeRequest(rows);
      },
    } as IDBIndex;
  }

  getAll(): IDBRequest<unknown[]> {
    return this.completeRequest(Array.from(this.db.rows.values()));
  }

  put(value: unknown): IDBRequest<IDBValidKey> {
    const key = String((value as { key: string }).key);
    return this.completeRequest<IDBValidKey>(key, () => {
      this.db.rows.set(key, value);
    });
  }

  delete(key: IDBValidKey): IDBRequest<undefined> {
    return this.completeRequest(undefined, () => {
      this.db.rows.delete(String(key));
    });
  }

  private completeRequest<T>(result: T, beforeSuccess?: () => void): IDBRequest<T> {
    const request = createRequest<T>();
    this.tx?.trackRequest();
    setTimeout(() => {
      beforeSuccess?.();
      request.result = result;
      request.onsuccess?.({} as Event);
      this.tx?.settleRequest();
    }, 0);
    return request;
  }
}

class FakeDatabase {
  readonly indexes = new Map<string, string>();
  readonly rows = new Map<string, unknown>();
  storeName: string | null = null;

  get objectStoreNames(): DOMStringList {
    return {
      contains: (name: string) => this.storeName === name,
    } as DOMStringList;
  }

  createObjectStore(name: string): IDBObjectStore {
    this.storeName = name;
    return new FakeObjectStore(this) as unknown as IDBObjectStore;
  }

  transaction(name: string): IDBTransaction {
    if (name !== this.storeName) {
      throw new Error(`Unknown object store: ${name}`);
    }
    return new FakeTransaction(this) as unknown as IDBTransaction;
  }

  close(): void {}
}

function installFakeIndexedDb() {
  const databases = new Map<string, FakeDatabase>();
  const factory = {
    open: (name: string) => {
      const request = createRequest<IDBDatabase>() as FakeOpenRequest;
      request.onblocked = null;
      request.onupgradeneeded = null;
      request.transaction = null;
      setTimeout(() => {
        let db = databases.get(name);
        const isNew = !db;
        if (!db) {
          db = new FakeDatabase();
          databases.set(name, db);
        }
        request.result = db as unknown as IDBDatabase;
        if (isNew) {
          request.transaction = new FakeTransaction(db) as unknown as IDBTransaction;
          request.onupgradeneeded?.({} as IDBVersionChangeEvent);
          request.transaction = null;
        }
        request.onsuccess?.({} as Event);
      }, 0);
      return request;
    },
  } as unknown as IDBFactory;

  Object.defineProperty(globalThis, 'indexedDB', {
    value: factory,
    configurable: true,
    writable: true,
  });
  return { databases };
}

function installThrowingLocalStorage() {
  const storage = {
    get length() {
      return 0;
    },
    clear: vi.fn(() => {
      throw new Error('localStorage must not be used');
    }),
    getItem: vi.fn(() => {
      throw new Error('localStorage must not be used');
    }),
    key: vi.fn(() => null),
    removeItem: vi.fn(() => {
      throw new Error('localStorage must not be used');
    }),
    setItem: vi.fn(() => {
      throw new Error('localStorage must not be used');
    }),
  } as Storage;
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });
  return storage;
}

function installNoIndexedDb(): void {
  Object.defineProperty(globalThis, 'indexedDB', {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  if (originalIndexedDbDescriptor) {
    Object.defineProperty(globalThis, 'indexedDB', originalIndexedDbDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'indexedDB');
  }
  if (originalLocalStorageDescriptor) {
    Object.defineProperty(globalThis, 'localStorage', originalLocalStorageDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

describe('eager sync high-water cache', () => {
  it('isolates synced-through timestamps between windows in one workspace', async () => {
    const fake = installFakeIndexedDb();
    const localStorage = installThrowingLocalStorage();
    const windowA = await createEagerSyncHighWaterStore('workspace-alpha:window-a', {
      now: () => 1,
    });

    windowA.set(sid('session-a'), 100);
    await windowA.flush();

    const reloadedWindowA = await createEagerSyncHighWaterStore('workspace-alpha:window-a', {
      now: () => 2,
    });
    const windowB = await createEagerSyncHighWaterStore('workspace-alpha:window-b', {
      now: () => 2,
    });

    expect(fake.databases.has(EAGER_SYNC_HIGH_WATER_DB_NAME)).toBe(true);
    expect(reloadedWindowA.get(sid('session-a'))).toBe(100);
    expect(windowB.get(sid('session-a'))).toBeUndefined();
    expect(localStorage.getItem).not.toHaveBeenCalled();
    expect(localStorage.setItem).not.toHaveBeenCalled();

    windowA.close();
    reloadedWindowA.close();
    windowB.close();
  });

  it('never lowers an existing high-water mark', async () => {
    installFakeIndexedDb();
    const cache = await createEagerSyncHighWaterStore(wid('workspace-alpha'));

    cache.set(sid('session-a'), 200);
    await cache.flush();
    cache.set(sid('session-a'), 100);
    await cache.flush();

    const reloaded = await createEagerSyncHighWaterStore(wid('workspace-alpha'));
    expect(reloaded.get(sid('session-a'))).toBe(200);

    cache.close();
    reloaded.close();
  });

  it('prunes old entries to bound IndexedDB growth', async () => {
    installFakeIndexedDb();
    let now = 0;
    const cache = await createEagerSyncHighWaterStore(wid('workspace-alpha'), {
      maxEntries: 2,
      now: () => {
        now += 1;
        return now;
      },
    });

    cache.set(sid('old'), 100);
    cache.set(sid('middle'), 200);
    cache.set(sid('new'), 300);
    await cache.flush();

    const reloaded = await createEagerSyncHighWaterStore(wid('workspace-alpha'));
    expect(reloaded.get(sid('old'))).toBeUndefined();
    expect(reloaded.get(sid('middle'))).toBe(200);
    expect(reloaded.get(sid('new'))).toBe(300);

    cache.close();
    reloaded.close();
  });

  it('falls back to an in-memory store when IndexedDB is unavailable without touching localStorage', async () => {
    installNoIndexedDb();
    const localStorage = installThrowingLocalStorage();
    const cache = await createEagerSyncHighWaterStore(wid('workspace-alpha'));

    cache.set(sid('session-a'), 100);
    await cache.flush();

    const reloaded = await createEagerSyncHighWaterStore(wid('workspace-alpha'));
    expect(cache.get(sid('session-a'))).toBe(100);
    expect(reloaded.get(sid('session-a'))).toBeUndefined();
    expect(localStorage.getItem).not.toHaveBeenCalled();
    expect(localStorage.setItem).not.toHaveBeenCalled();

    cache.close();
    reloaded.close();
  });
});
