import { pluginStorageKey, storedJson } from '@lody/shared/plugins/storage';
import type { PluginStorage } from '@lody/plugin-sdk';
export function clientStorage(
  namespace: string,
  plugin: string,
  signal: AbortSignal
): PluginStorage {
  async function transaction<T>(
    key: string,
    work: (old: string | undefined, store: IDBObjectStore, id: string[]) => T
  ): Promise<T> {
    const id = [plugin, pluginStorageKey.parse(key)];
    signal.throwIfAborted();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('lody-plugin-storage:' + namespace, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      signal.throwIfAborted();
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite'),
          s = tx.objectStore('kv'),
          r = s.get(id);
        let result: T;
        const abort = () => tx.abort();
        signal.addEventListener('abort', abort, { once: true });
        tx.oncomplete = () => {
          signal.removeEventListener('abort', abort);
          resolve(result);
        };
        tx.onabort = () => {
          signal.removeEventListener('abort', abort);
          reject(tx.error ?? Error('Plugin storage aborted'));
        };
        r.onsuccess = () => {
          try {
            result = work(r.result, s, id);
          } catch (e) {
            tx.abort();
            reject(e);
          }
        };
      });
    } finally {
      db.close();
    }
  }
  return {
    get: (key) => transaction(key, (v) => (v === undefined ? undefined : JSON.parse(v))),
    set: (key, value) =>
      transaction(key, (_, s, id) => {
        s.put(storedJson(value), id);
      }),
    delete: (key) =>
      transaction(key, (_, s, id) => {
        s.delete(id);
      }),
    update: (key, expected, value) =>
      transaction(key, (old, s, id) => {
        if (old !== (expected === undefined ? undefined : storedJson(expected))) return false;
        if (value === undefined) s.delete(id);
        else s.put(storedJson(value), id);
        return true;
      }),
  };
}
