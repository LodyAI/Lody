import {
  canReadAgentRole,
  getAcpCapabilityCacheKey,
  summarizeAgentRunConfigCapabilities,
  normalizeAgentRoleRunConfig,
  getReadableAcpCapabilityCacheEntryForRuntimeOverrides,
  type AcpCapabilityCacheEntry,
  type AgentConfigMeta,
  type AgentRole,
  type LocalProjectMeta,
  type MachineId,
  type MachineMeta,
  type WorkspaceMcpServerMeta,
} from '@lody/shared';
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
};
export type DiscoveryRow = {
  id: string;
  name: string;
  machineId?: string;
  description?: string;
  availability?: DiscoveryAvailability;
  [key: string]: unknown;
};
export type DiscoverySource = {
  workspaceId: string;
  userId: string;
  /** Undefined means there is no active Turn selection to report. */
  selectedMcpServerIds?: readonly string[];
  roleMachineScope?: MachineId;
  machines(): Promise<MachineMeta[]>;
  onlineMachineIds(): Promise<ReadonlySet<MachineId> | null>;
  canAccess(machineId: MachineId, projectId?: string): Promise<boolean>;
  configs(machineId: MachineId): Promise<AgentConfigMeta[]>;
  capabilities(machineId: MachineId): Promise<Record<string, AcpCapabilityCacheEntry>>;
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
    const roles =
      resource === 'agent_role'
        ? (await source.roles()).filter(
            (role) => canReadAgentRole(role, source.userId) && (!id || role.id === id)
          )
        : [];
    const machines = await source.machines();
    const online = await source.onlineMachineIds();
    const authorized: MachineMeta[] = [];
    // Bound machine I/O: no workspace-wide Promise.all fan-out.
    for (const machine of machines) {
      if (query.machineId && machine.id !== query.machineId) continue;
      if (resource === 'agent_role' && !roles.some((role) => role.machineId === machine.id))
        continue;
      if (await source.canAccess(machine.id)) authorized.push(machine);
    }
    const status = (machineId: MachineId) =>
      online === null ? 'unknown' : online.has(machineId) ? 'online' : 'offline';
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
    for (const machine of authorized) {
      for (const config of await source.configs(machine.id)) configs.set(config.id, config);
      for (const [key, capability] of Object.entries(await source.capabilities(machine.id)))
        capabilities.set(`${machine.id}:${key}`, capability);
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
        return {
          ...summarizeDiscoveryAgent(config, capability),
          availability: availability(config.machineId),
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
      const permission = capability?.configOptions?.find(
        (option) => option.id === '_permission' || option.category === 'mode'
      );
      const modeId = role.runConfig.modeId ?? role.runConfig.configOptionValues?._permission;
      if (
        state.state === 'available' &&
        capability &&
        modeId &&
        !(permission
          ? permission.options.some((option) => option.value === modeId)
          : capability.modes.some((mode) => mode.id === modeId))
      )
        state = { state: 'unavailable', reason: 'mode_unavailable' };
      if (
        state.state === 'available' &&
        source.roleMachineScope &&
        role.machineId !== source.roleMachineScope
      )
        state = { state: 'unavailable', reason: 'outside_work_context' };
      return {
        id: role.id,
        name: role.name,
        description: role.description ?? '',
        machineId: role.machineId,
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
    return {
      ok: true as const,
      workspaceId: this.source.workspaceId,
      ...discoveryPage(
        rows,
        query,
        JSON.stringify([resource, this.source.workspaceId, this.source.userId]),
        (row) => JSON.stringify([row.kind ?? resource, row.machineId ?? '', row.id])
      ),
    };
  }

  async get(resource: 'agent_config' | 'agent_role', id: string) {
    const row = (await this.rows(resource, {}, id)).find((candidate) => candidate.id === id);
    if (!row) throw new Error('RESOURCE_NOT_FOUND: resource does not exist or is not readable.');
    return { ok: true as const, workspaceId: this.source.workspaceId, item: row };
  }
}
