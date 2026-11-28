import { createAliasedIncompleteRecoveryStore } from '@lody/shared/workspace-streams-persistence';
import { IndexedDBStorageAdaptor } from 'loro-repo/storage/indexeddb';
import { getLoroStreamsRemoteCursorUrlAliases } from '@lody/shared';
import { getIpcServices } from '@/lib/electron-ipc-client';

/** Preserve the native adapter and all its checkpoint/batch capabilities. */
export function createWorkspaceRepoStorage(dbName: string): IndexedDBStorageAdaptor {
  let reporting: Promise<void> | undefined;
  return new IndexedDBStorageAdaptor({
    dbName,
    resolveStreamUrlAliases: getLoroStreamsRemoteCursorUrlAliases,
    onWriteFailure: () => {
      if (typeof window === 'undefined' || window.__LODY_ELECTRON__ !== true || reporting) return;
      const services = getIpcServices();
      if (!services) return;
      // This is observation only. IPC failure must never replace the original
      // storage rejection, or create an unhandled rejection of its own.
      reporting = services.storageGuard
        .reportWriteFailure()
        .catch(() => undefined)
        .finally(() => {
          reporting = undefined;
        });
    },
  });
}

/** A separate rebuildable metadata DB; never upgrade the Repo-owned schema. */
export function createWorkspaceIncompleteRecoveryStore(repoDbName: string) {
  const dbName = `${repoDbName}-incomplete-recovery`;
  let dbPromise: Promise<IDBDatabase> | null = null;

  const openDb = (): Promise<IDBDatabase> => {
    if (dbPromise) return dbPromise;
    let expired = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const fail = (error: unknown) => {
        expired = true;
        clearTimeout(timeout);
        if (dbPromise === opening) dbPromise = null;
        reject(error);
      };
      timeout = setTimeout(() => {
        fail(new Error('Recovery metadata database timed out'));
      }, 2000);
      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('records')) {
          request.result.createObjectStore('records');
        }
      };
      request.onerror = () => fail(request.error);
      request.onblocked = () => fail(new Error('Recovery metadata database blocked'));
      request.onsuccess = () => {
        clearTimeout(timeout);
        const db = request.result;
        if (expired) {
          db.close();
          return;
        }
        const clear = () => {
          if (dbPromise === opening) dbPromise = null;
        };
        db.onversionchange = () => {
          clear();
          db.close();
        };
        db.onclose = clear;
        resolve(db);
      };
    });
    dbPromise = opening;
    return opening;
  };

  async function run<T>(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => IDBRequest<T>
  ): Promise<T> {
    const db = await openDb();
    let transaction: IDBTransaction | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        const fail = (error: unknown) => {
          clearTimeout(timeout);
          reject(error);
        };
        timeout = setTimeout(() => {
          fail(new Error('Recovery metadata database timed out'));
          transaction?.abort();
        }, 2000);
        try {
          const tx = db.transaction('records', mode);
          transaction = tx;
          const result = action(tx.objectStore('records'));
          tx.oncomplete = () => {
            clearTimeout(timeout);
            resolve(result.result);
          };
          tx.onabort = () => fail(tx.error);
          tx.onerror = () => fail(tx.error);
        } catch (error) {
          dbPromise = null;
          fail(error);
        }
      });
    } finally {
      clearTimeout(timeout);
    }
  }
  return createAliasedIncompleteRecoveryStore({
    load: (key) => run<unknown>('readonly', (store) => store.get(key)),
    save: async (key, value) => {
      await run('readwrite', (store) => store.put(value, key));
    },
    delete: async (key) => {
      await run('readwrite', (store) => store.delete(key));
    },
  });
}
