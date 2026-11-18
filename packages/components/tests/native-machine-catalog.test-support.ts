import type { AgentConfigId, AgentConfigMeta, MachineId, WorkspaceId } from '@lody/shared';
import { projectNativeMachineCatalog } from '@lody/shared/node/native-machine-catalog-projection';
import {
  MachineCatalogIpcError,
  parseMachineCatalogIpcSnapshot,
  type MachineCatalogIpcSnapshot,
} from '@lody/shared/machine-catalog-ipc';
import {
  createNativeMachineCatalogIpc,
  type NativeMachineCatalogRequest,
  type NativeMachineCatalogTransport,
} from '../src/providers/native-machine-catalog-ipc';

export const machineA = 'synthetic-machine-a' as MachineId;
export const machineB = 'synthetic-machine-b' as MachineId;
export const configId = (id: MachineId) => `synthetic-agent-${id}` as AgentConfigId;
export const binding = {
  accountId: 'synthetic-account',
  workspaceId: 'synthetic-workspace' as WorkspaceId,
};
export const registrationId = '322d10b9-6714-44a3-8b67-11ea8f1b9473';
export const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
export const config = (machineId: MachineId): AgentConfigMeta => ({
  id: configId(machineId),
  machineId,
  cliType: 'builtin',
  agentType: 'claude',
  name: 'Synthetic agent',
  description: 'Synthetic provider',
  env: { API_KEY: 'SYNTHETIC_SAVED_SECRET' },
});
export const view = (
  machineId: MachineId,
  name = 'Synthetic agent',
  generation = 'generation-a'
): MachineCatalogIpcSnapshot =>
  parseMachineCatalogIpcSnapshot({
    machineId,
    generation,
    synced: true,
    projection: projectNativeMachineCatalog(
      [{ key: ['agentConfig', configId(machineId)], value: { ...config(machineId), name } }],
      machineId
    ),
  });
/** Synthetic main-domain endpoint for deterministic reply-loss and late-result
 * cases. Its leases and committed values are observable state, not call mocks. */
export function nativeMachineCatalogHarness(ids: readonly MachineId[] = [machineA]) {
  let receive: (raw: unknown) => void = () => {};
  const leases = new Map<string, { request: NativeMachineCatalogRequest; leaseId: string }>();
  const cancelled = new Set<string>();
  const values = new Map(ids.map((id) => [id, config(id)]));
  const snapshots = new Map(ids.map((id) => [id, view(id)]));
  const key = (request: NativeMachineCatalogRequest) => JSON.stringify(request);
  const emit = (
    request: NativeMachineCatalogRequest,
    snapshot = snapshots.get(request.machineId as MachineId)!
  ) => {
    const lease = leases.get(key(request));
    if (lease) receive({ ...request, leaseId: lease.leaseId, type: 'snapshot', snapshot });
  };
  const transport: NativeMachineCatalogTransport = {
    async readMachineCatalog(request) {
      return snapshots.get(request.machineId as MachineId);
    },
    async beginMachineAgentConfigEdit(request) {
      if (request.expectedGeneration !== snapshots.get(request.machineId as MachineId)!.generation)
        throw new MachineCatalogIpcError('restart_required');
      return {
        generation: request.expectedGeneration,
        editor: {
          ...config(request.machineId as MachineId),
          editToken: `server-token-${request.machineId}`,
          expiresAt: 2000,
          credentials: {
            envPresent: true,
            customLaunchPresent: false,
            runtimeOverridesPresent: false,
            profilePresent: false,
          },
          hasPrompt: false,
          credentialVerification: 'unknown',
        },
      };
    },
    async executeMachineCatalog(request) {
      if (request.expectedGeneration !== snapshots.get(request.machineId as MachineId)!.generation)
        throw new MachineCatalogIpcError('restart_required');
      const command = request.command;
      if (command.kind === 'edit-agent') {
        if (command.editToken !== `server-token-${request.machineId}`)
          throw new Error('Invalid server edit token');
        const current = values.get(request.machineId as MachineId)!;
        if (command.changes.name)
          values.set(request.machineId as MachineId, { ...current, name: command.changes.name });
        if (command.changes.env?.kind === 'replace')
          values.set(request.machineId as MachineId, {
            ...values.get(request.machineId as MachineId)!,
            env: command.changes.env.value,
          });
      }
      return { generation: request.expectedGeneration, changed: true };
    },
    async uploadMachineCatalog(request) {
      if (request.expectedGeneration !== snapshots.get(request.machineId as MachineId)!.generation)
        throw new MachineCatalogIpcError('restart_required');
      return { generation: request.expectedGeneration };
    },
    async observeMachineCatalog(request) {
      if (cancelled.has(key(request))) throw new Error('Already cancelled');
      const leaseId = crypto.randomUUID();
      leases.set(key(request), { request, leaseId });
      emit(request);
      return { leaseId };
    },
    async unobserveMachineCatalog(request) {
      const lease = leases.get(
        key({
          registrationId: request.registrationId,
          requestId: request.requestId,
          machineId: request.machineId,
        })
      );
      if (lease?.leaseId === request.leaseId) leases.delete(key(lease.request));
    },
    async cancelMachineCatalogObservation(request) {
      cancelled.add(key(request));
      leases.delete(key(request));
      return { canceled: true };
    },
  };
  const listen = (handler: (event: unknown) => void) => {
    receive = handler;
    return () => {
      receive = () => {};
    };
  };
  const source = () =>
    createNativeMachineCatalogIpc({
      binding,
      registrationId,
      machineIds: ids,
      transport,
      listen,
    });
  return {
    source,
    listen,
    transport,
    leases,
    cancelled,
    values,
    snapshots,
    emit,
    send: (raw: unknown) => receive(raw),
    key,
  };
}

