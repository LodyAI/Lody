import {
  createNativeMachineCatalogOwner as owner,
  type NativeMachineCatalogOptions,
} from '@lody/shared/node/native-machine-catalog';
import {
  createNativeMachineCatalogObservations,
  NativeMachineCatalogCleanupError,
} from '@lody/shared/node/native-machine-catalog-observations';
export {
  createNativeMachineCatalog,
  makeNativeMachineCatalog,
  type NativeMachineCatalogOptions,
  type NativeMachineCatalogAuthority,
} from '@lody/shared/node/native-machine-catalog';
import { Effect } from 'effect';
import type { ProviderSetupStoragePort } from '../provider-setup-manager';
import type { MachineDocumentRuntimePort } from '../machine-document-runtime-port';
import { readMachineSessionLaunchSnapshotFromFlock } from '../../session/session-launch-config-resolver';
import { prepareMachineLocalProjectUpsert } from '../local-project-meta';
import { importMagpieProviders, resolveMagpieImport } from '../../commands/magpie-import';
import {
  publishMachineAcpCapabilities,
  publishMachineRateLimits,
  isValidDaemonLaunchConfig,
} from '../machine-acp-capability-plan';
import { assertLosslessNativeFlockValue } from './native-flock-value';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  MachineCatalogError,
  readMachineFlockRowsFromFlock,
  getMachineFlockAgentConfigs,
  getMachineFlockSessionLaunchConfig,
  getMachineFlockProviderSetupCancellations,
  getMachineFlockProviderSetups,
  getMachineFlockDotlodyPath,
  getMachineFlockLocalProjects,
  getMachineFlockMemories,
  getMachineFlockAcpCapabilities,
  getAcpCapabilityCacheKey,
  isBuiltinAgentType,
  getMachineFlockRateLimits,
  getMachineFlockBuiltinAgentOptOuts,
  machineFlockKeys,
  parseMachineFlockRow,
  writeAgentConfigToFlock,
  deleteAgentConfigFromFlock,
  writeMachineFlockRowToFlock,
  deleteMachineFlockRowFromFlock,
  applyProviderSetupCancellationToFlock,
  writeAcpModelConfigOptionsToFlock,
  type MachineCatalogBinding,
  type MachineFlockScanRow,
  type MachineFlockWritableFlock,
  type MachineFlockKey,
  type MachineFlockRow,
  type MachineDeleteLocalProjectCommand,
  type AgentConfigMeta,
  type AgentConfigId,
  type SessionId,
  type AcpCapabilityCacheEntry,
  type AcpModelCapabilities,
  type AcpConfigOptionSummary,
  type ProviderSetupTask,
} from '@lody/shared';
import { agentSummary } from './native-machine-catalog-projection';

const keyOf = (key: readonly unknown[]) => JSON.stringify(key);

/** Private execution capability. It must never be placed on the renderer IPC table. */
export function createNativeMachineLaunchData(options: NativeMachineCatalogOptions) {
  const owned = owner(options);
  return {
    async readAgentConfigs(binding: MachineCatalogBinding) {
      owned.check(binding, 'launch');
      const snapshot = await owned.scan('launch');
      const rows = readMachineFlockRowsFromFlock({ scan: () => snapshot.entries });
      const cancelled = getMachineFlockProviderSetupCancellations(rows);
      return Object.fromEntries(
        Object.entries(getMachineFlockAgentConfigs(rows)).filter(
          ([id, config]) =>
            config.machineId === owned.expected.machineId && !cancelled[id as AgentConfigId]
        )
      );
    },
    async readAgentConfig(
      binding: MachineCatalogBinding,
      id: AgentConfigId,
      sessionId?: SessionId
    ) {
      owned.check(binding, 'launch');
      const snapshot = await owned.scan('launch');
      const rows = readMachineFlockRowsFromFlock({ scan: () => snapshot.entries });
      const config = getMachineFlockAgentConfigs(rows)[id];
      if (
        config?.machineId !== owned.expected.machineId ||
        getMachineFlockProviderSetupCancellations(rows)[id]
      )
        return undefined;
      return {
        config,
        ...(sessionId ? { legacyLaunch: getMachineFlockSessionLaunchConfig(rows, sessionId) } : {}),
      };
    },
  };
}

export type NativeMachineRuntimeCommand =
  | { readonly kind: 'publish-dotlody-path'; readonly path: string }
  | { readonly kind: 'remove-legacy-launch'; readonly sessionId: SessionId }
  | {
      readonly kind: 'unlink-local-project';
      readonly project: import('@lody/shared').LocalProjectMeta;
    }
  | {
      readonly kind: 'upsert-local-project';
      readonly project: import('@lody/shared').LocalProjectMeta;
      readonly expected?: import('@lody/shared').LocalProjectMeta;
      readonly observedGitHubRepo: string | null;
      readonly standaloneVisible: boolean;
    }
  | { readonly kind: 'publish-agent'; readonly config: AgentConfigMeta }
  | {
      readonly kind: 'publish-capabilities';
      readonly id: AgentConfigId;
      readonly entry: AcpCapabilityCacheEntry;
    }
  | {
      readonly kind: 'publish-model-capabilities';
      readonly id: AgentConfigId;
      readonly entry: AcpModelCapabilities;
    }
  | {
      readonly kind: 'publish-model-options';
      readonly id: AgentConfigId;
      readonly sourceVersion: string;
      readonly answers: Record<string, readonly AcpConfigOptionSummary[]>;
    }
  | {
      readonly kind: 'publish-rate-limit';
      readonly id: AgentConfigId;
      readonly cliType: string;
      readonly limitId: string;
      readonly entry: Record<string, unknown>;
    }
  | { readonly kind: 'finish-provider-setup'; readonly receipt: string }
  | {
      readonly kind: 'complete-local-project-deletion';
      readonly receipt: string;
      readonly result: NonNullable<MachineDeleteLocalProjectCommand['cleanupResult']>;
    }
  | {
      readonly kind: 'remove-local-project-metadata';
      readonly projectId: import('@lody/shared').LocalProjectId;
      readonly expectedRootPath: string;
      readonly expectedProject?: import('@lody/shared').LocalProjectMeta;
    }
  | { readonly kind: 'complete-command'; readonly receipt: string }
  | {
      readonly kind: 'update-provider-setup';
      readonly receipt: string;
      readonly status: ProviderSetupTask['status'];
      readonly attempt: number;
      readonly updatedAt: number;
      readonly failureCode?: ProviderSetupTask['failureCode'];
    };
