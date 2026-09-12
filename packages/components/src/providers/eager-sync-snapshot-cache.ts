// Rebuildable, worker-authored cache. Never share the UI repo's persistence or
// stream cursors: that repo may contain user edits this downloader has not seen.
export const EAGER_SYNC_CACHE_DB = 'lody:eager-sync-snapshots-v1';
const STORE = 'snapshots';
const MAX_CACHE_BYTES = 128 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 64;

export type EagerSyncSnapshot = {
  key: string;
  scope: string;
  roomId: string;
  plane: 'local' | 'cloud';
  lastMessageAt: number;
  savedAt: number;
  snapshot: Blob;
};

const keyOf = (scope: string, roomId: string) => JSON.stringify([scope, roomId]);

function openCache(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let blocked = false;
    const request = indexedDB.open(EAGER_SYNC_CACHE_DB, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: 'key' });
      store.createIndex('savedAt', 'savedAt');
    };
    request.onsuccess = () => {
      if (blocked) request.result.close();
      else resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      blocked = true;
      reject(new Error('Eager-sync cache blocked'));
    };
  });
}

export async function readEagerSyncSnapshot(
  scope: string,
  roomId: string
): Promise<EagerSyncSnapshot | undefined> {
  const db = await openCache();
  try {
    return await new Promise<EagerSyncSnapshot | undefined>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readonly');
      const request = transaction.objectStore(STORE).get(keyOf(scope, roomId));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

// Snapshot and activity checkpoint are one row and one transaction. A killed
// worker leaves either the previous complete snapshot or the new complete one.
export async function writeEagerSyncSnapshot(
  row: Omit<EagerSyncSnapshot, 'key'>,
  maxBytes = MAX_CACHE_BYTES
): Promise<boolean> {
  if (row.snapshot.size > maxBytes) return false;
  const db = await openCache();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite');
      const store = transaction.objectStore(STORE);
      const key = keyOf(row.scope, row.roomId);
      const existingRequest = store.get(key);
      existingRequest.onsuccess = () => {
        const existing = existingRequest.result as EagerSyncSnapshot | undefined;
        // Multiple windows share this row. A slower worker must not replace a
        // newer checkpoint from another window on the same transport plane.
        if (existing?.plane === row.plane && existing.lastMessageAt > row.lastMessageAt) {
          return;
        }
        store.put({ ...row, key });
        // Blobs are lazy handles; scanning sizes does not deserialize histories.
        const request = store.index('savedAt').getAll();
        request.onsuccess = () => {
          const rows = request.result as EagerSyncSnapshot[];
          let bytes = rows.reduce((sum, entry) => sum + entry.snapshot.size, 0);
          let count = rows.length;
          for (const entry of rows) {
            if (bytes <= maxBytes && count <= MAX_CACHE_ENTRIES) break;
            if (entry.key === key) continue;
            store.delete(entry.key);
            bytes -= entry.snapshot.size;
            count--;
          }
        };
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
    return true;
  } finally {
    db.close();
  }
}
