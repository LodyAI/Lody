import {
  planLocalProjectEnsure,
  planLocalProjectEdit,
  planLocalProjectHistoryInvalidation,
} from '../machine-catalog-project';
import type { MachineCatalogProjectSummary } from '../machine-catalog';
import { planMemoryAssociationWrite } from '../machine-catalog-association';
import type { MemoryAssociation } from '../memory-provider';
import { Effect } from 'effect';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { RepoClient, FlockOp, JsonValue } from '@loro-dev/loro-repo-client';
import {
  assertMachineCatalogBinding,
  MachineCatalogError,
  prepareAgentConfigEdit,
  AgentConfigEditSchema,
  type MachineCatalogBinding,
  type MachineCatalogCommand,
  type MachineCatalogEditor,
} from '../machine-catalog';
import {
  preserveStoredAgentConfigFields,
  getMachineFlockDocId,
  readMachineFlockRowsFromFlock,
  getMachineFlockAgentConfigs,
  getMachineFlockProviderSetupCancellations,
  getMachineFlockProviderSetups,
  machineFlockKeys,
  parseMachineFlockRow,
  writeAgentConfigToFlock,
  deleteAgentConfigFromFlock,
  writeMachineFlockRowToFlock,
  deleteMachineFlockRowFromFlock,
  applyProviderSetupCancellationToFlock,
  type MachineFlockScanRow,
  type MachineFlockWritableFlock,
  type MachineFlockKey,
  type MachineFlockRow,
  type ProviderSetupTask,
  type MachineDeleteLocalProjectCommand,
} from '../machine-flock';
import type { AgentConfigMeta, MachineMeta } from '../schema';
import type { AgentConfigId } from '../ids';
import { importMagpieProviders, resolveMagpieImport } from '../machine-catalog-magpie';
import { assertNativeFlockRewriteValue as assertLosslessNativeFlockValue } from './native-flock-value';
import {
  agentSummary,
  projectNativeMachineCatalog,
  type NativeMachineCatalogProjection,
} from './native-machine-catalog-projection';
import {
  createNativeMachineCatalogObservations,
  NativeMachineCatalogCleanupError,
} from './native-machine-catalog-observations';
export { type NativeMachineCatalogProjection } from './native-machine-catalog-projection';
export { NativeMachineCatalogCleanupError } from './native-machine-catalog-observations';

const nativeDocumentWireValue = (value: unknown): JsonValue => {
  if (Array.isArray(value)) return value.map(nativeDocumentWireValue);
  if (value && typeof value === 'object' && !(value instanceof Uint8Array))
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, field]) => field !== undefined)
        .map(([key, field]) => [key, nativeDocumentWireValue(field)])
    ) as JsonValue;
  return value as JsonValue;
};

export type NativeMachineCatalogAuthority = {
  current(): { readonly epoch: string; readonly synced: boolean } | undefined;
  subscribe(listener: () => void): () => void;
};
export type NativeMachineCatalogOptions = {
  /** Trusted composition proof for the exact connected engine/client artifact. */
  readonly losslessWireI64?: true;
  readonly cleanupTimeoutMs?: number;
  readonly client: RepoClient;
  readonly namespace: string;
  readonly writer: string;
  readonly binding: MachineCatalogBinding;
  /** Selected whole-mf owner grant, not a per-family migration decision. */
  readonly authorize: (
    operation: 'read' | 'manage' | 'runtime' | 'launch' | 'upload',
    command?: MachineCatalogCommand
  ) => boolean;
  readonly authority: NativeMachineCatalogAuthority;
  readonly now?: () => number;
  readonly editTtlMs?: number;
  readonly maxEditors?: number;
  /** Trusted owner probe; never accept a renderer's claimed verification result. */
  readonly verifyAgentChange?: (
    previous: AgentConfigMeta | undefined,
    next: AgentConfigMeta,
    signal: AbortSignal
  ) => Promise<boolean>;
  readonly upload?: () => Promise<void>;
  /** Host-owned advertised capabilities; never accept a renderer's machine metadata. */
  readonly machineMetadata?: () => Promise<MachineMeta>;
};
const keyOf = (key: readonly unknown[]) => JSON.stringify(key);
const matches = (key: readonly unknown[], prefix: readonly unknown[]) =>
  prefix.every((part, index) => key[index] === part);
