import { PLUGIN_BUNDLE_CHUNK_BYTES, receiveClientBundle } from '@lody/shared/plugins/digest';
import { pluginManifestSchema, type PluginManifest } from '@lody/shared/plugins/manifest-schema';
import type { ClientCatalogInstallation } from './client-host-provider';
export interface WorkspaceRelease {
  npm: import('@lody/shared/plugins/workspace-entry').WorkspacePluginEntry;
  manifest: PluginManifest;
  digest: string;
  bytes: Uint8Array;
  origin: string;
  local: boolean;
  preferences: Record<string, string | number | boolean>;
}
export function workspacePage(record: WorkspaceRelease): ClientCatalogInstallation['page'] {
  return async (offset, signal) => {
    signal.throwIfAborted();
    return {
      bytes: record.bytes.slice(offset, offset + PLUGIN_BUNDLE_CHUNK_BYTES),
      totalBytes: record.bytes.length,
    };
  };
}
export async function fetchPinnedMachineBundle(
  npm: WorkspaceRelease['npm'],
  i: ClientCatalogInstallation,
  signal: AbortSignal
): Promise<WorkspaceRelease> {
  const manifest = pluginManifestSchema.parse(i.dev.manifest);
  if (i.dev.devMode || !i.enabled || i.digest !== npm.client_digest || i.pluginId !== npm.plugin_id)
    throw Error('Expected enabled workspace release');
  const bytes = await receiveClientBundle(i.digest, (offset) => i.page(offset, signal));
  signal.throwIfAborted();
  return {
    manifest,
    digest: i.digest,
    bytes,
    origin: i.dev.machineId,
    local: i.sourceKey === 'local',
    npm,
    preferences: {},
  };
}
export async function workspaceReleaseStore(
  namespace: string,
  signal: AbortSignal,
  changed?: () => void
) {
  signal.throwIfAborted();
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open('lody-plugin-releases:' + namespace, 2);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains('releases'))
        r.result.createObjectStore('releases', { keyPath: 'manifest.id' });
      r.result.createObjectStore('catalogSources', { keyPath: 'machine' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const close = () => db.close();
  if (signal.aborted) {
    close();
    signal.throwIfAborted();
  }
  const channel =
    typeof BroadcastChannel === 'undefined'
      ? undefined
      : new BroadcastChannel('lody-plugin-releases:' + namespace);
  if (channel) channel.onmessage = () => changed?.();
  signal.addEventListener('abort', () => channel?.close(), { once: true });
  signal.addEventListener('abort', close, { once: true });
  db.onversionchange = close;
  function run<T>(
    mode: IDBTransactionMode,
    op: (s: IDBObjectStore) => IDBRequest<T>,
    name = 'releases'
  ) {
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(name, mode),
        r = op(tx.objectStore(name));
      const abort = () => tx.abort();
      signal.addEventListener('abort', abort, { once: true });
      tx.oncomplete = () => {
        signal.removeEventListener('abort', abort);
        if (name === 'releases' && mode === 'readwrite' && !signal.aborted)
          channel?.postMessage('changed');
        resolve(r.result);
      };
      tx.onabort = () => {
        signal.removeEventListener('abort', abort);
        reject(tx.error ?? Error('Release transaction cancelled'));
      };
    });
  }
  async function configure(expected: WorkspaceRelease, changes: WorkspaceRelease['preferences']) {
    const validated = clientPreferenceChanges(expected.manifest, changes);
    let next: WorkspaceRelease | undefined;
    await run('readwrite', (store) => {
      const req = store.get(expected.manifest.id);
      req.onsuccess = () => {
        const current = req.result as WorkspaceRelease | undefined;
        if (
          !current?.npm ||
          current.digest !== expected.digest ||
          JSON.stringify(current.npm) !== JSON.stringify(expected.npm)
        )
          return;
        next = {
          ...current,
          preferences: {
            ...current.preferences,
            ...validated,
          },
        };
        store.put(next);
      };
      return req;
    });
    if (!next) throw Error('Stale installation');
    return next;
  }
  return {
    configure,
    catalogSources: () =>
      run<{ machine: string; plugins: string[] }[]>(
        'readonly',
        (s) => s.getAll(),
        'catalogSources'
      ),
    saveCatalogSources: (machine: string, plugins: string[]) =>
      run('readwrite', (s) => s.put({ machine, plugins }), 'catalogSources'),
    list: () => run<WorkspaceRelease[]>('readonly', (s) => s.getAll()),
    put: (row: WorkspaceRelease) => run('readwrite', (s) => s.put(row)),
    remove: (id: string) => run('readwrite', (s) => s.delete(id)),
  };
}
export function clientPreferenceChanges(
  manifest: PluginManifest,
  changes: Record<string, string | number | boolean>
) {
  for (const [k, v] of Object.entries(changes)) {
    const f = manifest.config?.[k];
    if (
      !f ||
      f.scope !== 'client' ||
      (f.type === 'select' ? !f.options.some((o) => o.value === v) : typeof v !== f.type) ||
      (f.type === 'number' &&
        typeof v === 'number' &&
        (!Number.isFinite(v) || v < (f.min ?? -Infinity) || v > (f.max ?? Infinity)))
    )
      throw Error('Invalid client preference');
  }
  return changes;
}
