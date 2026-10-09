import {
  getWorkspaceFlockDocId,
  listWorkspaceAgentRoles,
  readWorkspaceFlockRowsFromFlock,
  snapshotAgentRole,
  type AgentRole,
  type WorkspaceId,
} from '@lody/shared';
import { normalizeCliValue } from '@/lib/command-runtime';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import type { CreateOptions, ResolvedTurnDispatchConfig } from '@/commands/session';

/**
 * Agent Role resolution for session creation, shared by the MCP create tools
 * and the CLI `session create --agent-role` flag. The current catalog Role row
 * is authoritative for machine, agent config, run config and Prompt prefix;
 * manual overrides never influence the resolved target.
 */

export const composeAgentRolePrompt = (
  promptPrefix: string | undefined,
  prompt: string
): string => {
  const prefix = promptPrefix?.trim();
  return prefix ? `${prefix}\n\n${prompt}` : prompt;
};

export const loadWorkspaceAgentRoleCatalog = async (
  manager: LoroDocumentManager,
  workspaceId: WorkspaceId
): Promise<ReadonlyMap<string, AgentRole>> => {
  const docId = getWorkspaceFlockDocId(workspaceId);
  await manager.syncFlockDocOrThrow(docId, {
    timeoutMs: 10_000,
    reason: 'agent-role-catalog-read',
  });
  const handle = await manager.repo.openFlockDoc(docId);
  return new Map(
    listWorkspaceAgentRoles(readWorkspaceFlockRowsFromFlock(handle.flock)).map((role) => [
      role.id,
      role,
    ])
  );
};

const formatAgentRoleCandidates = (roles: readonly AgentRole[]): string =>
  roles
    .map((role) => `${role.name} (${role.id})`)
    .sort((left, right) => left.localeCompare(right))
    .join(', ');

export const selectUniqueAgentRoleByIdOrName = (
  roles: readonly AgentRole[],
  selector: string
): AgentRole => {
  const normalizedSelector = normalizeCliValue(selector);
  if (!normalizedSelector) {
    throw new Error('Missing Agent Role selector.');
  }

  const idMatch = roles.find((role) => role.id === normalizedSelector);
  if (idMatch) {
    return idMatch;
  }

  const nameMatches = roles.filter((role) => normalizeCliValue(role.name) === normalizedSelector);
  const [onlyNameMatch] = nameMatches;
  if (nameMatches.length === 1 && onlyNameMatch) {
    return onlyNameMatch;
  }
  if (nameMatches.length > 1) {
    throw new Error(
      `Agent Role selector is ambiguous: ${normalizedSelector}. Use an id instead. Candidates: ${formatAgentRoleCandidates(roles)}`
    );
  }

  throw new Error(
    `Agent Role not found: ${normalizedSelector}. Candidates: ${formatAgentRoleCandidates(roles)}`
  );
};

/** Manual create flags that an explicit Role replaces; their values are ignored. */
export type AgentRoleCreateOverrides = {
  machine?: string;
  agent?: string;
  agentConfig?: string;
  mode?: string;
  model?: string;
  configOption?: string[];
};

export const listIgnoredAgentRoleOverrides = (options: AgentRoleCreateOverrides): string[] => {
  const ignored: string[] = [];
  if (normalizeCliValue(options.machine)) {
    ignored.push('--machine');
  }
  if (normalizeCliValue(options.agent)) {
    ignored.push('--agent');
  }
  if (normalizeCliValue(options.agentConfig)) {
    ignored.push('--agent-config');
  }
  if (normalizeCliValue(options.mode)) {
    ignored.push('--mode');
  }
  if (normalizeCliValue(options.model)) {
    ignored.push('--model');
  }
  if (options.configOption && options.configOption.length > 0) {
    ignored.push('--config-option');
  }
  return ignored;
};

export type ResolvedAgentRoleCreate = {
  role: AgentRole;
  machineId: AgentRole['machineId'];
  agentConfigId: AgentRole['agentConfigId'];
  prompt: string;
  dispatchConfig: ResolvedTurnDispatchConfig;
  /** CLI flags whose values the Role overrides, in help-flag form (e.g. --model). */
  ignoredOverrides: string[];
};

export const resolveAgentRoleCreate = (args: {
  role: AgentRole;
  prompt: string;
  overrides?: AgentRoleCreateOverrides;
}): ResolvedAgentRoleCreate => ({
  role: args.role,
  machineId: args.role.machineId,
  agentConfigId: args.role.agentConfigId,
  prompt: composeAgentRolePrompt(args.role.promptPrefix, args.prompt),
  dispatchConfig: {
    ...args.role.runConfig,
    inheritSessionDefaults: false,
  },
  ignoredOverrides: listIgnoredAgentRoleOverrides(args.overrides ?? {}),
});

/** Resolve the CLI `--agent-role` selector (fixed id or unique name) against the workspace catalog. */
export const resolveAgentRoleCreateFromCatalog = async (args: {
  manager: LoroDocumentManager;
  workspaceId: WorkspaceId;
  selector: string;
  prompt: string;
  overrides?: AgentRoleCreateOverrides;
}): Promise<ResolvedAgentRoleCreate> => {
  const catalog = await loadWorkspaceAgentRoleCatalog(args.manager, args.workspaceId);
  const role = selectUniqueAgentRoleByIdOrName([...catalog.values()], args.selector);
  return resolveAgentRoleCreate({ role, prompt: args.prompt, overrides: args.overrides });
};

export const bindAgentRoleCreateOptions = (
  options: CreateOptions,
  role: AgentRole | undefined
): void => {
  if (!role) return;
  options.agentRoleId = role.id;
  options.agentRoleRevision = role.revision;
  options.agentRoleSnapshot = snapshotAgentRole(role);
};

/**
 * Make the Role the sole create target: manual machine/agent/run-config flags
 * are cleared so nothing downstream can observe the overridden values, and the
 * Role provenance is frozen onto the create options.
 */
export const applyAgentRoleCreateTarget = (
  options: CreateOptions,
  resolved: ResolvedAgentRoleCreate
): void => {
  options.machine = resolved.machineId;
  options.agentConfig = resolved.agentConfigId;
  delete options.agent;
  delete options.mode;
  delete options.model;
  options.configOption = [];
  bindAgentRoleCreateOptions(options, resolved.role);
};