const recorder = (
  entries: readonly MachineFlockScanRow[],
  compatibility: Pick<NativeMachineCatalogOptions, 'losslessWireI64'>
) => {
  const rows = new Map(entries.map((entry) => [keyOf(entry.key), entry]));
  const operations = new Map<string, FlockOp>();
  const flock: MachineFlockWritableFlock = {
    scan: (options) =>
      [...rows.values()].filter((row) => !options?.prefix || matches(row.key, options.prefix)),
    set(key, value) {
      const previous = rows.get(keyOf(key))?.value;
      // Preserve opaque stored root extensions, without accepting new extension input.
      const known = parseMachineFlockRow(key, previous)?.value;
      if (
        previous &&
        known &&
        value &&
        typeof previous === 'object' &&
        typeof known === 'object' &&
        typeof value === 'object' &&
        !Array.isArray(value)
      ) {
        const opaque = Object.fromEntries(
          Object.entries(previous).filter(([field]) => !Object.hasOwn(known, field))
        );
        value = { ...opaque, ...value };
        if (
          key[0] === 'providerSetup' &&
          'config' in previous &&
          'config' in (value as Record<string, unknown>)
        )
          (value as ProviderSetupTask).config = preserveStoredAgentConfigFields(
            previous.config,
            (value as ProviderSetupTask).config
          );
      }
      try {
        assertLosslessNativeFlockValue(value, compatibility);
      } catch {
        throw new MachineCatalogError('invalid_edit');
      }
      const stored = nativeDocumentWireValue(value);
      rows.set(keyOf(key), { key, value: stored });
      operations.set(keyOf(key), { op: 'put', key, value: stored });
    },
    delete(key) {
      rows.delete(keyOf(key));
      operations.set(keyOf(key), { op: 'delete', key });
    },
    commit() {},
  };
  return { flock, operations: () => [...operations.values()] };
};

type EditContext = { id: AgentConfigId; value: unknown; epoch: string; expiresAt: number };
export function createNativeMachineCatalogOwner(options: NativeMachineCatalogOptions) {
  const expected = Object.freeze({ ...options.binding });
  const room = {
    kind: 'flock' as const,
    id: getMachineFlockDocId(expected.workspaceId, expected.machineId),
  };
  const check = (
    binding: MachineCatalogBinding,
    operation: Parameters<typeof options.authorize>[0],
    command?: MachineCatalogCommand
  ) => {
    assertMachineCatalogBinding(expected, binding);
    if (!options.authorize(operation, command)) throw new MachineCatalogError('access_denied');
  };
  const currentEpoch = () => {
    const authority = options.authority.current();
    if (!authority) throw new MachineCatalogError('access_denied');
    return authority.epoch;
  };
  const scan = async (operation: Parameters<typeof options.authorize>[0]) => {
    check(expected, operation);
    const epoch = currentEpoch();
    const snapshot = await options.client.flockScan(options.namespace, room);
    check(expected, operation);
    if (currentEpoch() !== epoch) throw new MachineCatalogError('access_denied');
    return snapshot;
  };
  const transact = async <A>(
    operation: 'manage' | 'runtime',
    prepare: (entries: readonly MachineFlockScanRow[], flock: MachineFlockWritableFlock) => A,
    command?: MachineCatalogCommand,
    signal?: AbortSignal
  ): Promise<{ result: A; changed: boolean }> =>
    options.client.transactCas(async () => {
      check(expected, operation, command);
      if (signal?.aborted) throw new MachineCatalogError('access_denied');
      const epoch = currentEpoch();
      const snapshot = await scan(operation),
        plan = recorder(snapshot.entries, options);
      const result = prepare(snapshot.entries, plan.flock),
        operations = plan.operations();
      check(expected, operation, command);
      if (signal?.aborted || currentEpoch() !== epoch)
        throw new MachineCatalogError('access_denied');
      if (operations.length)
        await options.client.flockBatch(options.namespace, room, operations, {
          writer: options.writer,
          precondition: { mode: 'cas', expected_room_tx_id: snapshot.roomTxId },
        });
      return { result, changed: operations.length > 0 };
    });
  return { expected, room, check, currentEpoch, scan, transact };
}

