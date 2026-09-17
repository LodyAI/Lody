import type { StorageAdapter } from 'loro-repo';
import {
  classifyStorageFailure,
  describeStorageFailure,
  enterStorageCrisis,
  getStorageCrisisState,
  StorageCrisisError,
  type StorageCrisisState,
} from '@/lib/storage-crisis';

/**
 * Wraps the repo's `StorageAdapter` with the fail-closed storage-crisis
 * breaker described in `lib/storage-crisis.ts`.
 *
 * Two jobs, both of which must sit UNDER the repo rather than at a call site:
 *
 * 1. Classify. Every adapter method is a place a disk-full IndexedDB can throw
 *    — `loadDoc` above all, because opening a brand-new session room already
 *    runs a readwrite transaction, so session creation fails before any write.
 *    A classified failure is re-thrown as `StorageCrisisError`, so the raw
 *    `IDBDatabase` / `transaction` DOMException text never reaches a toast.
 * 2. Fail closed. Once the crisis is latched, no call reaches IndexedDB again.
 *    Reads reject too: answering `undefined` would read as "this document does
 *    not exist" and invite a later write to overwrite durable history.
 *
 * `close()` is the one exception and stays delegated — it only closes the
 * handle, never opens a transaction, and runtime dispose depends on it.
 */
export type CrisisAwareStorageAdapterOptions = {
  /** Notified once, when the crisis latches. Diagnostics only. */
  readonly onCrisis?: (state: StorageCrisisState) => void;
};

export function createCrisisAwareStorageAdapter(
  inner: StorageAdapter,
  options: CrisisAwareStorageAdapterOptions = {}
): StorageAdapter {
  const run = async <T>(operation: string, execute: () => Promise<T>): Promise<T> => {
    const latched = getStorageCrisisState();
    if (latched) {
      throw new StorageCrisisError(latched.kind, operation);
    }
    try {
      return await execute();
    } catch (error) {
      const kind = classifyStorageFailure(error);
      if (!kind) throw error;
      const state: StorageCrisisState = {
        kind,
        operation,
        detail: describeStorageFailure(error),
      };
      const alreadyLatched = getStorageCrisisState() !== null;
      enterStorageCrisis(state);
      if (!alreadyLatched) {
        options.onCrisis?.(state);
      }
      throw new StorageCrisisError(kind, operation, { cause: error });
    }
  };

  const adapter: StorageAdapter = {
    save: (payload) => run('save', () => inner.save(payload)),
    loadDoc: (docId) => run('loadDoc', () => inner.loadDoc(docId)),
    loadMeta: () => run('loadMeta', () => inner.loadMeta()),
  };

  // Only forward the optional methods the wrapped adapter actually implements:
  // the repo feature-detects them, and a wrapper that always defines them would
  // advertise capabilities the inner adapter does not have.
  if (inner.init) {
    const init = inner.init.bind(inner);
    adapter.init = () => run('init', () => init());
  }
  if (inner.compactMeta) {
    const compactMeta = inner.compactMeta.bind(inner);
    adapter.compactMeta = () => run('compactMeta', () => compactMeta());
  }
  if (inner.compactFlockDoc) {
    const compactFlockDoc = inner.compactFlockDoc.bind(inner);
    adapter.compactFlockDoc = (flockDocId) =>
      run('compactFlockDoc', () => compactFlockDoc(flockDocId));
  }
  if (inner.loadFlockDoc) {
    const loadFlockDoc = inner.loadFlockDoc.bind(inner);
    adapter.loadFlockDoc = (flockDocId) => run('loadFlockDoc', () => loadFlockDoc(flockDocId));
  }
  if (inner.deleteDoc) {
    const deleteDoc = inner.deleteDoc.bind(inner);
    adapter.deleteDoc = (docId) => run('deleteDoc', () => deleteDoc(docId));
  }
  if (inner.deleteFlockDoc) {
    const deleteFlockDoc = inner.deleteFlockDoc.bind(inner);
    adapter.deleteFlockDoc = (flockDocId) =>
      run('deleteFlockDoc', () => deleteFlockDoc(flockDocId));
  }
  if (inner.close) {
    const close = inner.close.bind(inner);
    adapter.close = () => close();
  }

  return adapter;
}
