import { ManagedRuntime, Effect, Layer } from 'effect';
import { platformLayer } from '@/platform/process-options';
import { pluginHostLayer } from './workflow/plugin-host';
import { DevPluginCompiler } from './workflow/dev-plugin-compiler';
import { Registry, registryLayer } from './workflow/plugin-registry';
/** @deprecated Fleet and local control bridge until their entrypoints compose the native layer. */
export class PluginDaemon {
  private runtime;
  private ready?: Promise<void>;
  constructor(root: string, workspaceId: string, machineId: string, warn: (m: string) => void) {
    this.runtime = ManagedRuntime.make(
      registryLayer(root, workspaceId, machineId, warn).pipe(
        Layer.provide(Layer.merge(pluginHostLayer, DevPluginCompiler.layer)),
        Layer.provide(platformLayer({}))
      )
    );
  }
  start() {
    return (this.ready ??= this.runtime.runPromise(Effect.flatMap(Registry, (r) => r.start)));
  }
  async dispatch(raw: unknown) {
    await this.ready;
    return this.runtime.runPromise(Effect.flatMap(Registry, (r) => r.dispatch(raw)));
  }
  dispose() {
    return this.runtime.dispose();
  }
}
