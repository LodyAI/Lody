import { IndexedDBStorageAdaptor } from 'loro-repo/storage/indexeddb';
import { getIpcServices } from '@/lib/electron-ipc-client';

/** Preserve the native adapter and all its checkpoint/batch capabilities. */
export function createWorkspaceRepoStorage(dbName: string): IndexedDBStorageAdaptor {
  let reporting: Promise<void> | undefined;
  return new IndexedDBStorageAdaptor({
    dbName,
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
