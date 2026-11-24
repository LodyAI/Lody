import { clientStorage } from './client-storage';
import {
  pluginOwnerSyncSubject,
  type WorkspacePluginEntry,
} from '@lody/shared/plugins/workspace-entry';

/** Host-only keyspace (":" is not a legal plugin ID); removed with this signing device's custody database. */
export function ownerSyncCustody(namespace: string, signal: AbortSignal) {
  const storage = clientStorage(namespace, ':owner-sync', signal);
  const receipt = (pin: WorkspacePluginEntry) =>
    JSON.stringify([pin.sync_signature, pluginOwnerSyncSubject(pin).contentDigest]);
  return {
    async locked<T>(plugin: string, work: () => Promise<T>) {
      signal.throwIfAborted();
      return navigator.locks.request(
        JSON.stringify(['lody:owner-sync', namespace, plugin]),
        { signal },
        async () => {
          signal.throwIfAborted();
          return work();
        }
      );
    },
    async remember(pin: WorkspacePluginEntry) {
      await storage.set(pin.plugin_id, receipt(pin));
    },
    async allows(pin: WorkspacePluginEntry) {
      return (
        pin.machine_sync === 'owner_machines' && (await storage.get(pin.plugin_id)) === receipt(pin)
      );
    },
    async suspend(pin: WorkspacePluginEntry) {
      const old = await storage.get(pin.plugin_id);
      const revoked = receipt(pin);
      if (old !== undefined && old !== revoked) await storage.set(pin.plugin_id, revoked);
    },
  };
}
export type OwnerSyncCustody = ReturnType<typeof ownerSyncCustody>;
