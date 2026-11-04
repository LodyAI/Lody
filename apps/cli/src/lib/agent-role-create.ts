import {
  bindAgentRoleTarget,
  getAgentRoleTargets,
  getWorkspaceFlockDocId,
  isMultiTargetAgentRole,
  listWorkspaceAgentRoles,
  readWorkspaceFlockRowsFromFlock,
  snapshotAgentRole,
  type AgentRole,
  type MachineId,
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

const formatAgentRoleTargets = (role: AgentRole): string =>
  getAgentRoleTargets(role)
    .map((target) => (target.alias ? `${target.machineId} (${target.alias})` : target.machineId))
    .join(', ');

/**
 * The Role bound to the machine that will run it.
 *
 * A selector may be a Role id, its unique name, or one target's alias, which
 * names the machine by itself. A Role on several machines otherwise needs
 * `machineId`: nothing picks one of its targets on the caller's behalf. For a
 * single-target Role the machine must match, unless the caller treats it as an
 * overridden flag (`ignoreForSingleTarget`, the CLI's `--machine`).
 */
export const selectAgentRoleTarget = (
  roles: readonly AgentRole[],
  selector: string,
  machine?: { machineId?: string; ignoreForSingleTarget?: boolean }
): AgentRole => {
  const normalizedSelector = normalizeCliValue(selector);
  const machineId = normalizeCliValue(machine?.machineId);
  const aliasMatches = roles.flatMap((role) =>
    getAgentRoleTargets(role)
      .filter((target) => target.alias && normalizeCliValue(target.alias) === normalizedSelector)
      .map((target) => ({ role, target }))
  );
  const [onlyAlias] = aliasMatches;
  const isIdOrName = roles.some(
    (role) => role.id === normalizedSelector || normalizeCliValue(role.name) === normalizedSelector
  );
  if (!isIdOrName && aliasMatches.length === 1 && onlyAlias) {
    if (!machineId || machineId === onlyAlias.target.machineId) {
      const bound = bindAgentRoleTarget(onlyAlias.role, onlyAlias.target.machineId);
      if (bound) return bound;
    }
  }
  const role = selectUniqueAgentRoleByIdOrName(roles, selector);
  if (!isMultiTargetAgentRole(role) && (!machineId || machine?.ignoreForSingleTarget)) return role;
  if (!machineId) {
    throw new Error(
      `Agent Role ${role.name} (${role.id}) runs on several machines; name one. Machines: ${formatAgentRoleTargets(role)}`
    );
  }
  const bound = bindAgentRoleTarget(role, machineId as MachineId);
  if (!bound) {
    throw new Error(
      `Agent Role ${role.name} (${role.id}) does not run on machine ${machineId}. Machines: ${formatAgentRoleTargets(role)}`
    );
  }
  return bound;
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
  // The Role instruction travels in CreateOptions (see bindAgentRoleCreateOptions)
  // so the user turn shows only the authored prompt.
  prompt: args.prompt,
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
  // `--machine` picks the target of a Role on several machines; for a
  // single-target Role it stays an ignored override, as before.
  const role = selectAgentRoleTarget([...catalog.values()], args.selector, {
    machineId: args.overrides?.machine,
    ignoreForSingleTarget: true,
  });
  return resolveAgentRoleCreate({
    role,
    prompt: args.prompt,
    overrides: isMultiTargetAgentRole(role)
      ? { ...args.overrides, machine: undefined }
      : args.overrides,
  });
};

export const bindAgentRoleCreateOptions = (
  options: CreateOptions,
  role: AgentRole | undefined
): void => {
  if (!role) return;
  options.agentRoleId = role.id;
  options.agentRoleRevision = role.revision;
  options.agentRoleSnapshot = snapshotAgentRole(role);
  const promptPrefix = role.promptPrefix?.trim();
  if (promptPrefix) options.agentRolePromptPrefix = promptPrefix;
  else delete options.agentRolePromptPrefix;
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
