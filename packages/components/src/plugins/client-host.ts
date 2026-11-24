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
  sourceKey: 'workspace' | 'local' | `machine:${string}`;
  pluginId: string;
}
export interface ClientInstallation extends InstallationKey {
  digest: string;
  /** Machine-side nonce bumped by `ctx.invalidate`; a change refreshes this plugin's queries. */
  invalidations?: number;
  machineId?: string;
  localModule?: boolean;
  workspaceManifest?: import('@lody/shared/plugins/manifest-schema').PluginManifest;
  primary?: boolean;
  admissionKey?: string;
  configurationKey?: string;
  client?: string;
  page: ReadBundlePage;
  registry: (
    files: VerifiedBundle,
    signal: AbortSignal,
    queries: PluginQueryRegistry,
    primary?: boolean
  ) => ClientPluginRegistry;
}
interface Slot {
  admissionKey?: string;
  configurationKey?: string;
  controller: AbortController;
  digest: string;
  invalidations?: number;
  queries?: PluginQueryRegistry;
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
      install &&
      install.digest === previous.digest &&
      install.configurationKey === previous.configurationKey &&
      install.admissionKey === previous.admissionKey &&
      !previous.controller.signal.aborted
    ) {
      if (install.invalidations !== previous.invalidations) {
        previous.invalidations = install.invalidations;
        previous.queries?.invalidateAll();
      }
      return previous.ready;
    }

    const slot: Slot = {
      controller: new AbortController(),
      admissionKey: install?.admissionKey,
      configurationKey: install?.configurationKey,
      digest: install?.digest ?? '',
      invalidations: install?.invalidations,
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
      // Abort already fences the previous module: a late-resolving import rejects before it can
      // register. Awaiting its `ready` would let a stuck evaluation block every replacement.
      if (previous?.cleanup) await previous.cleanup();
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
                  workspace:
                    install.sourceKey === 'workspace'
                      ? {
                          manifest: install.workspaceManifest!,
                          local: !!install.localModule,
                          bytes: () => verifiedPackedBytes(files),
                        }
                      : undefined,
                  packed:
                    install.sourceKey === 'local' || install.localModule
                      ? undefined
                      : () => verifiedPackedBytes(files),
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
      const queries = new PluginQueryRegistry(signal);
      const registry = install.registry(files, signal, queries, install.primary);
      slot.queries = queries;
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
