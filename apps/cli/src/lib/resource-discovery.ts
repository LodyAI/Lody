import {
  bindAgentRoleTarget,
  canReadAgentRole,
  getAgentRoleTargets,
  getAcpCapabilityCacheKey,
  summarizeAgentRunConfigCapabilities,
  normalizeAgentRoleRunConfig,
  getReadableAcpCapabilityCacheEntryForRuntimeOverrides,
  parseRateLimitEntryKey,
  type AcpCapabilityCacheEntry,
  type AgentConfigMeta,
  type AgentRole,
  type LocalProjectMeta,
  type MachineId,
  type MachineMeta,
  type WorkspaceMcpServerMeta,
} from '@lody/shared';
import type { RateLimit } from 'acp-extension-core';
import { mapWithConcurrency } from './bounded-concurrency';
import type { MachinePresenceView } from './loro/doc';
import {
  discoveryPage,
  matchesDiscoveryQuery,
  ResourceListSchemas,
  type DiscoveryQuery,
} from './discovery-query';

export type DiscoveryResource = 'machine' | 'project' | 'agent_config' | 'agent_role' | 'mcp';
export type DiscoveryAvailability = {
  state: 'available' | 'unavailable' | 'unknown';
  reason?: string;
  /** Next known instant at which an exhausted quota makes the row usable again. */
  availableAt?: string;
};
export type DiscoveryRow = {
  id: string;
  name: string;
  machineId?: string;
  description?: string;
  availability?: DiscoveryAvailability;
  [key: string]: unknown;
};
export class CatalogSyncingError extends Error {
  constructor() {
    super(
      'CATALOG_SYNCING: catalog has not completed its first synchronization; retry the request.'
    );
  }
  toLodyError() {
    return { code: 'CATALOG_SYNCING', message: this.message, retryable: true };
  }
}

export type DiscoverySource = {
  workspaceId: string;
  userId: string;
  /** Undefined means there is no active Turn selection to report. */
  selectedMcpServerIds?: readonly string[];
  catalogReadiness?(): {
    metadata: boolean;
    workspace: boolean;
    machines: ReadonlyMap<MachineId, boolean>;
  };
  machines(): Promise<MachineMeta[]>;
  machinePresence(): Promise<MachinePresenceView>;
  canAccess(machineId: MachineId, projectId?: string): Promise<boolean>;
  configs(machineId: MachineId): Promise<AgentConfigMeta[]>;
  capabilities(machineId: MachineId): Promise<Record<string, AcpCapabilityCacheEntry>>;
  /** Latest provider rate-limit snapshots the Machine synced; optional for older sources. */
  rateLimits?(machineId: MachineId): Promise<Record<string, RateLimit>>;
  /** Live memory/disk from the Machine itself; undefined when it cannot answer. */
  machineResources?(machine: MachineMeta): Promise<Record<string, unknown> | undefined>;
  projects(machineId: MachineId): Promise<LocalProjectMeta[]>;
  roles(): Promise<AgentRole[]>;
  mcpServers(): Promise<WorkspaceMcpServerMeta[]>;
  repositories(): Promise<Array<{ fullName: string }>>;
};

export function summarizeDiscoveryAgent(
  config: AgentConfigMeta,
  capability?: AcpCapabilityCacheEntry
) {
  return {
    id: config.id,
    name: config.name,
    machineId: config.machineId,
    description: config.description,
    cliType: config.cliType,
    agentType: config.agentType,
    runConfig: summarizeAgentRunConfigCapabilities(capability),
  };
}

/** Both boundaries use this allowlisted projection; launch values and credentials never escape. */
export function summarizeDiscoveryMcp(
  server: WorkspaceMcpServerMeta,
  selected?: readonly string[]
): DiscoveryRow {
  return {
    id: server.id,
    name: server.name,
    description: server.description,
    transport: server.transport,
    configured: Boolean(server.connection),
    enabledByDefault: server.enabledByDefault === true,
    ...(selected !== undefined ? { selectedForCurrentTurn: selected.includes(server.id) } : {}),
  };
}

