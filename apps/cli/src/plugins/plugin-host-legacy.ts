import type { PluginMachineRequest } from '@lody/shared/plugins/machine-rpc';
import { ManagedRuntime, Effect, Layer } from 'effect';
import { platformLayer } from '@/platform/process-options';
import { pluginHostLayer } from './workflow/plugin-host';
import { DevPluginCompiler } from './workflow/dev-plugin-compiler';
import { Registry, registryLayer, type VerifiedPluginGrant } from './workflow/plugin-registry';
/** @deprecated Fleet and local control bridge until their entrypoints compose the native layer. */
export class PluginDaemon {
  private runtime;
  private ready?: Promise<void>;
  constructor(
    root: string,
    workspaceId: string,
    machineId: string,
    warn: (m: string) => void,
    vault?: import('./plugin-machine-config').MachineConfigVault
  ) {
    this.runtime = ManagedRuntime.make(
      registryLayer(root, workspaceId, machineId, warn, vault).pipe(
        Layer.provide(Layer.merge(pluginHostLayer, DevPluginCompiler.layer)),
        Layer.provide(platformLayer({}))
      )
    );
  }
  start() {
    return (this.ready ??= this.runtime.runPromise(Effect.flatMap(Registry, (r) => r.start)));
  }
  async dispatchMachineRpc(
    request: PluginMachineRequest,
    actor: VerifiedPluginGrant,
    signal?: AbortSignal
  ) {
    await this.ready;
    signal?.throwIfAborted();
    return this.runtime.runPromise(
      Effect.flatMap(Registry, (r) => r.machineRpc(request, actor)),
      { signal }
    );
  }
  async dispatch(raw: unknown) {
    await this.ready;
    return this.runtime.runPromise(Effect.flatMap(Registry, (r) => r.dispatch(raw)));
  }
  dispose() {
    return this.runtime.dispose();
  }
}
