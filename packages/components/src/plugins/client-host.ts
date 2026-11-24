import {
  beginShellGeneration,
  endShellGeneration,
  finishShellGeneration,
} from './shell-generation';
import type { ClientPluginRegistry, ClientPluginCleanup } from '@lody/plugin-sdk/client';
import {
  verifiedPackedBytes,
  VerifiedBundleCache,
  type ReadBundlePage,
  type VerifiedBundle,
} from './bundle-cache';
import { PluginQueryRegistry } from './query-registry';
import { pluginSafeMode } from './safe-mode';

export interface InstallationKey {
  workspaceId: string;
  sourceKey: 'local' | `machine:${string}`;
  pluginId: string;
}
export interface ClientInstallation extends InstallationKey {
  digest: string;
  machineId?: string;
  admissionKey?: string;
  configurationKey?: string;
  client?: string;
  page: ReadBundlePage;
  registry: (
    files: VerifiedBundle,
    signal: AbortSignal,
    queries: PluginQueryRegistry
  ) => ClientPluginRegistry;
}
interface Slot {
  admissionKey?: string;
  configurationKey?: string;
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
    if (
      previous &&
      install?.digest === previous.digest &&
      install.configurationKey === previous.configurationKey &&
      install.admissionKey === previous.admissionKey &&
      !previous.controller.signal.aborted
    )
      return previous.ready;

    const slot: Slot = {
      controller: new AbortController(),
      admissionKey: install?.admissionKey,
      configurationKey: install?.configurationKey,
      digest: install?.digest ?? '',
      ready: Promise.resolve(),
    };
    const continues =
      !!install &&
      !!previous &&
      !previous.controller.signal.aborted &&
      previous.admissionKey === install.admissionKey;
    beginShellGeneration(
      slot.controller.signal,
      continues ? previous.controller.signal : undefined
    );
    if (previous && !continues) endShellGeneration(previous.controller.signal);
    previous?.controller.abort();
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
      if (pluginSafeMode()) {
        endShellGeneration(signal);
        slot.controller.abort();
        return;
      }
      const definition = install.client
        ? await (
            await import('./module-loader')
          ).evaluateClientModule(
            new TextDecoder('utf-8', { fatal: true }).decode(files(install.client)),
            signal,
            install.machineId
              ? {
                  machineId: install.machineId,
                  workspaceId: install.workspaceId,
                  pluginId: install.pluginId,
                  digest: install.digest,
                  packed:
                    install.sourceKey === 'local' ? undefined : () => verifiedPackedBytes(files),
                }
              : undefined
          )
        : undefined;
      signal.throwIfAborted();
      if (pluginSafeMode()) {
        endShellGeneration(signal);
        slot.controller.abort();
        return;
      }
      const registry = install.registry(files, signal, new PluginQueryRegistry(signal));
      slot.cleanup = definition?.register(registry) || undefined;
      finishShellGeneration(signal);
    })()
      .catch((error) => {
        if (this.slots.get(id) === slot) endShellGeneration(slot.controller.signal);
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