export type NativeMachineCommandWork = {
  readonly receipt: string;
  readonly signal: AbortSignal;
  readonly command:
    | Extract<MachineFlockRow, { key: ['cmd', ...unknown[]] }>
    | Extract<MachineFlockRow, { key: ['providerSetup', AgentConfigId] }>
    | Extract<MachineFlockRow, { key: ['providerSetupCancellation', AgentConfigId] }>;
};

/** Trusted Node consumer only. Durable work is rebuilt from a fresh full-room
 * scan on every authoritative rejoin; events merely wake it. Revocation aborts
 * the prior generation synchronously, before another scan or execution starts. */
const projectMachineRuntimeRows = (
  entries: readonly MachineFlockScanRow[],
  machineId: import('@lody/shared').MachineId
) => {
  const rows = readMachineFlockRowsFromFlock({ scan: () => entries });
  return {
    dotlodyPath: getMachineFlockDotlodyPath(rows),
    projects: getMachineFlockLocalProjects(rows),
    memories: getMachineFlockMemories(rows, machineId),
    capabilities: getMachineFlockAcpCapabilities(rows),
    rateLimits: getMachineFlockRateLimits(rows),
    builtinOptOuts: getMachineFlockBuiltinAgentOptOuts(rows),
    providerCancellations: getMachineFlockProviderSetupCancellations(rows),
    modelCapabilities: Object.values(rows).flatMap((row) =>
      row.key[0] === 'acpModelCapability'
        ? [{ configId: row.key[1], entry: row.value as AcpModelCapabilities }]
        : []
    ),
  };
};