/** Renderer-safe catalog/editor capability. No old credential or raw row leaves it. */
export function createNativeMachineCatalog(options: NativeMachineCatalogOptions) {
  let closed = false;
  if (
    !Number.isSafeInteger(options.maxEditors ?? 128) ||
    (options.maxEditors ?? 128) < 1 ||
    !Number.isFinite(options.editTtlMs ?? 300000) ||
    (options.editTtlMs ?? 300000) <= 0
  )
    throw new MachineCatalogError('invalid_edit');
  const owned = createNativeMachineCatalogOwner({
      ...options,
      authorize: (operation, command) => !closed && options.authorize(operation, command),
    }),
    now = options.now ?? Date.now;
  const observations = createNativeMachineCatalogObservations(
    options.client,
    options.cleanupTimeoutMs
  );
  const verifications = new Set<AbortController>();
  const editors = new Map<string, EditContext>();
  const retire = () => {
    closed = true;
    for (const verification of verifications) verification.abort();
    editors.clear();
    observations.retire();
  };
  const rawConfig = (entries: readonly MachineFlockScanRow[], id: AgentConfigId) =>
    entries.find((row) => keyOf(row.key) === keyOf(machineFlockKeys.agentConfig(id)))?.value;
  const configAt = (entries: readonly MachineFlockScanRow[], id: AgentConfigId) => {
    const value = getMachineFlockAgentConfigs(
      readMachineFlockRowsFromFlock({ scan: () => entries })
    )[id];
    if (!value || value.machineId !== owned.expected.machineId)
      throw new MachineCatalogError('not_found');
    return value;
  };
  const context = (id: AgentConfigId, token: string) => {
    const value = editors.get(token);
    if (!value || value.expiresAt <= now()) {
      editors.delete(token);
      throw new MachineCatalogError('edit_expired');
    }
    if (value.id !== id || value.epoch !== owned.currentEpoch())
      throw new MachineCatalogError('edit_conflict');
    return value;
  };
  const verify = async (
    previous: AgentConfigMeta | undefined,
    config: AgentConfigMeta,
    epoch: string,
    external?: AbortSignal
  ) => {
    if (!options.verifyAgentChange) throw new MachineCatalogError('verification_required');
    const signal = new AbortController();
    verifications.add(signal);
    const changed = () => {
      if (options.authority.current()?.epoch !== epoch || !options.authorize('manage'))
        signal.abort();
    };
    const unlisten = options.authority.subscribe(changed);
    const abort = () => signal.abort();
    external?.addEventListener('abort', abort, { once: true });
    if (external?.aborted) abort();
    try {
      changed();
      if (
        signal.signal.aborted ||
        !(await options.verifyAgentChange(previous, config, signal.signal))
      )
        throw new MachineCatalogError('verification_failed');
      changed();
      if (signal.signal.aborted) throw new MachineCatalogError('access_denied');
    } catch (error) {
      if (error instanceof MachineCatalogError) throw error;
      throw new MachineCatalogError('verification_failed');
    } finally {
      unlisten();
      external?.removeEventListener('abort', abort);
      verifications.delete(signal);
    }
  };
  const execute = async (
    binding: MachineCatalogBinding,
    command: MachineCatalogCommand,
    signal?: AbortSignal
  ) => {
    owned.check(binding, 'manage', command);
    let importMachine: MachineMeta | undefined;
    if (command.kind === 'import-magpie') {
      const epoch = owned.currentEpoch();
      if (!options.machineMetadata) throw new MachineCatalogError('operation_failed');
      importMachine = await options.machineMetadata();
      if (
        signal?.aborted ||
        owned.currentEpoch() !== epoch ||
        importMachine.id !== owned.expected.machineId
      )
        throw new MachineCatalogError('access_denied');
    }
    owned.check(binding, 'manage', command);
    let verified: ReturnType<typeof prepareAgentConfigEdit> | undefined;
    let edit: EditContext | undefined;
    if (command.kind === 'edit-agent' || command.kind === 'remove-agent') {
      edit = context(command.id, command.editToken);
      const snapshot = await owned.scan('manage');
      if (!isDeepStrictEqual(rawConfig(snapshot.entries, command.id), edit.value))
        throw new MachineCatalogError('edit_conflict');
      const previous = configAt(snapshot.entries, command.id);
      if (command.kind === 'edit-agent') {
        if (
          snapshot.entries.some(
            (entry) =>
              keyOf(entry.key) === keyOf(machineFlockKeys.providerSetupCancellation(command.id))
          )
        )
          throw new MachineCatalogError('edit_conflict');
        verified = prepareAgentConfigEdit(previous, command.changes);
        if (verified.launchChanged) await verify(previous, verified.config, edit.epoch, signal);
      }
    }
    if (command.kind === 'create-agent') {
      if (
        command.config.machineId !== owned.expected.machineId ||
        !parseMachineFlockRow(machineFlockKeys.agentConfig(command.config.id), command.config)
      )
        throw new MachineCatalogError('invalid_edit');
      AgentConfigEditSchema.parse({ env: { kind: 'replace', value: command.config.env } });
      const epoch = owned.currentEpoch(),
        snapshot = await owned.scan('manage');
      if (
        rawConfig(snapshot.entries, command.config.id) !== undefined ||
        snapshot.entries.some(
          (entry) =>
            keyOf(entry.key) ===
            keyOf(machineFlockKeys.providerSetupCancellation(command.config.id))
        )
      )
        throw new MachineCatalogError('edit_conflict');
      await verify(undefined, command.config, epoch, signal);
      if (owned.currentEpoch() !== epoch) throw new MachineCatalogError('access_denied');
    }
    let association: MemoryAssociation | undefined;
    let project: MachineCatalogProjectSummary | undefined;
    const result = await owned.transact(
      'manage',
      (entries, flock) => {
        const put = (key: MachineFlockKey, value: unknown) => {
          if (!parseMachineFlockRow(key, value)) throw new MachineCatalogError('invalid_edit');
          return writeMachineFlockRowToFlock(flock, { key, value } as MachineFlockRow);
        };
        if (command.kind === 'import-magpie') {
          const request = resolveMagpieImport({
            gateway: command.request.gatewayUrl,
            targets: command.request.targets.join(','),
          });
          const providers = importMagpieProviders({
            flock,
            machine: importMachine!,
            request,
            existing: Object.values(
              getMachineFlockAgentConfigs(readMachineFlockRowsFromFlock(flock))
            ),
            newId: () => randomUUID() as AgentConfigId,
            now: now(),
          });
          const configs = getMachineFlockAgentConfigs(readMachineFlockRowsFromFlock(flock));
          for (const provider of providers) {
            const config = configs[provider.agentConfigId];
            if (config) put(machineFlockKeys.agentConfigIndex(config.id), agentSummary(config));
          }
        } else if (command.kind === 'create-agent') {
          if (
            entries.some(
              (entry) =>
                keyOf(entry.key) ===
                keyOf(machineFlockKeys.providerSetupCancellation(command.config.id))
            )
          )
            throw new MachineCatalogError('edit_conflict');
          if (rawConfig(entries, command.config.id) !== undefined)
            throw new MachineCatalogError('edit_conflict');
          writeAgentConfigToFlock(flock, command.config);
          put(machineFlockKeys.agentConfigIndex(command.config.id), agentSummary(command.config));
        } else if (command.kind === 'edit-agent' || command.kind === 'remove-agent') {
          const active = context(command.id, command.editToken);
          if (!isDeepStrictEqual(rawConfig(entries, command.id), active.value))
            throw new MachineCatalogError('edit_conflict');
          const previous = configAt(entries, command.id);
          if (command.kind === 'remove-agent') {
            try {
              assertLosslessNativeFlockValue(rawConfig(entries, command.id), options);
            } catch {
              throw new MachineCatalogError('invalid_edit');
            }
            const rows = readMachineFlockRowsFromFlock({ scan: () => entries });
            if (getMachineFlockProviderSetups(rows)[command.id])
              applyProviderSetupCancellationToFlock(flock, {
                v: 1,
                id: command.id,
                machineId: owned.expected.machineId,
                cancelledAt: command.now,
              });
            else deleteAgentConfigFromFlock(flock, previous, command.now);
            deleteMachineFlockRowFromFlock(flock, machineFlockKeys.agentConfigIndex(command.id));
          } else {
            if (
              entries.some(
                (entry) =>
                  keyOf(entry.key) === keyOf(machineFlockKeys.providerSetupCancellation(command.id))
              )
            )
              throw new MachineCatalogError('edit_conflict');
            writeAgentConfigToFlock(flock, verified!.config);
            put(machineFlockKeys.agentConfigIndex(command.id), agentSummary(verified!.config));
            if (verified!.launchChanged)
              for (const entry of entries)
                if (
                  [
                    'acpCapability',
                    'acpModelCapability',
                    'acpModelConfigOptions',
                    'acpModelConfigOptionsShape',
                  ].includes(String(entry.key[0])) &&
                  entry.key[1] === command.id
                )
                  flock.delete(entry.key as MachineFlockKey);
          }
        } else if (command.kind === 'clear-dot-lody-path') {
          deleteMachineFlockRowFromFlock(flock, machineFlockKeys.dotlodyPath());
        } else if (command.kind === 'dismiss-local-project-deletion') {
          const key = machineFlockKeys.deleteLocalProjectCommand(command.projectId);
          const current = [...flock.scan({ prefix: key })].find(
            (row) => keyOf(row.key) === keyOf(key)
          );
          if (current) {
            const row = parseMachineFlockRow(key, current.value);
            const result = row?.value as MachineDeleteLocalProjectCommand | undefined;
            if (
              result?.status !== 'completed' ||
              result.cleanupResult?.completedAt !== command.completedAt
            )
              throw new MachineCatalogError('edit_conflict');
            try {
              assertLosslessNativeFlockValue(current.value, options);
            } catch {
              throw new MachineCatalogError('invalid_edit');
            }
            flock.delete(key);
          }
        } else if (command.kind === 'set-dot-lody-path')
          put(machineFlockKeys.dotlodyPath(), command.path);
        else if (command.kind === 'remove-session-launch-reference') {
          const key = machineFlockKeys.sessionLaunchConfig(command.sessionId);
          if (entries.some((entry) => keyOf(entry.key) === keyOf(key))) flock.delete(key);
        } else if (command.kind === 'invalidate-project-history-import') {
          const key = machineFlockKeys.localProject(command.projectId);
          const current = entries.find((entry) => keyOf(entry.key) === keyOf(key));
          const plan = planLocalProjectHistoryInvalidation(current?.value, command);
          if (plan.value) flock.set(key, plan.value as never);
        } else if (
          command.kind === 'ensure-local-project' ||
          command.kind === 'edit-local-project'
        ) {
          const id = command.kind === 'ensure-local-project' ? command.project.id : command.id;
          const key = machineFlockKeys.localProject(id);
          const current = entries.find((entry) => keyOf(entry.key) === keyOf(key));
          const plan =
            command.kind === 'ensure-local-project'
              ? planLocalProjectEnsure(current?.value, command.project)
              : planLocalProjectEdit(current?.value, id, command.changes);
          project = plan.project;
          if (plan.value) flock.set(key, plan.value as never);
        } else if (command.kind === 'save-local-project')
          put(machineFlockKeys.localProject(command.project.id), command.project);
        else if (command.kind === 'link-memory' || command.kind === 'edit-memory') {
          if (command.association.machineId !== owned.expected.machineId)
            throw new MachineCatalogError('invalid_edit');
          const key = machineFlockKeys.memory(
            command.association.providerId,
            command.association.memoryId
          );
          const current = entries.find((entry) => keyOf(entry.key) === keyOf(key));
          const plan = planMemoryAssociationWrite(
            current?.value,
            command.association,
            command.kind === 'link-memory' ? 'link' : 'edit'
          );
          association = plan.association;
          if (plan.value) flock.set(key, plan.value as never);
        } else if (command.kind === 'associate-memory') {
          if (command.association.machineId !== owned.expected.machineId)
            throw new MachineCatalogError('invalid_edit');
          put(
            machineFlockKeys.memory(command.association.providerId, command.association.memoryId),
            command.association
          );
        } else if (command.kind === 'remove-memory') {
          const key = machineFlockKeys.memory(command.providerId, command.memoryId);
          // Removal targets the exact bound association, including future fields
          // which the current known-row parser intentionally does not normalize.
          if (entries.some((entry) => keyOf(entry.key) === keyOf(key))) flock.delete(key);
        } else if (command.kind === 'retry-provider-setup') {
          const rows = readMachineFlockRowsFromFlock(flock);
          const current = getMachineFlockProviderSetups(rows)[command.id];
          if (
            !current ||
            current.machineId !== owned.expected.machineId ||
            getMachineFlockProviderSetupCancellations(rows)[command.id] ||
            current.attempt !== command.expected.attempt ||
            current.status !== command.expected.status ||
            current.updatedAt !== command.expected.updatedAt
          )
            throw new MachineCatalogError('edit_conflict');
          const { failureCode: _failureCode, ...base } = current;
          put(machineFlockKeys.providerSetup(command.id), {
            ...base,
            status: 'queued',
            attempt: current.attempt + 1,
            updatedAt: command.now,
          });
        } else if (command.kind === 'cancel-provider-setup') {
          if (command.cancellation.machineId !== owned.expected.machineId)
            throw new MachineCatalogError('invalid_edit');
          applyProviderSetupCancellationToFlock(flock, command.cancellation);
        } else if (command.kind === 'set-builtin-opt-out')
          put(machineFlockKeys.builtinAgentOptOut(command.agentType), {
            v: 1,
            removedAt: command.removedAt,
          });
        else {
          let key: MachineFlockKey, value: unknown;
          if (command.kind === 'queue-provider-setup') {
            if (
              command.task.machineId !== owned.expected.machineId ||
              command.task.status !== 'queued' ||
              command.task.failureCode ||
              [
                ...flock.scan({
                  prefix: machineFlockKeys.providerSetupCancellation(command.task.id),
                }),
              ].length
            )
              throw new MachineCatalogError('invalid_edit');
            key = machineFlockKeys.providerSetup(command.task.id);
            value = command.task;
          } else if (command.kind === 'archive-session') {
            key = machineFlockKeys.archiveSessionCommand(command.sessionId);
            value = command.command;
          } else if (command.kind === 'delete-session') {
            key = machineFlockKeys.deleteSessionCommand(command.sessionId);
            value = command.command;
          } else if (command.kind === 'delete-local-project') {
            key = machineFlockKeys.deleteLocalProjectCommand(command.projectId);
            value = command.command;
          } else throw new MachineCatalogError('invalid_edit');
          const existing = [...flock.scan({ prefix: key })].find(
            (row) => keyOf(row.key) === keyOf(key)
          );
          if (existing) {
            if (
              !isDeepStrictEqual(
                parseMachineFlockRow(key, existing.value)?.value,
                parseMachineFlockRow(key, value)?.value
              )
            )
              throw new MachineCatalogError('edit_conflict');
          } else put(key, value);
        }
      },
      command,
      signal
    );
    if (command.kind === 'edit-agent' || command.kind === 'remove-agent')
      editors.delete(command.editToken);
    return {
      changed: result.changed,
      ...(association ? { association } : {}),
      ...(project ? { project } : {}),
    };
  };
  return {
    async read(binding: MachineCatalogBinding): Promise<NativeMachineCatalogProjection> {
      owned.check(binding, 'read');
      return projectNativeMachineCatalog(
        (await owned.scan('read')).entries,
        owned.expected.machineId
      );
    },
    async beginAgentConfigEdit(
      binding: MachineCatalogBinding,
      id: AgentConfigId
    ): Promise<MachineCatalogEditor> {
      owned.check(binding, 'manage');
      const snapshot = await owned.scan('manage'),
        config = configAt(snapshot.entries, id);
      for (const [token, value] of editors) if (value.expiresAt <= now()) editors.delete(token);
      while (editors.size >= (options.maxEditors ?? 128))
        editors.delete(editors.keys().next().value!);
      const editToken = randomUUID(),
        expiresAt = now() + (options.editTtlMs ?? 300000);
      editors.set(editToken, {
        id,
        value: structuredClone(rawConfig(snapshot.entries, id)),
        epoch: owned.currentEpoch(),
        expiresAt,
      });
      return {
        ...agentSummary(config),
        editToken,
        expiresAt,
        credentials: {
          envPresent: Object.keys(config.env).length > 0,
          customLaunchPresent: !!config.customAcp,
          runtimeOverridesPresent: !!config.runtimeOverrides,
          profilePresent: !!config.codexAuth,
        },
        hasPrompt: !!config.prompt,
        credentialVerification: 'unknown',
      };
    },
    async execute(
      binding: MachineCatalogBinding,
      command: MachineCatalogCommand,
      execution?: { signal?: AbortSignal }
    ) {
      try {
        return await execute(binding, command, execution?.signal);
      } catch (error) {
        if (error instanceof MachineCatalogError) throw error;
        throw new MachineCatalogError('operation_failed');
      }
    },
    async upload(binding: MachineCatalogBinding) {
      owned.check(binding, 'upload');
      if (!options.upload) throw new MachineCatalogError('operation_failed');
      await options.upload();
    },
    async observe(
      binding: MachineCatalogBinding,
      listener: (update: { projection: NativeMachineCatalogProjection; synced: boolean }) => void,
      onError: (error: unknown) => void
    ) {
      owned.check(binding, 'read');
      let stopped = false;
      let current: NativeMachineCatalogProjection | undefined;
      const epoch = owned.currentEpoch();
      const fail = (error: unknown) => {
        if (!stopped) {
          try {
            onError(error);
          } catch {}
        }
      };
      const publish = () => {
        if (stopped || !current) return;
        try {
          owned.check(binding, 'read');
          if (owned.currentEpoch() !== epoch) throw new MachineCatalogError('access_denied');
          listener({
            projection: current,
            synced:
              options.client.connectionState === 'connected' &&
              options.authority.current()?.synced === true,
          });
        } catch (error) {
          fail(error);
        }
      };
      const detachments = new Set<() => void>();
      const fence = () => {
        stopped = true;
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
          throw new AggregateError(failures, 'Machine catalog listener cleanup failed');
      };
      const acquired = await observations.acquire(
        () =>
          options.client.flockSubscribe(options.namespace, owned.room, {}, (value) => {
            if (stopped) return;
            current = projectNativeMachineCatalog(
              value as unknown as MachineFlockScanRow[],
              owned.expected.machineId
            );
            publish();
          }),
        fence
      );
      try {
        owned.check(binding, 'read');
        if (owned.currentEpoch() !== epoch) throw new MachineCatalogError('access_denied');
        current ??= projectNativeMachineCatalog(
          acquired.currentValue() as unknown as MachineFlockScanRow[],
          owned.expected.machineId
        );
        detachments.add(options.client.onConnectionStateChange(publish));
        detachments.add(options.authority.subscribe(publish));
        publish();
        return acquired.observation;
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
    retire,
    close() {
      retire();
      return observations.close();
    },
    retryCleanup() {
      retire();
      return observations.retryCleanup();
    },
  };
}

/** Scope joins real observer release, retaining failures for owner retry. */
export const makeNativeMachineCatalog = Effect.fnUntraced(function* (
  options: NativeMachineCatalogOptions
) {
  return yield* Effect.acquireRelease(
    Effect.sync(() => createNativeMachineCatalog(options)),
    (value) => Effect.promise(() => value.close())
  );
});
