// Rebuildable scheduling metadata only; never a document or remote cursor.
export const EAGER_SYNC_ADMISSION_DB = 'lody:eager-sync-admission-v1';
export const CACHE_REJECTION_COOLDOWN_MS = 30 * 60 * 1000;
const STORE = 'rejections';
const MAX_ENTRIES = 1000;
type Rejection = { key: string; lastMessageAt: number; rejectedAt: number; outcome?: 'failed' };

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, result: (value: T) => void) => void,
  signal?: AbortSignal
): Promise<T> {
  signal?.throwIfAborted();
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    let retired = false;
    const request = indexedDB.open(EAGER_SYNC_ADMISSION_DB, 1);
    const abort = () => {
      retired = true;
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
    request.onupgradeneeded = () => {
      if (retired) {
        request.transaction?.abort();
        request.result.close();
        return;
      }
      request.result
        .createObjectStore(STORE, { keyPath: 'key' })
        .createIndex('rejectedAt', 'rejectedAt');
    };
    request.onsuccess = () => {
      signal?.removeEventListener('abort', abort);
      if (retired) request.result.close();
      else resolve(request.result);
    };
    request.onerror = () => {
      signal?.removeEventListener('abort', abort);
      reject(request.error);
    };
    request.onblocked = () => {
      retired = true;
      signal?.removeEventListener('abort', abort);
      reject(new Error('Eager-sync admission cache blocked'));
    };
  });
  try {
    signal?.throwIfAborted();
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      let value: T;
      let failure: unknown;
      const abort = () => {
        failure = signal?.reason;
        // Aborting the waiter alone would leave a writer outside the claim.
        // Wait for the actual transaction's terminal event, including when it
        // was already committing and abort() can no longer interrupt it.
        try {
          transaction.abort();
        } catch {
          /* terminal event still owns completion */
        }
      };
      const complete = () => signal?.removeEventListener('abort', abort);
      transaction.oncomplete = () => {
        complete();
        resolve(value);
      };
      transaction.onabort = () => {
        complete();
        reject(failure ?? transaction.error);
      };
      // A request error normally aborts the transaction. Do not release the
      // claim at its bubbling error event, before that abort has completed.
      transaction.onerror = () => {
        failure ??= transaction.error;
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      try {
        run(transaction.objectStore(STORE), (next) => {
          value = next;
        });
      } catch (error) {
        failure ??= error;
        try {
          transaction.abort();
        } catch {
          /* wait for its terminal event */
        }
      }
    });
  } finally {
    db.close();
  }
}

export async function readEagerSyncRejection(
  key: string,
  signal?: AbortSignal
): Promise<Rejection | undefined> {
  return withStore(
    'readonly',
    (store, result) => {
      const request = store.get(key);
      request.onsuccess = () => result(request.result);
    },
    signal
  );
}

export async function writeEagerSyncRejection(row: Rejection, signal?: AbortSignal): Promise<void> {
  return withStore(
    'readwrite',
    (store, result) => {
      store.put(row);
      const request = store.index('rejectedAt').getAllKeys();
      request.onsuccess = () => {
        for (const key of request.result.slice(
          0,
          Math.max(0, request.result.length - MAX_ENTRIES)
        )) {
          store.delete(key);
        }
        result(undefined);
      };
    },
    signal
  );
}
