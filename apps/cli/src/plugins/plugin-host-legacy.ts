import type { PluginMachineRequest } from '@lody/shared/plugins/machine-rpc';
import { ManagedRuntime, Effect, Layer, Scope, Exit } from 'effect';
import { platformLayer } from '@/platform/process-options';
import type { DispatchMachineHostCall } from './machine-host-port';
import type { HostToChildFrame } from '@lody/shared/plugins/ipc-protocol';
import { PluginHost, makePluginHostLayer } from './workflow/plugin-host';
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
    vault?: import('./plugin-machine-config').MachineConfigVault,
    dispatch?: DispatchMachineHostCall,
    worker?: string
  ) {
    this.runtime = ManagedRuntime.make(
      registryLayer(root, workspaceId, machineId, warn, vault).pipe(
        Layer.provideMerge(
          Layer.merge(makePluginHostLayer(worker, dispatch), DevPluginCompiler.layer)
        ),
        Layer.provideMerge(platformLayer({}))
      )
    );
  }
  start() {
    return (this.ready ??= this.runtime.runPromise(Effect.flatMap(Registry, (r) => r.start)));
  }
  async spawnWorkflow(
    kind: 'acpProviders' | 'mcpServers',
    id: string,
    signal?: AbortSignal,
    admit?: () => void
  ) {
    const scope = Scope.makeUnsafe();
    const close = () => this.runtime.runPromise(Scope.close(scope, Exit.void));
    try {
      const {
        processHandle: { child },
        socketPath,
      } = await this.runtime.runPromise(
        Effect.flatMap(Registry, (r) => Scope.provide(r.workflow.start(kind, id, admit), scope)),
        { signal }
      );
      const onTermination = (
        event: 'exit' | 'close',
        fn: Parameters<import('../session/session-sandbox').SessionProcessHandle['onExit']>[0]
      ) => {
        child.on(event, fn);
        return () => {
          child.off(event, fn);
        };
      };
      const output = (s: typeof child.stdout, fn: (chunk: Buffer) => void) => {
        s?.on('data', fn);
        return () => {
          s?.off('data', fn);
        };
      };
      child.once('close', () => void close().catch(() => {}));
      return {
        child,
        socketPath,
        terminate: close,
        inspectExit: async () => null,
        onExit: (
          fn: Parameters<import('../session/session-sandbox').SessionProcessHandle['onExit']>[0]
        ) => onTermination('exit', fn),
        onClose: (
          fn: Parameters<import('../session/session-sandbox').SessionProcessHandle['onClose']>[0]
        ) => onTermination('close', fn),
        onError: (fn: (e: Error) => void) => {
          child.on('error', fn);
          return () => {
            child.off('error', fn);
          };
        },
        onStdout: (fn: (b: Buffer) => void) => output(child.stdout, fn),
        onStderr: (fn: (b: Buffer) => void) => output(child.stderr, fn),
      };
    } catch (e) {
      await close();
      throw e;
    }
  }
  async workflowCatalog() {
    return this.runtime.runPromise(Effect.map(Registry, (r) => r.workflow.catalog()));
  }
  activeWorkflowLease(id: string) {
    return this.runtime.runPromise(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        const instance = host.inspect(id).instanceId;
        return instance ? (yield* Registry).workflowLease(id, instance) : undefined;
      })
    );
  }
  workflowLease(pluginId: string, instanceId: number) {
    return this.runtime.runPromise(
      Effect.map(Registry, (r) => r.workflowLease(pluginId, instanceId))
    );
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
  async activateProposal(
    meta: import('@lody/shared/plugins/proposal').PluginProposalMeta,
    path: string,
    signal?: AbortSignal
  ) {
    await this.ready;
    signal?.throwIfAborted();
    return this.runtime.runPromise(
      Effect.flatMap(Registry, (r) => r.activateProposal(meta, path)),
      { signal }
    );
  }
  event(frame: Extract<HostToChildFrame, { type: 'event' }>, admit?: () => Promise<boolean>) {
    return this.runtime.runPromise(Effect.flatMap(PluginHost, (h) => h.broadcast(frame, admit)));
  }
  async dispatch(raw: unknown) {
    await this.ready;
    return this.runtime.runPromise(Effect.flatMap(Registry, (r) => r.dispatch(raw)));
  }
  dispose() {
    return this.runtime.dispose();
  }
}