export class ResourceDiscovery {
  constructor(private readonly source: DiscoverySource) {}

  async resolveMachine(selector: string): Promise<string> {
    const visible: MachineMeta[] = [];
    for (const machine of await this.source.machines())
      if (await this.source.canAccess(machine.id)) visible.push(machine);
    const exact = visible.find((machine) => machine.id === selector);
    if (exact) return exact.id;
    const matches = visible.filter((machine) => machine.name === selector);
    if (matches.length !== 1)
      throw new Error(
        matches.length
          ? 'Machine name is ambiguous; use its stable id.'
          : 'Machine not found or not readable.'
      );
    const match = matches[0];
    if (!match) throw new Error('Machine not found or not readable.');
    return match.id;
  }

  private catalogSyncing(resource: DiscoveryResource): boolean {
    const state = this.source.catalogReadiness?.();
    if (!state) return false;
    if (resource === 'mcp') return !state.workspace;
    if (!state.metadata) return true;
    if (resource === 'machine') return false;
    return (
      (resource === 'agent_role' && !state.workspace) ||
      [...state.machines.values()].some((ready) => !ready)
    );
  }

  private async rows(
    resource: DiscoveryResource,
    query: DiscoveryQuery,
    id?: string
  ): Promise<DiscoveryRow[]> {
    const source = this.source;
    if (resource === 'mcp')
      return (await source.mcpServers()).map((server) =>
        summarizeDiscoveryMcp(server, source.selectedMcpServerIds)
      );
    if (resource === 'project' && query.kind === 'github') {
      return (await source.repositories()).map((repo) => ({
        id: repo.fullName,
        name: repo.fullName,
        kind: 'github',
        repoFullName: repo.fullName,
      }));
    }
    // One row per machine target: a Role on several machines is listed once per
    // machine, each bound so its machine/config/run config are that target's.
    const roles =
      resource === 'agent_role'
        ? (await source.roles())
            .filter((role) => canReadAgentRole(role, source.userId) && (!id || role.id === id))
            .flatMap((role) =>
              getAgentRoleTargets(role).flatMap((target) => {
                const bound = bindAgentRoleTarget(role, target.machineId);
                return bound ? [bound] : [];
              })
            )
        : [];
    const machines = await source.machines();
    const presence = await source.machinePresence();
    const authorized: MachineMeta[] = [];
    // Bound machine I/O: no workspace-wide Promise.all fan-out.
    for (const machine of machines) {
      if (query.machineId && machine.id !== query.machineId) continue;
      if (resource === 'agent_role' && !roles.some((role) => role.machineId === machine.id))
        continue;
      if (await source.canAccess(machine.id)) authorized.push(machine);
    }
    // A fresh heartbeat is online even off a joined room; only a joined room proves absence.
    const status = (machineId: MachineId) =>
      presence.online.has(machineId) ? 'online' : presence.synced ? 'offline' : 'unknown';
    const availability = (machineId: MachineId): DiscoveryAvailability =>
      status(machineId) === 'online'
        ? { state: 'available' }
        : status(machineId) === 'offline'
          ? { state: 'unavailable', reason: 'machine_offline' }
          : { state: 'unknown', reason: 'presence_unavailable' };
    if (resource === 'machine')
      return authorized.map((machine) => ({
        id: machine.id,
        name: machine.name,
        onlineStatus: status(machine.id),
        canUse: true,
        availability: availability(machine.id),
        protocolCapabilities: machine.protocolCapabilities ?? {},
      }));
    if (resource === 'project') {
      const rows: DiscoveryRow[] = [];
      for (const machine of authorized) {
        for (const project of await source.projects(machine.id)) {
          if (await source.canAccess(machine.id, project.id))
            rows.push({
              id: project.id,
              name: project.name,
              kind: 'local',
              machineId: machine.id,
              rootPath: project.rootPath,
              availability: availability(machine.id),
            });
        }
      }
      if (query.kind !== 'local' && !query.machineId)
        for (const repo of await source.repositories()) {
          rows.push({
            id: repo.fullName,
            name: repo.fullName,
            kind: 'github',
            repoFullName: repo.fullName,
          });
        }
      return rows;
    }
    const configs = new Map<string, AgentConfigMeta>();
    const capabilities = new Map<string, AcpCapabilityCacheEntry>();
    const rateLimitsByMachine = new Map<string, Record<string, unknown>>();
    for (const machine of authorized) {
      for (const config of await source.configs(machine.id)) configs.set(config.id, config);
      for (const [key, capability] of Object.entries(await source.capabilities(machine.id)))
        capabilities.set(`${machine.id}:${key}`, capability);
      if (resource === 'agent_config' && source.rateLimits) {
        const rateLimits = await source.rateLimits(machine.id).catch(() => undefined);
        if (rateLimits) rateLimitsByMachine.set(machine.id, rateLimits);
      }
    }
    const capabilityOf = (config: AgentConfigMeta) => {
      const entry = getReadableAcpCapabilityCacheEntryForRuntimeOverrides(
        capabilities.get(`${config.machineId}:${getAcpCapabilityCacheKey(config.id)}`),
        config.runtimeOverrides
      );
      return entry?.agentType === config.agentType && entry.cliType === config.cliType
        ? entry
        : undefined;
    };
    if (resource === 'agent_config')
      return [...configs.values()].map((config) => {
        const capability = capabilityOf(config);
        const quotaResetAt = agentConfigQuotaResetAt(
          rateLimitsByMachine.get(config.machineId) ?? {},
          config.id
        );
        const base = availability(config.machineId);
        const state: DiscoveryAvailability =
          base.state === 'available' && quotaResetAt
            ? { state: 'unavailable', reason: 'quota_exhausted', availableAt: quotaResetAt }
            : base;
        return {
          ...summarizeDiscoveryAgent(config, capability),
          availability: state,
          capabilityStatus: capability ? 'reported' : 'unknown',
        };
      });
    return roles.map((role) => {
      const config = configs.get(role.agentConfigId);
      let state: DiscoveryAvailability;
      if (!authorized.some((machine) => machine.id === role.machineId))
        state = { state: 'unavailable', reason: 'machine_inaccessible_or_missing' };
      else if (!config) state = { state: 'unavailable', reason: 'agent_config_missing' };
      else if (config.machineId !== role.machineId)
        state = { state: 'unavailable', reason: 'agent_config_machine_mismatch' };
      else state = availability(role.machineId);
      const catalogState = source.catalogReadiness?.();
      const pending =
        catalogState &&
        (!catalogState.metadata ||
          !catalogState.workspace ||
          catalogState.machines.get(role.machineId) === false);
      const capability = config ? capabilityOf(config) : undefined;
      if (state.state === 'available' && !capability)
        state = { state: 'unknown', reason: 'capabilities_unreported' };
      const models = capability ? summarizeAgentRunConfigCapabilities(capability).models : [];
      if (
        state.state === 'available' &&
        capability &&
        role.runConfig.modelId &&
        !models.some((model) => model.id === role.runConfig.modelId)
      )
        state = { state: 'unavailable', reason: 'model_unavailable' };
      // A Role pins permission as `modeId` (legacy modes or a `mode` option) or
      // as the value of the agent's `_permission` option, e.g. Grok's
      // `permission_mode`. Check each pin against the knob that carries it.
      const modeOption = capability?.configOptions?.find((option) => option.category === 'mode');
      const modeId = role.runConfig.modeId;
      const unavailableMode =
        Boolean(modeId) &&
        !(modeOption
          ? modeOption.options.some((option) => option.value === modeId)
          : capability?.modes.some((mode) => mode.id === modeId));
      const unavailablePermission = (capability?.configOptions ?? []).some((option) => {
        if (option.category !== '_permission') return false;
        const value = role.runConfig.configOptionValues?.[option.id];
        return (
          value !== undefined && !option.options.some((candidate) => candidate.value === value)
        );
      });
      if (state.state === 'available' && capability && (unavailableMode || unavailablePermission))
        state = { state: 'unavailable', reason: 'mode_unavailable' };
      if (
        pending &&
        (state.reason === 'agent_config_missing' ||
          state.reason === 'capabilities_unreported' ||
          state.reason === 'model_unavailable' ||
          state.reason === 'mode_unavailable' ||
          (state.reason === 'machine_inaccessible_or_missing' &&
            !catalogState.metadata &&
            !machines.some((machine) => machine.id === role.machineId)))
      )
        state = { state: 'unknown', reason: 'catalog_syncing' };
      return {
        id: role.id,
        name: role.name,
        ...(role.alias ? { alias: role.alias } : {}),
        description: role.description ?? '',
        machineId: role.machineId,
        // More than one: create with agentRoleMachineId naming this row's machine.
        machineCount: 1 + (role.additionalTargets?.length ?? 0),
        agentConfigId: role.agentConfigId,
        visibility: role.visibility,
        revision: role.revision,
        runConfig: normalizeAgentRoleRunConfig(role.runConfig),
        availability: state,
        ...(id ? { promptPrefix: role.promptPrefix } : {}),
      };
    });
  }

