import { Effect, Layer, ManagedRuntime } from 'effect';
import { platformLayer } from '@/platform/process-options';
import type { DispatchMachineHostCall } from './machine-host-port';
import type { MachineConfigVault } from './plugin-machine-config';
import { PluginStateStore } from './plugin-state-store';
import type { projectConfigStore } from './project-config-store';
import { DevPluginCompiler } from './workflow/dev-plugin-compiler';
import { makePluginHostLayer } from './workflow/plugin-host';
import { registryLayer } from './workflow/plugin-registry';

export { Registry } from './workflow/plugin-registry';
export type PluginRuntime = ReturnType<typeof makePluginRuntime>;

export function makePluginRuntime(
  root: string,
  workspaceId: string,
  machineId: string,
  warn: (message: string) => void,
  vault?: MachineConfigVault,
  dispatch?: DispatchMachineHostCall,
  worker?: string,
  readmit?: Parameters<typeof makePluginHostLayer>[3],
  projectStore?: ReturnType<typeof projectConfigStore>
) {
  return ManagedRuntime.make(
    Layer.unwrap(
      Effect.gen(function* () {
        const state = yield* Effect.acquireRelease(
          Effect.sync(() => new PluginStateStore(root)),
          (s) => Effect.sync(() => s.close())
        );
        const host = makePluginHostLayer(
          worker,
          async (call, signal) => {
            signal.throwIfAborted();
            if (call.op.startsWith('storage.'))
              return state.storage(call.pluginId, call.op, call.payload.target, call.payload.input);
            if (!dispatch) throw Error('Host operation unavailable');
            return dispatch(call, signal);
          },
          state,
          readmit
        );
        return registryLayer(root, workspaceId, machineId, warn, vault, state, projectStore).pipe(
          Layer.provideMerge(host),
          Layer.provide(DevPluginCompiler.layer),
          Layer.provideMerge(platformLayer({}))
        );
      })
    )
  );
}
