import {
  deleteAgentConfigFromFlock,
  getAgentConfigRoomId,
  getMachineFlockAgentConfigs,
  getMachineFlockBuiltinAgentOptOuts,
  getMachineFlockDocId,
  getServerNow,
  isAgentConfigDocRoomId,
  isLoroRepoDocDeleted,
  isMachineDocRoomId,
  MACHINE_DOC_PREFIX,
  machineFlockKeys,
  readMachineFlockRowsFromFlock,
  type AgentConfigId,
  type AgentConfigMeta,
  type AgentConfigCliType,
  type ManagedBuiltinAgentType,
  type MachineId,
  type WorkspaceId,
  writeAgentConfigToFlock,
} from '@lody/shared';
import type { LoroRepo } from 'loro-repo';
import type { MachineDocumentRuntimePort } from './machine-document-runtime-port';

export type MachineFlockSyncScheduler = {
  markMachineFlockDocDirty: (machineId: MachineId, options?: { reason?: string }) => void;
};

/** Trusted Node read capability selected by whole-machine ownership. Never expose through renderer IPC. */
export type MachineAgentConfigReadPort = {
  readonly binding: { readonly workspaceId: WorkspaceId; readonly machineId: MachineId };
  readAgentConfigs(): Promise<Record<AgentConfigId, AgentConfigMeta>>;
  readAgentConfig(id: AgentConfigId): Promise<AgentConfigMeta | undefined>;
};
const assertMachineSourceBinding = (
  source: MachineAgentConfigReadPort,
  workspaceId: WorkspaceId,
  machineId: MachineId
) => {
  if (source.binding.workspaceId !== workspaceId || source.binding.machineId !== machineId)
    throw new Error('Machine Agent config source binding mismatch');
};

/** Managed builtin provider types the user removed on this machine, so they must not be auto-registered at startup. */
export async function readMachineBuiltinAgentOptOuts(
  repo: LoroRepo,
  workspaceId: WorkspaceId,
  machineId: MachineId
): Promise<Set<ManagedBuiltinAgentType>> {
  const handle = await repo.openFlockDoc(getMachineFlockDocId(workspaceId, machineId));
  return getMachineFlockBuiltinAgentOptOuts(
    readMachineFlockRowsFromFlock(handle.flock, { families: ['builtinAgentOptOut'] })
  );
}

export async function readMachineAgentConfigs(
  repo: LoroRepo,
  workspaceId: WorkspaceId,
  machineId: MachineId,
  source?: MachineAgentConfigReadPort
): Promise<Record<AgentConfigId, AgentConfigMeta>> {
  if (source) {
    assertMachineSourceBinding(source, workspaceId, machineId);
    return source.readAgentConfigs();
  }
  const handle = await repo.openFlockDoc(getMachineFlockDocId(workspaceId, machineId));
  return getMachineFlockAgentConfigs(
    readMachineFlockRowsFromFlock(handle.flock, { families: ['agentConfig'] })
  );
}

export type AgentConfigPointLookup = {
  readonly config: AgentConfigMeta | null;
  readonly source: 'machine-flock' | 'legacy-repo-meta' | 'none';
};

/**
 * Resolve one agent config without enumerating either the Machine Flock family
 * or loro-repo's `m/*` metadata rows. Machine Flock is authoritative when both
 * storage generations contain the id.
 */
export async function readMergedAgentConfigById(
  repo: LoroRepo,
  workspaceId: WorkspaceId,
  machineId: MachineId,
  agentConfigId: AgentConfigId,
  source?: MachineAgentConfigReadPort
): Promise<AgentConfigPointLookup> {
  if (source) {
    assertMachineSourceBinding(source, workspaceId, machineId);
    const config = await source.readAgentConfig(agentConfigId);
    // A selected native owner is complete. Missing does not revive retired Meta rows.
    return { config: config ?? null, source: config ? 'machine-flock' : 'none' };
  }
  const handle = await repo.openFlockDoc(getMachineFlockDocId(workspaceId, machineId));
  const machineConfig = getMachineFlockAgentConfigs(
    readMachineFlockRowsFromFlock(handle.flock, {
      prefixes: [machineFlockKeys.agentConfig(agentConfigId)],
    })
  )[agentConfigId];
  if (machineConfig) {
    return { config: machineConfig, source: 'machine-flock' };
  }

  const legacyRecord = await repo.getDocMeta(getAgentConfigRoomId(agentConfigId));
  if (!legacyRecord?.meta || isLoroRepoDocDeleted(legacyRecord)) {
    return { config: null, source: 'none' };
  }
  const legacyConfig = normalizeAgentConfigMeta(legacyRecord.meta);
  return legacyConfig?.id === agentConfigId
    ? { config: legacyConfig, source: 'legacy-repo-meta' }
    : { config: null, source: 'none' };
}