  async list(resource: DiscoveryResource, query: DiscoveryQuery = {}) {
    query = ResourceListSchemas[resource].parse(query);
    if (query.kind === 'github' && query.machineId)
      throw new Error('GitHub repository catalog entries are not bound to a machine.');
    const rows = (await this.rows(resource, query)).filter(
      (row) =>
        matchesDiscoveryQuery(
          query.query,
          row.id,
          row.name,
          row.description,
          typeof row.rootPath === 'string' ? row.rootPath : undefined
        ) &&
        (!query.machineId || row.machineId === query.machineId) &&
        (!query.onlineStatus || row.onlineStatus === query.onlineStatus)
    );
    const page = discoveryPage(
      rows,
      query,
      JSON.stringify([resource, this.source.workspaceId, this.source.userId]),
      (row) => JSON.stringify([row.kind ?? resource, row.machineId ?? '', row.id])
    );
    if (resource === 'machine')
      page.items = await this.withMachineDetails(page.items, query.includeResources === true);
    return {
      ok: true as const,
      workspaceId: this.source.workspaceId,
      ...(this.catalogSyncing(resource) && !(resource === 'project' && query.kind === 'github')
        ? { sync: { state: 'syncing' as const, reason: 'catalog_syncing', retryable: true } }
        : {}),
      ...page,
    };
  }

