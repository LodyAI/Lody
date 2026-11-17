// Rebuildable scheduling metadata only; never a document or remote cursor.
export const EAGER_SYNC_ADMISSION_DB = 'lody:eager-sync-admission-v1';
export const CACHE_REJECTION_COOLDOWN_MS = 30 * 60 * 1000;
const STORE = 'rejections';
const MAX_ENTRIES = 1000;
type Rejection = { key: string; lastMessageAt: number; rejectedAt: number };

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, result: (value: T) => void) => void
): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    let blocked = false;
    const request = indexedDB.open(EAGER_SYNC_ADMISSION_DB, 1);
    request.onupgradeneeded = () => {
      request.result
        .createObjectStore(STORE, { keyPath: 'key' })
        .createIndex('rejectedAt', 'rejectedAt');
    };
    request.onsuccess = () => {
      if (blocked) request.result.close();
      else resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      blocked = true;
      reject(new Error('Eager-sync admission cache blocked'));
    };
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      let value: T;
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
      run(transaction.objectStore(STORE), (next) => {
        value = next;
      });
    });
  } finally {
    db.close();
  }
}

export async function readEagerSyncRejection(key: string): Promise<Rejection | undefined> {
  return withStore('readonly', (store, result) => {
    const request = store.get(key);
    request.onsuccess = () => result(request.result);
  });
}

export async function writeEagerSyncRejection(row: Rejection): Promise<void> {
  return withStore('readwrite', (store, result) => {
    store.put(row);
    const request = store.index('rejectedAt').getAllKeys();
    request.onsuccess = () => {
      for (const key of request.result.slice(0, Math.max(0, request.result.length - MAX_ENTRIES))) {
        store.delete(key);
      }
      result(undefined);
    };
  });
}
