import * as personal from '../../../e2ee-client/test/browser/host-fixture';
import { signOutWithoutRedirect, type LodyAuthClient } from '../../src/lib/auth';
import {
  markCacheClearPending,
  maybeClearLodyCacheOnBoot,
  resetBootClearMemoForTests,
  clearAllLodyLocalData,
} from '../../src/lib/clear-local-cache';

export { personal };
const prefix = 'lody-a6-personal';
export async function boot(mode: 'create-or-open' | 'open-existing') {
  await personal.boot(mode, false, prefix);
  await personal.bootRuntime();
}
export async function signOut() {
  return signOutWithoutRedirect({
    signOut: async () => ({ data: { success: true } }),
  } as unknown as LodyAuthClient);
}
export async function clear(enumerable: boolean, hard = false) {
  const enumerate = indexedDB.databases;
  try {
    if (!enumerable)
      Object.defineProperty(indexedDB, 'databases', { configurable: true, value: undefined });
    resetBootClearMemoForTests();
    if (hard) {
      await clearAllLodyLocalData();
      return;
    }
    markCacheClearPending();
    await maybeClearLodyCacheOnBoot();
    // A later caller's extraNames must not bypass the ordinary clear policy.
    await maybeClearLodyCacheOnBoot([prefix + '-custody', prefix + '-ledger']);
  } finally {
    Object.defineProperty(indexedDB, 'databases', { configurable: true, value: enumerate });
  }
}
export async function savedOriginals() {
  const dbs = (await indexedDB.databases())
    .filter((db) => db.name?.startsWith(prefix))
    .sort((a, b) => (a.name! < b.name! ? -1 : a.name === b.name ? 0 : 1));
  const saved: Record<string, Record<string, unknown[]>> = {};
  for (const { name } of dbs) {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name!);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      saved[name!] = await new Promise<Record<string, unknown[]>>((resolve, reject) => {
        const stores = [...db.objectStoreNames].filter((table) => table !== 'keys');
        const tx = db.transaction(stores);
        const values: Record<string, unknown[]> = {};
        for (const table of stores) {
          const request = tx.objectStore(table).getAll();
          request.onsuccess = () => {
            values[table] = request.result;
          };
        }
        tx.oncomplete = () => resolve(values);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }
  if (!Object.keys(saved).length) return 'empty';
  const bytes = new TextEncoder().encode(
    JSON.stringify(saved, (_key, value) =>
      value instanceof Uint8Array ? Array.from(value) : value
    )
  );
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

export async function reopen() {
  try {
    await boot('open-existing');
    const result = await personal.runtimeInvoke('open');
    return result.ok
      ? { ok: true, status: (await personal.runtimeInvoke('status')).value }
      : result;
  } catch (error) {
    const failure = error as { code?: string; reason?: string };
    return { ok: false, reason: failure.code ?? failure.reason ?? 'failed' };
  }
}