  /**
   * Quota and, on request, live resources for one page of machines, four at a time.
   * Unreadable quota is omitted; a Machine that is offline, older or slow reports
   * `resources: "unavailable"`. Neither fails the list.
   */
  private async withMachineDetails(
    rows: DiscoveryRow[],
    includeResources: boolean
  ): Promise<DiscoveryRow[]> {
    const machines = includeResources
      ? new Map((await this.source.machines()).map((machine) => [machine.id, machine]))
      : undefined;
    return mapWithConcurrency(rows, MACHINE_DETAIL_CONCURRENCY, async (row) => {
      const rateLimits = await this.source.rateLimits?.(row.id as MachineId).catch(() => undefined);
      const quota = rateLimits ? summarizeMachineQuota(rateLimits) : [];
      const machine = machines?.get(row.id as MachineId);
      const resources =
        machine && row.onlineStatus !== 'offline'
          ? await this.source.machineResources?.(machine).catch(() => undefined)
          : undefined;
      return {
        ...row,
        ...(quota.length ? { quota } : {}),
        ...(includeResources ? { resources: resources ?? 'unavailable' } : {}),
      };
    });
  }

  async get(resource: 'agent_config' | 'agent_role', id: string, machineId?: string) {
    const rows = (await this.rows(resource, machineId ? { machineId } : {}, id)).filter(
      (candidate) => candidate.id === id
    );
    const [row] = rows;
    if (!row) {
      if (this.catalogSyncing(resource)) throw new CatalogSyncingError();
      throw new Error('RESOURCE_NOT_FOUND: resource does not exist or is not readable.');
    }
    // A Role on several machines has one row per machine; all are returned.
    return {
      ok: true as const,
      workspaceId: this.source.workspaceId,
      item: row,
      ...(this.catalogSyncing(resource)
        ? { sync: { state: 'syncing' as const, reason: 'catalog_syncing', retryable: true } }
        : {}),
      ...(rows.length > 1 ? { targets: rows } : {}),
    };
  }
}

