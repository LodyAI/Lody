import type { SessionId } from '@lody/shared';
import type { EagerSyncHighWaterStore } from '../providers/background-sync-coordinator';

export const EAGER_SYNC_HIGH_WATER_DB_NAME = 'lody:eager-sync-high-water';
export const EAGER_SYNC_HIGH_WATER_STORE_NAME = 'sessions';

const EAGER_SYNC_HIGH_WATER_DB_VERSION = 1;
const EAGER_SYNC_HIGH_WATER_WORKSPACE_INDEX = 'byWorkspace';
const DEFAULT_MAX_ENTRIES = 1_000;

type HighWaterRow = {
  key: string;
  workspaceId: string;
  sessionId: string;
  lastMessageAt: number;
  cachedAt: number;
};

export type EagerSyncHighWaterCache = EagerSyncHighWaterStore & {
  flush(): Promise<void>;
  close(): void;
};

const getBrowserIndexedDb = (): IDBFactory | null => {
  try {
    return globalThis.indexedDB ?? null;
  } catch {
    return null;
  }
};

const keyOf = (cacheNamespace: string, sessionId: SessionId): string =>
  `${cacheNamespace}:${sessionId}`;

const normalizeMaxEntries = (value: number | undefined): number => {
  if (value == null) {
    return DEFAULT_MAX_ENTRIES;
  }
  if (!Number.isFinite(value) || value < 1) {
    return DEFAULT_MAX_ENTRIES;
  }
  return Math.floor(value);
};

const isHighWaterRow = (value: unknown): value is HighWaterRow => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Partial<HighWaterRow>;
  return (
    typeof row.key === 'string' &&
    typeof row.workspaceId === 'string' &&
    typeof row.sessionId === 'string' &&
    typeof row.lastMessageAt === 'number' &&
    Number.isFinite(row.lastMessageAt) &&
    typeof row.cachedAt === 'number' &&
    Number.isFinite(row.cachedAt)
  );
};

const requestToPromise = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    request.onsuccess = () => resolve(request.result);
  });

const transactionDone = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });

function openHighWaterDb(indexedDb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDb.open(EAGER_SYNC_HIGH_WATER_DB_NAME, EAGER_SYNC_HIGH_WATER_DB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      const store = db.objectStoreNames.contains(EAGER_SYNC_HIGH_WATER_STORE_NAME)
        ? request.transaction?.objectStore(EAGER_SYNC_HIGH_WATER_STORE_NAME)
        : db.createObjectStore(EAGER_SYNC_HIGH_WATER_STORE_NAME, { keyPath: 'key' });
      if (store && !store.indexNames.contains(EAGER_SYNC_HIGH_WATER_WORKSPACE_INDEX)) {
        store.createIndex(EAGER_SYNC_HIGH_WATER_WORKSPACE_INDEX, 'workspaceId', {
          unique: false,
        });
      }
    };
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'));
    request.onblocked = () =>
      reject(new Error('Opening eager-sync high-water IndexedDB was blocked'));
    request.onsuccess = () => resolve(request.result);
  });
}

async function readWorkspaceRows(db: IDBDatabase, cacheNamespace: string): Promise<HighWaterRow[]> {
  const tx = db.transaction(EAGER_SYNC_HIGH_WATER_STORE_NAME, 'readonly');
  const store = tx.objectStore(EAGER_SYNC_HIGH_WATER_STORE_NAME);
  const request = store.indexNames.contains(EAGER_SYNC_HIGH_WATER_WORKSPACE_INDEX)
    ? store.index(EAGER_SYNC_HIGH_WATER_WORKSPACE_INDEX).getAll(cacheNamespace)
    : store.getAll();
  const [rows] = await Promise.all([requestToPromise<unknown[]>(request), transactionDone(tx)]);
  return rows.filter(
    (row): row is HighWaterRow => isHighWaterRow(row) && row.workspaceId === cacheNamespace
  );
}

async function putRow(db: IDBDatabase, row: HighWaterRow): Promise<void> {
  const tx = db.transaction(EAGER_SYNC_HIGH_WATER_STORE_NAME, 'readwrite');
  tx.objectStore(EAGER_SYNC_HIGH_WATER_STORE_NAME).put(row);
  await transactionDone(tx);
}

async function deleteRows(db: IDBDatabase, keys: string[]): Promise<void> {
  if (keys.length === 0) {
    return;
  }
  const tx = db.transaction(EAGER_SYNC_HIGH_WATER_STORE_NAME, 'readwrite');
  const store = tx.objectStore(EAGER_SYNC_HIGH_WATER_STORE_NAME);
  for (const key of keys) {
    store.delete(key);
  }
  await transactionDone(tx);
}

