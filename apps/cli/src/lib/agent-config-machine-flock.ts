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

export type MachineFlockSyncScheduler = {
  markMachineFlockDocDirty: (machineId: MachineId, options?: { reason?: string }) => void;
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
  machineId: MachineId
): Promise<Record<AgentConfigId, AgentConfigMeta>> {
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
  agentConfigId: AgentConfigId
): Promise<AgentConfigPointLookup> {
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
  machineIds?: readonly MachineId[]
): Promise<AgentConfigMeta[]> {
  const resolvedMachineIds = machineIds ?? (await listMachineIds(repo));
  const [loroRepoMetaConfigs, machineFlockConfigs] = await Promise.all([
    listLoroRepoMetaAgentConfigs(repo),
    listMachineAgentConfigs(repo, workspaceId, resolvedMachineIds),
  ]);
  return mergeAgentConfigs(loroRepoMetaConfigs, machineFlockConfigs);
}

export async function upsertMachineAgentConfig(
  repo: LoroRepo,
  workspaceId: WorkspaceId,
  config: AgentConfigMeta,
  options: { sync?: MachineFlockSyncScheduler; reason?: string } = {}
): Promise<void> {
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
  options: { sync?: MachineFlockSyncScheduler; reason?: string } = {}
): Promise<void> {
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
  const scanner = repo.getMeta();
  if (!scanner) return [];
  const rows = await scanner.scan({ prefix: ['m'] });
  const ids = new Set<string>();
  for (const row of rows) {
    const key = row.key;
    if (!Array.isArray(key) || key.length < 2) continue;
    if (key[0] !== 'm') continue;
    const docId = key[1];
    if (typeof docId !== 'string') continue;
    if (!predicate(docId)) continue;
    ids.add(docId);
  }
  const results = await Promise.all(
    Array.from(ids).map(async (docId) => {
      const record = await repo.getDocMeta(docId);
      return record?.meta && !isLoroRepoDocDeleted(record) ? docId : null;
    })
  );
  return results.filter((docId): docId is string => docId !== null);
}

function normalizeAgentConfigMeta(raw: unknown): AgentConfigMeta | null {
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