export function createNativeMachineRuntimeCatalog(options: NativeMachineCatalogOptions) {
  let closed = false;
  const owned = owner({
    ...options,
    authorize: (operation, command) => !closed && options.authorize(operation, command),
  });
  const receipts = new Map<
    string,
    { key: MachineFlockKey; value: unknown; epoch: string; cancellation: AbortController }
  >();
  const watchers = new Set<() => void>();
  const observations = createNativeMachineCatalogObservations(
    options.client,
    options.cleanupTimeoutMs
  );
  return {
    /** Complete typed catalog inputs for trusted execution/provider consumers.
     * This is separate from the outward summary and is never an IPC read method. */
    async readCatalog(binding: MachineCatalogBinding) {
      owned.check(binding, 'runtime');
      if (
        options.authority.current()?.synced !== true ||
        options.client.connectionState !== 'connected'
      )
        throw new MachineCatalogError('access_denied');
      const snapshot = await owned.scan('runtime');
      return projectMachineRuntimeRows(snapshot.entries, owned.expected.machineId);
    },
    async execute(binding: MachineCatalogBinding, command: NativeMachineRuntimeCommand) {
      owned.check(binding, 'runtime');
      if (
        options.authority.current()?.synced !== true ||
        options.client.connectionState !== 'connected'
      )
        throw new MachineCatalogError('access_denied');
      return (
        await owned.transact('runtime', (entries, flock) => {
          if (
            options.authority.current()?.synced !== true ||
            options.client.connectionState !== 'connected'
          )
            throw new MachineCatalogError('access_denied');
          const put = (key: MachineFlockKey, value: unknown) => {
            if (!parseMachineFlockRow(key, value)) throw new MachineCatalogError('invalid_edit');
            writeMachineFlockRowToFlock(flock, { key, value } as MachineFlockRow);
          };
          if (
            'id' in command &&
            entries.some(
              (entry) =>
                keyOf(entry.key) === keyOf(machineFlockKeys.providerSetupCancellation(command.id))
            )
          )
            throw new MachineCatalogError('edit_conflict');
          if (command.kind === 'publish-dotlody-path')
            put(machineFlockKeys.dotlodyPath(), command.path);
          else if (command.kind === 'remove-legacy-launch')
            flock.delete(machineFlockKeys.sessionLaunchConfig(command.sessionId));
          else if (command.kind === 'unlink-local-project') {
            const rows = readMachineFlockRowsFromFlock({ scan: () => entries });
            const current = getMachineFlockLocalProjects(rows)[command.project.id];
            if (!current || !isDeepStrictEqual(current, command.project))
              throw new MachineCatalogError('edit_conflict');
            put(machineFlockKeys.localProject(current.id), {
              ...current,
              standaloneVisible: false,
            });
          } else if (command.kind === 'upsert-local-project') {
            const current = getMachineFlockLocalProjects(
              readMachineFlockRowsFromFlock({ scan: () => entries })
            )[command.project.id];
            if (!isDeepStrictEqual(current, command.expected))
              throw new MachineCatalogError('edit_conflict');
            put(
              machineFlockKeys.localProject(command.project.id),
              prepareMachineLocalProjectUpsert(
                command.project,
                current,
                command.observedGitHubRepo,
                command.standaloneVisible
              )
            );
          } else if (command.kind === 'publish-agent') {
            if (command.config.machineId !== owned.expected.machineId)
              throw new MachineCatalogError('invalid_edit');
            if (
              !parseMachineFlockRow(machineFlockKeys.agentConfig(command.config.id), command.config)
            )
              throw new MachineCatalogError('invalid_edit');
            if (
              entries.some(
                (entry) =>
                  keyOf(entry.key) ===
                  keyOf(machineFlockKeys.providerSetupCancellation(command.config.id))
              )
            )
              throw new MachineCatalogError('edit_conflict');
            writeAgentConfigToFlock(flock, command.config);
            put(machineFlockKeys.agentConfigIndex(command.config.id), agentSummary(command.config));
          } else if (command.kind === 'publish-capabilities')
            put(machineFlockKeys.acpCapability(command.id), command.entry);
          else if (command.kind === 'publish-model-capabilities')
            put(machineFlockKeys.acpModelCapability(command.id), command.entry);
          else if (command.kind === 'publish-model-options')
            writeAcpModelConfigOptionsToFlock(
              flock,
              command.id,
              command.sourceVersion,
              command.answers
            );
          else if (command.kind === 'publish-rate-limit')
            put(
              machineFlockKeys.rateLimit(command.id, command.cliType, command.limitId),
              command.entry
            );
          else if (command.kind === 'remove-local-project-metadata') {
            const key = machineFlockKeys.localProject(command.projectId);
            const current = entries.find((entry) => keyOf(entry.key) === keyOf(key));
            if (current) {
              if (
                command.expectedProject &&
                !isDeepStrictEqual(
                  getMachineFlockLocalProjects(
                    readMachineFlockRowsFromFlock({ scan: () => entries })
                  )[command.projectId],
                  command.expectedProject
                )
              )
                throw new MachineCatalogError('edit_conflict');
              if (
                (parseMachineFlockRow(key, current.value)?.value as { rootPath?: unknown })
                  ?.rootPath !== command.expectedRootPath
              )
                throw new MachineCatalogError('edit_conflict');
              flock.delete(key);
            }
          } else {
            const receipt = receipts.get(command.receipt);
            if (
              !receipt ||
              receipt.cancellation.signal.aborted ||
              receipt.epoch !== owned.currentEpoch() ||
              options.authority.current()?.synced !== true
            )
              throw new MachineCatalogError('edit_expired');
            const current = entries.find((entry) => keyOf(entry.key) === keyOf(receipt.key));
            if (!current || !isDeepStrictEqual(current.value, receipt.value))
              throw new MachineCatalogError('edit_conflict');
            try {
              assertLosslessNativeFlockValue(current.value, options);
            } catch {
              throw new MachineCatalogError('invalid_edit');
            }
            if (command.kind === 'finish-provider-setup') {
              if (receipt.key[0] !== 'providerSetup') throw new MachineCatalogError('invalid_edit');
              const setupId = receipt.key[1];
              if (
                entries.some(
                  (entry) =>
                    keyOf(entry.key) === keyOf(machineFlockKeys.providerSetupCancellation(setupId))
                )
              )
                throw new MachineCatalogError('edit_conflict');
              const task = parseMachineFlockRow(receipt.key, current.value)
                ?.value as ProviderSetupTask;
              if (task.status !== 'verifying') throw new MachineCatalogError('edit_conflict');
              if (
                !entries.some(
                  (entry) => keyOf(entry.key) === keyOf(machineFlockKeys.agentConfig(task.id))
                )
              ) {
                writeAgentConfigToFlock(flock, task.config);
                put(machineFlockKeys.agentConfigIndex(task.id), agentSummary(task.config));
              }
              flock.delete(receipt.key);
            } else if (command.kind === 'complete-local-project-deletion') {
              if (
                receipt.key[0] !== 'cmd' ||
                receipt.key[1] !== 'deleteLocalProject' ||
                !(current.value as MachineDeleteLocalProjectCommand).cleanupWorktrees
              )
                throw new MachineCatalogError('invalid_edit');
              put(receipt.key, {
                ...(current.value as MachineDeleteLocalProjectCommand),
                status: 'completed',
                cleanupResult: command.result,
              });
            } else if (command.kind === 'complete-command') {
              const deletion = current.value as MachineDeleteLocalProjectCommand;
              const project =
                receipt.key[0] === 'cmd' && receipt.key[1] === 'deleteLocalProject'
                  ? getMachineFlockLocalProjects(
                      readMachineFlockRowsFromFlock({ scan: () => entries })
                    )[receipt.key[2]]
                  : undefined;
              const deletionNoop =
                (project &&
                  (project.standaloneVisible === false ||
                    project.createdAtMs > deletion.requestedAt)) ||
                (!project && !deletion.originalRootPath);
              if (
                receipt.key[0] !== 'cmd' ||
                (receipt.key[1] === 'deleteLocalProject' &&
                  deletion.cleanupWorktrees &&
                  !deletionNoop)
              )
                throw new MachineCatalogError('invalid_edit');
              flock.delete(receipt.key);
            } else {
              if (receipt.key[0] !== 'providerSetup') throw new MachineCatalogError('invalid_edit');
              const setupId = receipt.key[1];
              if (
                entries.some(
                  (entry) =>
                    keyOf(entry.key) === keyOf(machineFlockKeys.providerSetupCancellation(setupId))
                )
              )
                throw new MachineCatalogError('edit_conflict');
              put(receipt.key, {
                ...(current.value as ProviderSetupTask),
                status: command.status,
                attempt: command.attempt,
                updatedAt: command.updatedAt,
                failureCode: command.failureCode,
              });
            }
          }
        })
      ).changed;
    },
    async observeCommands(
      binding: MachineCatalogBinding,
      listener: (
        work: readonly NativeMachineCommandWork[],
        context: { readonly epoch: string; readonly signal: AbortSignal }
      ) => void,
      onError: (error: unknown) => void
    ) {
      owned.check(binding, 'runtime');
      let stopped = false,
        queued = false,
        scanning = false;
      let active: { epoch: string; abort: AbortController } | undefined;
      const localReceipts = new Set<string>();
      const clear = () => {
        for (const token of localReceipts) {
          receipts.get(token)?.cancellation.abort();
          receipts.delete(token);
        }
        localReceipts.clear();
      };
      const fail = (error: unknown) => {
        if (!stopped) {
          try {
            onError(error);
          } catch {}
        }
      };
      const revoke = () => {
        active?.abort.abort();
        active = undefined;
        clear();
      };
      const authority = () => {
        const current = options.authority.current();
        return options.client.connectionState === 'connected' &&
          options.authorize('runtime') &&
          current?.synced === true
          ? current
          : undefined;
      };
      const pump = async () => {
        if (scanning || stopped) return;
        scanning = true;
        try {
          while (queued && !stopped) {
            queued = false;
            const current = authority();
            if (!current) {
              revoke();
              continue;
            }
            if (!active || active.epoch !== current.epoch) {
              revoke();
              active = { epoch: current.epoch, abort: new AbortController() };
            }
            const generation = active;
            try {
              const snapshot = await owned.scan('runtime');
              if (
                stopped ||
                active !== generation ||
                authority()?.epoch !== generation.epoch ||
                generation.abort.signal.aborted
              )
                continue;
              const rows = readMachineFlockRowsFromFlock({ scan: () => snapshot.entries });
              const seen = new Set<string>();
              const byKey = new Map(
                [...localReceipts].flatMap((token) => {
                  const receipt = receipts.get(token);
                  return receipt ? [[keyOf(receipt.key), token] as const] : [];
                })
              );
              const rawByKey = new Map(snapshot.entries.map((entry) => [keyOf(entry.key), entry]));
              const work: NativeMachineCommandWork[] = [];
              for (const row of Object.values(rows)) {
                if (
                  row.key[0] !== 'cmd' &&
                  row.key[0] !== 'providerSetup' &&
                  row.key[0] !== 'providerSetupCancellation'
                )
                  continue;
                if (
                  (row.key[0] === 'providerSetup' || row.key[0] === 'providerSetupCancellation') &&
                  (row.value as ProviderSetupTask).machineId !== owned.expected.machineId
                )
                  continue;
                if (
                  row.key[0] === 'cmd' &&
                  row.key[1] === 'deleteLocalProject' &&
                  (row.value as MachineDeleteLocalProjectCommand).status === 'completed'
                )
                  continue;
                const raw = rawByKey.get(keyOf(row.key));
                try {
                  assertLosslessNativeFlockValue(raw?.value, options);
                } catch {
                  fail(new MachineCatalogError('invalid_edit'));
                  continue;
                }
                const value = raw?.value,
                  old = byKey.get(keyOf(row.key));
                const receipt =
                  old && isDeepStrictEqual(receipts.get(old)?.value, value) ? old : randomUUID();
                receipts.set(receipt, {
                  key: row.key,
                  value: structuredClone(value),
                  epoch: generation.epoch,
                  cancellation: receipts.get(receipt)?.cancellation ?? new AbortController(),
                });
                localReceipts.add(receipt);
                seen.add(receipt);
                work.push({
                  receipt,
                  signal: receipts.get(receipt)!.cancellation.signal,
                  command: row as NativeMachineCommandWork['command'],
                });
              }
              for (const token of localReceipts)
                if (!seen.has(token)) {
                  receipts.get(token)?.cancellation.abort();
                  receipts.delete(token);
                  localReceipts.delete(token);
                }
              listener(work, { epoch: generation.epoch, signal: generation.abort.signal });
            } catch (error) {
              if (!stopped && active === generation && !generation.abort.signal.aborted)
                fail(error);
            }
          }
        } finally {
          scanning = false;
        }
      };
      const wake = () => {
        if (stopped) return;
        const current = authority();
        if (!current || (active && active.epoch !== current.epoch)) revoke();
        queued = true;
        void pump();
      };
      const unlistenConnection = options.client.onConnectionStateChange(wake);
      const unlistenAuthority = options.authority.subscribe(wake);
      const detachments = new Set([unlistenConnection, unlistenAuthority]);
      const fence = () => {
        stopped = true;
        revoke();
        const failures: unknown[] = [];
        for (const detach of detachments) {
          try {
            detach();
            detachments.delete(detach);
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length)
          throw new AggregateError(failures, 'Machine runtime listener cleanup failed');
        watchers.delete(fence);
      };
      watchers.add(fence);
      const acquired = await observations.acquire(
        () => options.client.flockSubscribe(options.namespace, owned.room, {}, wake),
        fence
      );
      try {
        owned.check(binding, 'runtime');
        // Initial snapshot has no listener callback in 0.1.0, so explicitly rescan.
        wake();
        return {
          close: () => acquired.observation.retire(),
          cleanup: () => acquired.observation.close(),
          retryCleanup: () => acquired.observation.retryCleanup(),
        };
      } catch (error) {
        try {
          await acquired.observation.close();
        } catch (cleanup) {
          throw new NativeMachineCatalogCleanupError([error, cleanup], () =>
            acquired.observation.close()
          );
        }
        throw error;
      }
    },
    close() {
      closed = true;
      const failures: unknown[] = [];
      for (const stop of [...watchers]) {
        try {
          stop();
        } catch (error) {
          failures.push(error);
        }
      }
      observations.retire();
      receipts.clear();
      if (failures.length)
        throw new AggregateError(failures, 'Machine runtime observation release failed');
    },
    async cleanup(): Promise<void> {
      const failures: unknown[] = [];
      try {
        this.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await observations.close();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length)
        throw new NativeMachineCatalogCleanupError(failures, () => this.cleanup());
    },
    retryCleanup(): Promise<void> {
      return this.cleanup();
    },
  };
}

/** Adapt the actual legacy CLI readers without returning a replica or permitting old Meta fallback. */
export function createNativeMachineAgentConfigReadPort(
  options: NativeMachineCatalogOptions
): import('../agent-config-machine-flock').MachineAgentConfigReadPort {
  const data = createNativeMachineLaunchData(options);
  return {
    binding: { workspaceId: options.binding.workspaceId, machineId: options.binding.machineId },
    readAgentConfigs: () => data.readAgentConfigs(options.binding),
    readAgentConfig: async (id) => (await data.readAgentConfig(options.binding, id))?.config,
  };
}

/** The scoped execution observer never owns the borrowed RepoClient lifetime. */
export const makeNativeMachineRuntimeCatalog = Effect.fnUntraced(function* (
  options: NativeMachineCatalogOptions
) {
  return yield* Effect.acquireRelease(
    Effect.sync(() => createNativeMachineRuntimeCatalog(options)),
    (value) => Effect.promise(() => value.cleanup())
  );
});

/** ProviderSetupManager's private storage capability. One whole-mf owner and
 * one room CAS include task guards, cancellation, config and index publication. */
export function createNativeProviderSetupStorage(
  options: NativeMachineCatalogOptions
): ProviderSetupStoragePort & {
  close(): void;
  cleanup(): Promise<void>;
  retryCleanup(): Promise<void>;
} {
  let closed = false;
  const observer = createNativeMachineRuntimeCatalog(options);
  const owned = owner({
    ...options,
    authorize: (operation, command) => !closed && options.authorize(operation, command),
  });
  let generation: { epoch: string; controller: AbortController } | undefined;
  const refresh = () => {
    const authority = options.authority.current();
    const epoch =
      !closed &&
      options.client.connectionState === 'connected' &&
      options.authorize('runtime') &&
      authority?.synced
        ? authority.epoch
        : undefined;
    if (generation?.epoch !== epoch || epoch === undefined) {
      generation?.controller.abort();
      generation = epoch === undefined ? undefined : { epoch, controller: new AbortController() };
    }
  };
  const unlisten = options.authority.subscribe(refresh);
  const unconnection = options.client.onConnectionStateChange(refresh);
  const localDetachments = new Set([unlisten, unconnection]);
  const signal = () => {
    refresh();
    return generation?.controller.signal ?? AbortSignal.abort();
  };
  const state = (entries: readonly MachineFlockScanRow[]) => {
    const rows = readMachineFlockRowsFromFlock({ scan: () => entries });
    const cancellations = getMachineFlockProviderSetupCancellations(rows);
    return {
      configs: getMachineFlockAgentConfigs(rows),
      setups: Object.fromEntries(
        Object.entries(getMachineFlockProviderSetups(rows)).filter(
          ([id, task]) =>
            task.machineId === options.binding.machineId && !cancellations[id as AgentConfigId]
        )
      ),
    };
  };
  const change = async (
    expected: ProviderSetupTask,
    prepare: (flock: MachineFlockWritableFlock, entries: readonly MachineFlockScanRow[]) => void
  ) => {
    const active = signal();
    if (active.aborted) return false;
    return (
      await owned.transact(
        'runtime',
        (entries, flock) => {
          const current = state(entries).setups[expected.id];
          if (!current || !isDeepStrictEqual(current, expected)) return false;
          prepare(flock, entries);
          return true;
        },
        undefined,
        active
      )
    ).result;
  };
  return {
    signal,
    observe(listener, onError) {
      return observer.observeCommands(options.binding, () => listener(), onError);
    },
    async read() {
      const active = signal();
      if (active.aborted) throw new MachineCatalogError('access_denied');
      const snapshot = await owned.scan('runtime');
      if (active.aborted) throw new MachineCatalogError('access_denied');
      return state(snapshot.entries);
    },
    async reconcileCancellations() {
      const active = signal();
      if (active.aborted) return;
      await owned.transact(
        'runtime',
        (entries, flock) => {
          const rows = readMachineFlockRowsFromFlock({ scan: () => entries });
          for (const cancellation of Object.values(
            getMachineFlockProviderSetupCancellations(rows)
          )) {
            if (cancellation.machineId === options.binding.machineId)
              applyProviderSetupCancellationToFlock(
                flock,
                cancellation,
                Math.max((options.now ?? Date.now)(), cancellation.cancelledAt)
              );
          }
        },
        undefined,
        active
      );
    },
    replace(expected, next) {
      if (
        next.id !== expected.id ||
        next.machineId !== expected.machineId ||
        !isDeepStrictEqual(next.config, expected.config)
      )
        return Promise.resolve(false);
      return change(expected, (flock) => {
        writeMachineFlockRowToFlock(
          flock,
          { key: machineFlockKeys.providerSetup(expected.id), value: next },
          next.updatedAt
        );
      });
    },
    async remove(expected) {
      await change(expected, (flock) => {
        deleteMachineFlockRowFromFlock(flock, machineFlockKeys.providerSetup(expected.id));
      });
    },
    async publish(expected) {
      if (expected.status !== 'verifying') return;
      await change(expected, (flock, entries) => {
        if (!state(entries).configs[expected.id]) {
          writeAgentConfigToFlock(flock, expected.config);
          writeMachineFlockRowToFlock(flock, {
            key: machineFlockKeys.agentConfigIndex(expected.id),
            value: agentSummary(expected.config),
          });
        }
        deleteMachineFlockRowFromFlock(flock, machineFlockKeys.providerSetup(expected.id));
      });
    },
    close() {
      closed = true;
      generation?.controller.abort();
      generation = undefined;
      const failures: unknown[] = [];
      for (const detach of localDetachments) {
        try {
          detach();
          localDetachments.delete(detach);
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        observer.close();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length)
        throw new AggregateError(failures, 'Machine provider local retirement failed');
    },
    async cleanup(): Promise<void> {
      const failures: unknown[] = [];
      try {
        this.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await observer.cleanup();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length)
        throw new NativeMachineCatalogCleanupError(failures, () => this.cleanup());
    },
    retryCleanup(): Promise<void> {
      return this.cleanup();
    },
  };
}

/** Real runtime producer port. The shared publication planner runs inside the
 * native room CAS, beside the latest auth methods and per-model answers. */
export function createNativeMachineExecutionPort(
  options: NativeMachineCatalogOptions
): MachineDocumentRuntimePort {
  let closed = false;
  const publications = new Set<AbortController>();
  const owned = owner({
    ...options,
    authorize: (operation, command) => !closed && options.authorize(operation, command),
  });
  const assertMachine = (machineId: import('@lody/shared').MachineId) => {
    if (closed || machineId !== options.binding.machineId)
      throw new MachineCatalogError('access_denied');
    if (
      options.authority.current()?.synced !== true ||
      options.client.connectionState !== 'connected'
    )
      throw new MachineCatalogError('access_denied');
  };
  const rowsAt = (entries: readonly MachineFlockScanRow[]) =>
    readMachineFlockRowsFromFlock({ scan: () => entries });
  const publish = async <A>(
    prepare: (entries: readonly MachineFlockScanRow[], flock: MachineFlockWritableFlock) => A,
    external?: AbortSignal
  ) => {
    assertMachine(options.binding.machineId);
    const epoch = owned.currentEpoch(),
      cancellation = new AbortController();
    publications.add(cancellation);
    const changed = () => {
      const current = options.authority.current();
      if (
        current?.epoch !== epoch ||
        current.synced !== true ||
        !options.authorize('runtime') ||
        options.client.connectionState !== 'connected'
      )
        cancellation.abort();
    };
    const unauthority = options.authority.subscribe(changed),
      unconnection = options.client.onConnectionStateChange(changed);
    try {
      changed();
      const signal = external
        ? AbortSignal.any([external, cancellation.signal])
        : cancellation.signal;
      return (await owned.transact('runtime', prepare, undefined, signal)).result;
    } finally {
      unauthority();
      unconnection();
      publications.delete(cancellation);
    }
  };
  return {
    binding: options.binding,
    async importMagpie(machine, request) {
      assertMachine(machine.id);
      request = resolveMagpieImport({
        gateway: request.gatewayUrl,
        targets: request.targets.join(','),
      });
      return publish((entries, flock) => {
        const providers = importMagpieProviders({
          flock,
          machine,
          request,
          existing: Object.values(getMachineFlockAgentConfigs(rowsAt(entries))),
          newId: () => randomUUID() as AgentConfigId,
          now: (options.now ?? Date.now)(),
        });
        const configs = getMachineFlockAgentConfigs(readMachineFlockRowsFromFlock(flock));
        for (const provider of providers) {
          const config = configs[provider.agentConfigId];
          if (config)
            writeMachineFlockRowToFlock(flock, {
              key: machineFlockKeys.agentConfigIndex(config.id),
              value: agentSummary(config),
            });
        }
        return providers;
      });
    },
    async upload() {
      assertMachine(options.binding.machineId);
      owned.check(options.binding, 'upload');
      if (!options.upload) throw new MachineCatalogError('operation_failed');
      await options.upload();
      assertMachine(options.binding.machineId);
    },
    async readCatalog() {
      assertMachine(options.binding.machineId);
      return projectMachineRuntimeRows(
        (await owned.scan('runtime')).entries,
        options.binding.machineId
      );
    },
    async saveLocalProject(project, expected) {
      await publish((entries, flock) => {
        const current = getMachineFlockLocalProjects(rowsAt(entries))[project.id];
        if (!isDeepStrictEqual(current, expected)) throw new MachineCatalogError('edit_conflict');
        if (!parseMachineFlockRow(machineFlockKeys.localProject(project.id), project))
          throw new MachineCatalogError('invalid_edit');
        writeMachineFlockRowToFlock(flock, {
          key: machineFlockKeys.localProject(project.id),
          value: project,
        });
      });
    },
    async removeLocalProject(expected) {
      await publish((entries, flock) => {
        const current = getMachineFlockLocalProjects(rowsAt(entries))[expected.id];
        if (!isDeepStrictEqual(current, expected)) throw new MachineCatalogError('edit_conflict');
        deleteMachineFlockRowFromFlock(flock, machineFlockKeys.localProject(expected.id));
      });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const pending of publications) pending.abort();
      publications.clear();
    },
    async readSessionLaunchSnapshot(sessionId, sessionMeta) {
      assertMachine(sessionMeta?.machineId ?? options.binding.machineId);
      const snapshot = await owned.scan('runtime');
      const rows = rowsAt(snapshot.entries);
      if (
        sessionMeta?.agentConfigId &&
        getMachineFlockProviderSetupCancellations(rows)[sessionMeta.agentConfigId]
      )
        throw new MachineCatalogError('edit_conflict');
      return readMachineSessionLaunchSnapshotFromFlock({
        flock: { scan: () => snapshot.entries },
        sessionId,
        sessionMeta,
      });
    },
    async readAgentConfigs() {
      assertMachine(options.binding.machineId);
      const rows = rowsAt((await owned.scan('runtime')).entries),
        cancelled = getMachineFlockProviderSetupCancellations(rows);
      return Object.fromEntries(
        Object.entries(getMachineFlockAgentConfigs(rows)).filter(
          ([id, config]) =>
            config.machineId === options.binding.machineId && !cancelled[id as AgentConfigId]
        )
      );
    },
    async readAgentConfig(id) {
      assertMachine(options.binding.machineId);
      const rows = rowsAt((await owned.scan('runtime')).entries),
        config = getMachineFlockAgentConfigs(rows)[id];
      return !getMachineFlockProviderSetupCancellations(rows)[id] &&
        config?.machineId === options.binding.machineId
        ? config
        : undefined;
    },
    async saveAgentConfig(config, expected) {
      assertMachine(config.machineId);
      if (!parseMachineFlockRow(machineFlockKeys.agentConfig(config.id), config))
        throw new MachineCatalogError('invalid_edit');
      await publish((entries, flock) => {
        const rows = rowsAt(entries),
          current = getMachineFlockAgentConfigs(rows)[config.id];
        if (
          getMachineFlockProviderSetupCancellations(rows)[config.id] ||
          !isDeepStrictEqual(current, expected)
        )
          throw new MachineCatalogError('edit_conflict');
        writeAgentConfigToFlock(flock, config);
        writeMachineFlockRowToFlock(flock, {
          key: machineFlockKeys.agentConfigIndex(config.id),
          value: agentSummary(config),
        });
      });
    },
    async removeAgentConfig(expected) {
      assertMachine(expected.machineId);
      await publish((entries, flock) => {
        try {
          assertLosslessNativeFlockValue(
            entries.find(
              (entry) => keyOf(entry.key) === keyOf(machineFlockKeys.agentConfig(expected.id))
            )?.value,
            options
          );
        } catch {
          throw new MachineCatalogError('invalid_edit');
        }
        const current = getMachineFlockAgentConfigs(rowsAt(entries))[expected.id];
        if (!isDeepStrictEqual(current, expected)) throw new MachineCatalogError('edit_conflict');
        const now = (options.now ?? Date.now)();
        if (getMachineFlockProviderSetups(rowsAt(entries))[expected.id])
          applyProviderSetupCancellationToFlock(flock, {
            v: 1,
            id: expected.id,
            machineId: options.binding.machineId,
            cancelledAt: now,
          });
        else deleteAgentConfigFromFlock(flock, expected, now);
        deleteMachineFlockRowFromFlock(flock, machineFlockKeys.agentConfigIndex(expected.id));
      });
    },
    async hasAgentConfig(cliType, agentType, machineId) {
      assertMachine(machineId);
      const configs = getMachineFlockAgentConfigs(rowsAt((await owned.scan('runtime')).entries));
      return Object.values(configs).some(
        (config) =>
          config.machineId === machineId &&
          config.cliType === cliType &&
          config.agentType === agentType
      );
    },
    async findSoleAgentConfig(cliType, agentType, machineId) {
      assertMachine(machineId);
      const configs = Object.values(
        getMachineFlockAgentConfigs(rowsAt((await owned.scan('runtime')).entries))
      ).filter(
        (config) =>
          config.machineId === machineId &&
          config.cliType === cliType &&
          config.agentType === agentType
      );
      return configs.length === 1 ? configs[0] : undefined;
    },
    async getBuiltinAgentOptOuts(machineId) {
      assertMachine(machineId);
      return getMachineFlockBuiltinAgentOptOuts(rowsAt((await owned.scan('runtime')).entries));
    },
    async getAgentConfigById(id, machineId = options.binding.machineId) {
      assertMachine(machineId);
      const rows = rowsAt((await owned.scan('runtime')).entries);
      const config = getMachineFlockAgentConfigs(rows)[id];
      return !getMachineFlockProviderSetupCancellations(rows)[id] && config?.machineId === machineId
        ? config
        : null;
    },
    async createAgentConfig(cliType, agentType, machineId, name) {
      assertMachine(machineId);
      const id = randomUUID() as AgentConfigId;
      const config: AgentConfigMeta = {
        id,
        machineId,
        name: name ?? agentType,
        description: undefined,
        cliType,
        agentType,
        env: {},
      };
      await publish((_entries, flock) => {
        writeAgentConfigToFlock(flock, config);
        writeMachineFlockRowToFlock(flock, {
          key: machineFlockKeys.agentConfigIndex(id),
          value: agentSummary(config),
        });
      });
      return id;
    },
    async updateRateLimits(
      machineId,
      id,
      cliType,
      limits,
      shouldWrite = () => true,
      expectedConfig
    ) {
      assertMachine(machineId);
      if (!id && !isBuiltinAgentType(cliType)) return;
      await publish((entries, flock) => {
        const rows = rowsAt(entries);
        if (id && getMachineFlockProviderSetupCancellations(rows)[id]) return;
        publishMachineRateLimits(flock, id, cliType, limits, shouldWrite, expectedConfig);
      });
    },
    async getAgentConfigForMachineLaunch(id, machineId) {
      assertMachine(machineId);
      const rows = rowsAt((await owned.scan('runtime')).entries);
      if (getMachineFlockProviderSetupCancellations(rows)[id]) return null;
      const config =
        getMachineFlockAgentConfigs(rows)[id] ?? getMachineFlockProviderSetups(rows)[id]?.config;
      return config && isValidDaemonLaunchConfig(config, id, machineId) ? config : null;
    },
    async getAcpCapabilities(machineId, id) {
      assertMachine(machineId);
      return getMachineFlockAcpCapabilities(rowsAt((await owned.scan('runtime')).entries))[
        getAcpCapabilityCacheKey(id)
      ];
    },
    async updateAcpCapabilities(machineId, ...args) {
      assertMachine(machineId);
      return publish((entries, flock) => {
        if (getMachineFlockProviderSetupCancellations(rowsAt(entries))[args[0]])
          throw new MachineCatalogError('edit_conflict');
        return publishMachineAcpCapabilities(flock, ...args).entry;
      }, args[12]?.signal);
    },
    async updateAcpAuthMethods(machineId, id, authMethods) {
      assertMachine(machineId);
      await publish((entries, flock) => {
        const rows = rowsAt(entries);
        if (getMachineFlockProviderSetupCancellations(rows)[id])
          throw new MachineCatalogError('edit_conflict');
        const existing = getMachineFlockAcpCapabilities(rows)[getAcpCapabilityCacheKey(id)];
        if (existing && !isDeepStrictEqual(existing.authMethods ?? [], authMethods))
          writeMachineFlockRowToFlock(flock, {
            key: machineFlockKeys.acpCapability(id),
            value: { ...existing, authMethods },
          });
      });
    },
  };
}

export const makeNativeProviderSetupStorage = Effect.fnUntraced(function* (
  options: NativeMachineCatalogOptions
) {
  return yield* Effect.acquireRelease(
    Effect.sync(() => createNativeProviderSetupStorage(options)),
    (value) => Effect.promise(() => value.cleanup())
  );
});

/** One composition lease for all trusted machine consumers. The three narrow
 * capabilities share the same engine, namespace, writer and whole-mf room. */
export function createNativeMachineRuntimePorts(options: NativeMachineCatalogOptions) {
  const execution = createNativeMachineExecutionPort(options);
  const providerSetup = createNativeProviderSetupStorage(options);
  const catalog = createNativeMachineRuntimeCatalog(options);
  let closed = false;
  const closeExecution = execution.close;
  const close = () => {
    if (closed) return;
    closed = true;
    const failures: unknown[] = [];
    for (const capability of [{ close: closeExecution }, providerSetup, catalog])
      try {
        capability.close();
      } catch (error) {
        failures.push(error);
      }
    if (failures.length)
      throw new AggregateError(failures, 'Native machine capability release failed');
  };
  const cleanup = async (): Promise<void> => {
    const failures: unknown[] = [];
    try {
      close();
    } catch (error) {
      failures.push(error);
    }
    const results = await Promise.allSettled([providerSetup.cleanup(), catalog.cleanup()]);
    failures.push(
      ...results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
    );
    if (failures.length) throw new NativeMachineCatalogCleanupError(failures, cleanup);
  };
  // Selecting this execution port also retains its sibling command/provider
  // capabilities. The document owner's synchronous close retires the whole
  // composition, while the external engine/remote lease remains borrowed.
  execution.close = close;
  return {
    binding: Object.freeze({ ...options.binding }),
    execution,
    providerSetup,
    catalog,
    close,
    cleanup,
    retryCleanup: cleanup,
  };
}
export const makeNativeMachineRuntimePorts = Effect.fnUntraced(function* (
  options: NativeMachineCatalogOptions
) {
  return yield* Effect.acquireRelease(
    Effect.sync(() => createNativeMachineRuntimePorts(options)),
    (value) => Effect.promise(() => value.cleanup())
  );
});
