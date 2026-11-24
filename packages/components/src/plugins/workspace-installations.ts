import { PLUGIN_BUNDLE_CHUNK_BYTES, receiveClientBundle } from '@lody/shared/plugins/digest';
import { pluginManifestSchema, type PluginManifest } from '@lody/shared/plugins/manifest-schema';
import type { ClientCatalogInstallation } from './client-host-provider';
export function workspaceOnly(m: PluginManifest) {
  return (
    !m.machine && ![m.skills, m.agentRoles, m.mcpServers, m.acpProviders].some((c) => c?.length)
  );
}
export interface WorkspaceRelease {
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
export async function captureRelease(
  i: ClientCatalogInstallation,
  signal: AbortSignal
): Promise<WorkspaceRelease> {
  const manifest = pluginManifestSchema.parse(i.dev.manifest);
  if (i.dev.devMode || !workspaceOnly(manifest) || !i.enabled)
    throw Error('Expected enabled workspace release');
  const bytes = await receiveClientBundle(i.digest, (offset) => i.page(offset, signal));
  signal.throwIfAborted();
  return {
    manifest,
    digest: i.digest,
    bytes,
    origin: i.dev.machineId,
    local: i.sourceKey === 'local',
    preferences: Object.fromEntries(
      Object.entries(i.inspection?.preferences ?? {}).filter(([k]) => {
        const f = manifest.config?.[k];
        return f?.scope === 'client';
      })
    ),
  };
}
export async function workspaceReleaseStore(namespace: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open('lody-plugin-releases:' + namespace, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('releases', { keyPath: 'manifest.id' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const close = () => db.close();
  if (signal.aborted) {
    close();
    signal.throwIfAborted();
  }
  signal.addEventListener('abort', close, { once: true });
  db.onversionchange = close;
  function run<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>) {
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction('releases', mode),
        r = op(tx.objectStore('releases'));
      const abort = () => tx.abort();
      signal.addEventListener('abort', abort, { once: true });
      tx.oncomplete = () => {
        signal.removeEventListener('abort', abort);
        resolve(r.result);
      };
      tx.onabort = () => {
        signal.removeEventListener('abort', abort);
        reject(tx.error ?? Error('Release transaction cancelled'));
      };
    });
  }
  return {
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