export function mergeAgentConfigs(
  loroRepoMetaConfigs: readonly AgentConfigMeta[],
  machineFlockConfigs: readonly AgentConfigMeta[]
): AgentConfigMeta[] {
  const byId = new Map<AgentConfigId, AgentConfigMeta>();
  for (const config of loroRepoMetaConfigs) {
    byId.set(config.id, config);
  }
  for (const config of machineFlockConfigs) {
    byId.set(config.id, config);
  }
  return [...byId.values()];
}

export async function listMergedAgentConfigs(
  repo: LoroRepo,
  workspaceId: WorkspaceId,
  machineIds?: readonly MachineId[],
  source?: MachineAgentConfigReadPort
): Promise<AgentConfigMeta[]> {
  if (source) {
    assertMachineSourceBinding(source, workspaceId, source.binding.machineId);
    const requested = machineIds ?? [source.binding.machineId];
    const native = requested.includes(source.binding.machineId)
      ? Object.values(await source.readAgentConfigs())
      : [];
    const legacyMachines = requested.filter((machineId) => machineId !== source.binding.machineId);
    if (!legacyMachines.length) return native;
    const [legacyMeta, legacyFlocks] = await Promise.all([
      listLoroRepoMetaAgentConfigs(repo),
      listMachineAgentConfigs(repo, workspaceId, legacyMachines),
    ]);
    // The source's machine is authoritative even when it has zero configs.
    // Other machines retain their independently selected whole-room owner.
    const remoteMeta = legacyMeta.filter((config) => legacyMachines.includes(config.machineId));
    return [...native, ...mergeAgentConfigs(remoteMeta, legacyFlocks)];
  }
  const resolvedMachineIds = machineIds ?? (await listMachineIds(repo));
  const [loroRepoMetaConfigs, machineFlockConfigs] = await Promise.all([
    listLoroRepoMetaAgentConfigs(repo),
    listMachineAgentConfigs(repo, workspaceId, resolvedMachineIds),
  ]);
  return mergeAgentConfigs(loroRepoMetaConfigs, machineFlockConfigs);
}

