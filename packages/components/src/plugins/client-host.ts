import type { ClientPluginRegistry, ClientPluginCleanup } from '@lody/plugin-sdk/client';
import { VerifiedBundleCache, type ReadBundlePage, type VerifiedBundle } from './bundle-cache';
import { PluginQueryRegistry } from './query-registry';
import { pluginSafeMode } from './safe-mode';

export interface InstallationKey {
  workspaceId: string;
  sourceKey: 'local' | `machine:${string}`;
  pluginId: string;
}
export interface ClientInstallation extends InstallationKey {
  digest: string;
  client?: string;
  page: ReadBundlePage;
  registry: (
    files: VerifiedBundle,
    signal: AbortSignal,
    queries: PluginQueryRegistry
  ) => ClientPluginRegistry;
}
interface Slot {
  controller: AbortController;
  digest: string;
  ready: Promise<void>;
  cleanup?: ClientPluginCleanup;
}
/** Reconcile only admitted catalog entries. Disabling fences even a pending bundle import. */
export class ClientPluginHost {
  private readonly slots = new Map<string, Slot>();
  constructor(private readonly bundles = new VerifiedBundleCache()) {}
  reconcile(key: InstallationKey, install: ClientInstallation | null): Promise<void> {
    if (pluginSafeMode()) install = null;
    const id = JSON.stringify([key.workspaceId, key.sourceKey, key.pluginId]);
    if (
      install &&
      (install.pluginId !== key.pluginId ||
        install.sourceKey !== key.sourceKey ||
        install.workspaceId !== key.workspaceId)
    )
      return Promise.reject(new Error('Installation identity mismatch'));
    const previous = this.slots.get(id);
    if (previous && install?.digest === previous.digest && !previous.controller.signal.aborted)
      return previous.ready;
    previous?.controller.abort();
    const slot: Slot = {
      controller: new AbortController(),
      digest: install?.digest ?? '',
      ready: Promise.resolve(),
    };
    this.slots.set(id, slot);
    slot.ready = (async () => {
      if (previous) {
        await previous.ready.catch(() => {});
        await previous.cleanup?.();
      }
      const signal = slot.controller.signal;
      if (!install || signal.aborted) return;
      const files = await this.bundles.load(install.pluginId, install.digest, install.page, signal);
      signal.throwIfAborted();
      if (pluginSafeMode()) return;
      const definition = install.client
        ? await (
            await import('./module-loader')
          ).evaluateClientModule(
            new TextDecoder('utf-8', { fatal: true }).decode(files(install.client)),
            signal
          )
        : undefined;
      signal.throwIfAborted();
      if (pluginSafeMode()) return;
      const registry = install.registry(files, signal, new PluginQueryRegistry(signal));
      slot.cleanup = definition?.register(registry) || undefined;
    })()
      .catch((error) => {
        slot.controller.abort();
        throw error;
      })
      .finally(() => {
        if ((!install || slot.controller.signal.aborted) && this.slots.get(id) === slot)
          this.slots.delete(id);
      });
    return slot.ready;
  }
}