async function pruneWorkspaceRows(
  db: IDBDatabase,
  cacheNamespace: string,
  maxEntries: number
): Promise<void> {
  const rows = await readWorkspaceRows(db, cacheNamespace);
  if (rows.length <= maxEntries) {
    return;
  }
  const staleKeys = rows
    .sort((left, right) => {
      if (right.lastMessageAt !== left.lastMessageAt) {
        return right.lastMessageAt - left.lastMessageAt;
      }
      return right.cachedAt - left.cachedAt;
    })
    .slice(maxEntries)
    .map((row) => row.key);
  await deleteRows(db, staleKeys);
}

function pruneMemory(
  values: Map<SessionId, number>,
  cachedAtBySession: Map<SessionId, number>,
  maxEntries: number
): void {
  if (values.size <= maxEntries) {
    return;
  }
  const stale = Array.from(values.entries())
    .map(([sessionId, lastMessageAt]) => ({
      sessionId,
      lastMessageAt,
      cachedAt: cachedAtBySession.get(sessionId) ?? 0,
    }))
    .sort((left, right) => {
      if (right.lastMessageAt !== left.lastMessageAt) {
        return right.lastMessageAt - left.lastMessageAt;
      }
      return right.cachedAt - left.cachedAt;
    })
    .slice(maxEntries);
  for (const row of stale) {
    values.delete(row.sessionId);
    cachedAtBySession.delete(row.sessionId);
  }
}

function createMemoryHighWaterStore(options: {
  maxEntries: number;
  now: () => number;
  initialRows?: HighWaterRow[];
}): EagerSyncHighWaterCache {
  const values = new Map<SessionId, number>();
  const cachedAtBySession = new Map<SessionId, number>();
  for (const row of options.initialRows ?? []) {
    const sessionId = row.sessionId as SessionId;
    const current = values.get(sessionId);
    if (current == null || row.lastMessageAt > current) {
      values.set(sessionId, row.lastMessageAt);
      cachedAtBySession.set(sessionId, row.cachedAt);
    }
  }
  pruneMemory(values, cachedAtBySession, options.maxEntries);
  return {
    get(sessionId) {
      return values.get(sessionId);
    },
    set(sessionId, lastMessageAt) {
      if (!Number.isFinite(lastMessageAt)) {
        return;
      }
      const current = values.get(sessionId);
      if (current != null && current >= lastMessageAt) {
        return;
      }
      values.set(sessionId, lastMessageAt);
      cachedAtBySession.set(sessionId, options.now());
      pruneMemory(values, cachedAtBySession, options.maxEntries);
    },
    flush: () => Promise.resolve(),
    close: () => {},
  };
}

export async function createEagerSyncHighWaterStore(
  cacheNamespace: string,
  options: {
    maxEntries?: number;
    now?: () => number;
  } = {}
): Promise<EagerSyncHighWaterCache> {
  const maxEntries = normalizeMaxEntries(options.maxEntries);
  const now = options.now ?? (() => Date.now());
  const indexedDb = getBrowserIndexedDb();
  if (!indexedDb) {
    return createMemoryHighWaterStore({ maxEntries, now });
  }

  let db: IDBDatabase | null = null;
  let rows: HighWaterRow[];
  try {
    db = await openHighWaterDb(indexedDb);
    rows = await readWorkspaceRows(db, cacheNamespace);
  } catch {
    db?.close();
    return createMemoryHighWaterStore({ maxEntries, now });
  }

  const values = new Map<SessionId, number>();
  const cachedAtBySession = new Map<SessionId, number>();
  for (const row of rows) {
    const sessionId = row.sessionId as SessionId;
    const current = values.get(sessionId);
    if (current == null || row.lastMessageAt > current) {
      values.set(sessionId, row.lastMessageAt);
      cachedAtBySession.set(sessionId, row.cachedAt);
    }
  }
  pruneMemory(values, cachedAtBySession, maxEntries);

  let writeChain = Promise.resolve();
  const enqueueWrite = (task: () => Promise<void>) => {
    writeChain = writeChain.then(task, task).catch(() => {});
    return writeChain;
  };

  return {
    get(sessionId) {
      return values.get(sessionId);
    },
    set(sessionId, lastMessageAt) {
      if (!Number.isFinite(lastMessageAt)) {
        return;
      }
      const current = values.get(sessionId);
      if (current != null && current >= lastMessageAt) {
        return;
      }
      const cachedAt = now();
      values.set(sessionId, lastMessageAt);
      cachedAtBySession.set(sessionId, cachedAt);
      pruneMemory(values, cachedAtBySession, maxEntries);

      const row: HighWaterRow = {
        key: keyOf(cacheNamespace, sessionId),
        // Keep the persisted field name for schema compatibility. Its value is
        // the cache namespace, which is workspace-scoped in single-window clients.
        workspaceId: cacheNamespace,
        sessionId,
        lastMessageAt,
        cachedAt,
      };
      void enqueueWrite(async () => {
        await putRow(db, row);
        await pruneWorkspaceRows(db, cacheNamespace, maxEntries);
      });
    },
    flush: () => writeChain,
    close: () => db.close(),
  };
}