/** The machine's only provider of this type; none when absent or ambiguous. */
export async function findSoleMachineAgentConfig(
  repo: LoroRepo,
  workspaceId: WorkspaceId,
  machineId: MachineId,
  cliType: AgentConfigCliType,
  agentType: string
): Promise<AgentConfigMeta | undefined> {
  const matches = (await listMergedAgentConfigs(repo, workspaceId, [machineId])).filter(
    (config) =>
      config.cliType === cliType && config.agentType === agentType && config.machineId === machineId
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export async function upsertMachineAgentConfig(
  repo: LoroRepo,
  workspaceId: WorkspaceId,
  config: AgentConfigMeta,
  options: {
    sync?: MachineFlockSyncScheduler;
    reason?: string;
    native?: MachineDocumentRuntimePort;
    expected?: AgentConfigMeta;
  } = {}
): Promise<void> {
  if (options.native) {
    assertMachineSourceBinding(options.native, workspaceId, config.machineId);
    await options.native.saveAgentConfig(config, options.expected);
    return;
  }
  const handle = await repo.openFlockDoc(getMachineFlockDocId(workspaceId, config.machineId));
  // Writing the row also retracts the same-type opt-out, both in one commit (see writeAgentConfigToFlock).
  const changed = writeAgentConfigToFlock(handle.flock, config);
  if (!changed) {
    await deleteLoroRepoMetaAgentConfigIfPresent(repo, config.id);
    return;
  }
  await repo.flush();
  if (options.sync) {
    options.sync.markMachineFlockDocDirty(config.machineId, {
      reason: options.reason ?? 'agent-config-upsert',
    });
  } else {
    await handle.syncOnce().catch(() => undefined);
  }
  await deleteLoroRepoMetaAgentConfigIfPresent(repo, config.id);
}

export async function deleteMachineAgentConfig(
  repo: LoroRepo,
  workspaceId: WorkspaceId,
  config: AgentConfigMeta,
  options: {
    sync?: MachineFlockSyncScheduler;
    reason?: string;
    native?: MachineDocumentRuntimePort;
  } = {}
): Promise<void> {
  if (options.native) {
    assertMachineSourceBinding(options.native, workspaceId, config.machineId);
    await options.native.removeAgentConfig(config);
    return;
  }
  const handle = await repo.openFlockDoc(getMachineFlockDocId(workspaceId, config.machineId));
  // Deleting the row also records an opt-out when needed, both in one commit (see deleteAgentConfigFromFlock).
  const changed = deleteAgentConfigFromFlock(handle.flock, config, getServerNow());
  if (!changed) {
    await deleteLoroRepoMetaAgentConfigIfPresent(repo, config.id);
    return;
  }
  await repo.flush();
  if (options.sync) {
    options.sync.markMachineFlockDocDirty(config.machineId, {
      reason: options.reason ?? 'agent-config-delete',
    });
  } else {
    await handle.syncOnce().catch(() => undefined);
  }
  await deleteLoroRepoMetaAgentConfigIfPresent(repo, config.id);
}

export async function listMachineAgentConfigs(
  repo: LoroRepo,
  workspaceId: WorkspaceId,
  machineIds: readonly MachineId[]
): Promise<AgentConfigMeta[]> {
  const records = await Promise.all(
    machineIds.map((machineId) => readMachineAgentConfigs(repo, workspaceId, machineId))
  );
  const byId = new Map<AgentConfigId, AgentConfigMeta>();
  for (const record of records) {
    for (const config of Object.values(record)) {
      byId.set(config.id, config);
    }
  }
  return [...byId.values()];
}

async function deleteLoroRepoMetaAgentConfigIfPresent(
  repo: LoroRepo,
  agentConfigId: AgentConfigId
): Promise<void> {
  const roomId = getAgentConfigRoomId(agentConfigId);
  const existing = await repo.getDocMeta(roomId);
  if (!existing?.meta || isLoroRepoDocDeleted(existing)) {
    return;
  }
  await repo.deleteDoc(roomId);
  await repo.flush();
}

async function listLoroRepoMetaAgentConfigs(repo: LoroRepo): Promise<AgentConfigMeta[]> {
  const roomIds = await listAliveDocIds(repo, isAgentConfigDocRoomId);
  const configs = await Promise.all(
    roomIds.map(async (roomId) => {
      const record = await repo.getDocMeta(roomId);
      if (!record?.meta || isLoroRepoDocDeleted(record)) {
        return null;
      }
      return normalizeAgentConfigMeta(record.meta);
    })
  );
  return configs.filter((config): config is AgentConfigMeta => config !== null);
}

async function listMachineIds(repo: LoroRepo): Promise<MachineId[]> {
  const roomIds = await listAliveDocIds(repo, isMachineDocRoomId);
  return roomIds.map((roomId) => roomId.slice(MACHINE_DOC_PREFIX.length) as MachineId);
}

async function listAliveDocIds(
  repo: LoroRepo,
  predicate: (docId: string) => boolean
): Promise<string[]> {
  return (await repo.listDoc())
    .filter(
      (row) =>
        predicate(row.docId) && !isLoroRepoDocDeleted(row) && Object.keys(row.meta).length > 0
    )
    .map((row) => row.docId);
}

export function normalizeAgentConfigMeta(raw: unknown): AgentConfigMeta | null {
  if (!isRecord(raw)) return null;
  const id = isNonEmptyString(raw.id) ? (raw.id as AgentConfigId) : null;
  const machineId = isNonEmptyString(raw.machineId) ? (raw.machineId as MachineId) : null;
  const name = isNonEmptyString(raw.name) ? raw.name : null;
  const cliType = isAgentConfigCliType(raw.cliType) ? raw.cliType : null;
  const agentType = isNonEmptyString(raw.agentType) ? raw.agentType : null;
  if (!id || !machineId || !name || !cliType || !agentType) {
    return null;
  }

  return {
    ...raw,
    id,
    machineId,
    name,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    cliType,
    agentType,
    env: isStringRecord(raw.env) ? raw.env : {},
  } as AgentConfigMeta;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isAgentConfigCliType(value: unknown): value is AgentConfigCliType {
  return value === 'builtin' || value === 'registry' || value === 'custom';
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => typeof entry === 'string');
}