const MAX_QUOTA_WINDOWS = 20;
const MACHINE_DETAIL_CONCURRENCY = 4;

/**
 * Most-used quota windows first, with reset times, so a coordinator sees an
 * exhausted agent account before dispatching to it.
 */
/** Synced rows may predate the current shape; such rows are skipped, not fatal. */
const isCurrentRateLimit = (value: unknown): value is RateLimit => {
  const limit = value as Partial<RateLimit> | null;
  return (
    typeof limit?.scope?.providerId === 'string' &&
    Array.isArray(limit.windows) &&
    limit.windows.every(
      (window) => typeof window?.usedPercent === 'number' && Number.isFinite(window.usedPercent)
    )
  );
};

const quotaResetMs = (window: RateLimit['windows'][number], nowMs: number): number | undefined => {
  const reset = window.resetsAtEpochSeconds;
  if (typeof reset !== 'number' || !Number.isFinite(reset)) return undefined;
  return reset * 1000 > nowMs ? reset * 1000 : undefined;
};

/**
 * The next instant at which an exhausted scoped quota for one Agent config
 * clears. Unscoped legacy rows cannot be attributed to a config and are skipped.
 */
export function agentConfigQuotaResetAt(
  rateLimits: Record<string, unknown>,
  agentConfigId: string,
  nowMs = Date.now()
): string | undefined {
  let latest: number | undefined;
  for (const [key, value] of Object.entries(rateLimits)) {
    if (!isCurrentRateLimit(value)) continue;
    if (parseRateLimitEntryKey(key).agentConfigId !== agentConfigId) continue;
    for (const window of value.windows) {
      if (window.usedPercent < 100) continue;
      const reset = quotaResetMs(window, nowMs);
      if (reset !== undefined) latest = Math.max(latest ?? 0, reset);
    }
  }
  return latest === undefined ? undefined : new Date(latest).toISOString();
}

export function summarizeMachineQuota(rateLimits: Record<string, unknown>) {
  const nowMs = Date.now();
  return Object.entries(rateLimits)
    .filter((entry): entry is [string, RateLimit] => isCurrentRateLimit(entry[1]))
    .flatMap(([key, limit]) => {
      const { agentConfigId } = parseRateLimitEntryKey(key);
      return limit.windows.map((window) => {
        const resetsAtMs = quotaResetMs(window, nowMs);
        return {
          provider: limit.scope.providerId,
          ...(limit.scope.modelId ? { model: limit.scope.modelId } : {}),
          ...(agentConfigId ? { agentConfigId } : {}),
          ...(limit.limitName ? { limit: limit.limitName } : {}),
          ...(window.label ? { label: window.label } : {}),
          usedPercent: window.usedPercent,
          exhausted: window.usedPercent >= 100,
          ...(typeof window.resetsAtEpochSeconds === 'number' &&
          Number.isFinite(window.resetsAtEpochSeconds)
            ? { resetsAt: new Date(window.resetsAtEpochSeconds * 1000).toISOString() }
            : {}),
          ...(window.usedPercent >= 100 && resetsAtMs !== undefined
            ? { unavailableUntil: new Date(resetsAtMs).toISOString() }
            : {}),
        };
      });
    })
    .sort((left, right) => right.usedPercent - left.usedPercent)
    .slice(0, MAX_QUOTA_WINDOWS);
}