/** Actual main-domain bridge over an independently hosted native engine. The
 * worker imports only the JS protocol client; the common host owns the addon. */
export async function openNativeMachineCatalogTestGroup(
  ids: readonly MachineId[] = [machineA, machineB]
) {
  const fs = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { openNativeRepoTestHost } = await import('./native-repo-host.test-support');
  const { NativeMachineCatalogMainLegacy } =
    await import('../../../apps/electron/src/main/services/native-machine-catalog');
  const { getMachineFlockDocId, machineFlockKeys } = await import('@lody/shared');
  const root = await fs.mkdtemp(join(tmpdir(), 'native-mf-renderer-'));
  const host = await openNativeRepoTestHost(join(root, 'engine'));
  try {
    const namespace = 'native-mf-renderer';
    const rooms = new Map(
      ids.map((id) => [
        id,
        { kind: 'flock' as const, id: getMachineFlockDocId(binding.workspaceId, id) },
      ])
    );
    const generations = new Map(ids.map((id) => [id, `generation-a:${id}`]));
    const admitted = new Map(ids.map((id) => [id, true]));
    const syncFlags = new Map(ids.map((id) => [id, true]));
    const authorityListeners = new Map(ids.map((id) => [id, new Set<() => void>()]));
    let receive: (event: unknown) => void = () => {};
    for (const id of ids) {
      const room = rooms.get(id)!;
      await host.client.createRoom(namespace, room, 'plaintext');
      await host.client.flockBatch(namespace, room, [
        { op: 'put', key: machineFlockKeys.agentConfig(configId(id)), value: config(id) as never },
        { op: 'put', key: machineFlockKeys.dotlodyPath(), value: '/synthetic/initial' },
        { op: 'put', key: ['future', 'opaque'], value: { retained: true } },
      ]);
    }
    const main = new NativeMachineCatalogMainLegacy({
      async acquire(_window, _registration, machineId) {
        const id = machineId as MachineId,
          generation = generations.get(id);
        if (!generation || !admitted.get(id)) throw new MachineCatalogIpcError('access_denied');
        return {
          generation,
          assertCurrent() {
            if (!admitted.get(id)) throw new MachineCatalogIpcError('access_denied');
            if (generations.get(id) !== generation)
              throw new MachineCatalogIpcError('restart_required');
          },
          options: {
            client: host.client,
            namespace,
            writer: `synthetic-mf-owner:${id}`,
            binding: { ...binding, machineId: id },
            authorize: () => admitted.get(id) === true,
            authority: {
              current: () =>
                admitted.get(id)
                  ? { epoch: generations.get(id)!, synced: syncFlags.get(id)! }
                  : undefined,
              subscribe(listener) {
                authorityListeners.get(id)!.add(listener);
                return () => {
                  authorityListeners.get(id)!.delete(listener);
                };
              },
            },
            upload: async () => {},
            verifyAgentChange: async () => true,
            machineMetadata: async () =>
              ({
                id,
                name: 'Synthetic local machine',
                protocolCapabilities: { magpieImport: 1, providerSetup: 1, builtinPi: 1 },
              }) as import('@lody/shared').MachineMeta,
          },
        };
      },
      send(_window, event) {
        receive(event);
      },
    });
    const windowId = 11;
    const transport: NativeMachineCatalogTransport = {
      readMachineCatalog: (req) => main.read(windowId, req.registrationId, req.machineId),
      beginMachineAgentConfigEdit: (req) =>
        main.beginAgentConfigEdit(
          windowId,
          req.registrationId,
          req.machineId,
          req.id,
          req.expectedGeneration
        ),
      executeMachineCatalog: (req) =>
        main.execute(
          windowId,
          req.registrationId,
          req.machineId,
          req.command,
          req.expectedGeneration
        ),
      uploadMachineCatalog: (req) =>
        main.upload(windowId, req.registrationId, req.machineId, req.expectedGeneration),
      observeMachineCatalog: (req) =>
        main.observe(windowId, req.registrationId, req.machineId, req.requestId),
      unobserveMachineCatalog: (req) =>
        main.unsubscribe(windowId, req.registrationId, req.machineId, req.requestId, req.leaseId),
      cancelMachineCatalogObservation: (req) =>
        main.cancelObservation(windowId, req.registrationId, req.machineId, req.requestId),
    };
    const listen = (handler: (event: unknown) => void) => {
      receive = handler;
      return () => {
        receive = () => {};
      };
    };
    const source = createNativeMachineCatalogIpc({
      binding,
      registrationId,
      machineIds: ids,
      transport,
      listen,
    });
    let closed = false,
      closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (closed) return Promise.resolve();
      if (closing) return closing;
      const attempt = (async () => {
        const failures: unknown[] = [];
        try {
          await source.close();
        } catch (error) {
          failures.push(error);
        }
        try {
          await main.close();
        } catch (error) {
          failures.push(error);
        }
        // This owner is terminal. Actual process exit supplies transport-loss
        // proof for any retained domain release before a retry confirms custody.
        await host.close();
        if (failures.length) {
          await source.retryCleanup();
          await main.close();
        }
        await fs.rm(root, { recursive: true, force: true });
        closed = true;
      })();
      closing = attempt;
      void attempt.catch(() => {
        if (closing === attempt) closing = undefined;
      });
      return attempt;
    };
    return {
      source,
      transport,
      main,
      client: host.client,
      pid: host.pid,
      namespace,
      rooms,
      generations,
      setSynced(id: MachineId, value: boolean) {
        syncFlags.set(id, value);
        for (const listener of [...authorityListeners.get(id)!]) listener();
      },
      revoke(id: MachineId) {
        admitted.set(id, false);
        for (const listener of [...authorityListeners.get(id)!]) listener();
      },
      async rawConfig(id: MachineId) {
        return (
          await host.client.flockGet(
            namespace,
            rooms.get(id)!,
            machineFlockKeys.agentConfig(configId(id))
          )
        ).value as unknown as AgentConfigMeta;
      },
      close,
    };
  } catch (cause) {
    try {
      await host.close();
      await fs.rm(root, { recursive: true, force: true });
    } catch (cleanup) {
      throw new AggregateError(
        [cause, cleanup],
        `Native MF fixture startup cleanup unconfirmed; retained at ${root}`
      );
    }
    throw cause;
  }
}
