import type { Flock } from '@loro-dev/flock-wasm/base64';
import type { MentionCatalog, MentionItem } from '../models/mentions';
import { openSettings } from './settings';
import {
  DEFAULT_ROLE_EMOJI,
  readRole,
  readableRole,
  roleRunConfig,
  type RoleRunConfig,
} from '../protocol/agent-roles';
import type { MachinePresence } from '../models/machines';

// Shared workspace catalog owner for Role consumers. Authorization is checked
// from the fresh row on every read; the UI never supplies Role instructions.
export async function workspaceRoleMentions(
  workspaceId: string,
  userId: string,
  machines: Map<string, Flock>,
  getGrant: Parameters<typeof openSettings>[1],
  getPresence: () => MachinePresence,
  machineNames: Record<string, string> = {},
): Promise<MentionCatalog> {
  const { flock } = await openSettings(
    `${workspaceId}:wf:workspace`,
    getGrant,
    AbortSignal.timeout(30000),
  );
  return roleMentions(
    flock.scan(),
    userId,
    machines,
    getPresence(),
    machineNames,
  );
}

export function roleMentions(
  rows: { key: unknown[]; value?: unknown }[],
  userId: string,
  machines: Map<string, Pick<Flock, 'get'>>,
  presence: MachinePresence,
  machineNames: Record<string, string> = {},
): MentionCatalog {
  if (presence.state !== 'live')
    return { items: [], truncated: false, incomplete: true };
  const items: MentionItem[] = [];
  for (const row of rows) {
    if (
      row.key.length !== 2 ||
      row.key[0] !== 'agentRole' ||
      !row.value ||
      typeof row.value !== 'object'
    )
      continue;
    const role = readRole(row.value, row.key[1]);
    if (!role || !readableRole(role, userId)) continue;
    for (const target of role.targets) {
      if (!presence.onlineMachineIds.includes(target.machineId)) continue;
      const agent = machines
        .get(target.machineId)
        ?.get(['agentConfig', target.agentConfigId]) as
        Record<string, unknown> | undefined;
      if (
        !agent ||
        agent.id !== target.agentConfigId ||
        agent.machineId !== target.machineId
      )
        continue;
      const multi = role.targets.length > 1;
      const path = multi ? `${role.id}@${target.machineId}` : role.id;
      let name = role.name;
      // Like web, a multi-machine target reads by the computer's name, never its id.
      if (multi)
        name =
          target.alias ||
          `${role.name} · ${machineNames[target.machineId] || '未命名电脑'}`;
      items.push({
        path,
        name,
        roleName: role.name,
        emoji: role.emoji ?? DEFAULT_ROLE_EMOJI,
        kind: 'role',
        subtitle: role.description?.slice(0, 140) || String(agent.name ?? ''),
        insertText: `@role:${path}`,
      });
    }
  }
  items.sort(
    (a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path),
  );
  return { items, truncated: false, incomplete: false };
}

/** A Role as one session's first turn runs it (web `bindAgentRoleTarget` + snapshot). */
export type TurnRole = {
  id: string;
  revision: number;
  name: string;
  emoji: string;
  promptPrefix: string;
  runConfig: RoleRunConfig;
};

/**
 * Resolve a Role for a session's first turn from the fresh workspace row, never
 * from anything the UI supplies: it must be readable by this user and bound, on
 * the session's machine, to exactly the session's Agent Config. A Role never
 * falls back to another target or config (web `bindAgentRoleTarget`).
 */
export async function resolveTurnRole(
  args: {
    workspaceId: string;
    roleId: string;
    userId: string;
    machineId: string;
    agentConfigId: string;
  },
  getGrant: Parameters<typeof openSettings>[1],
  signal: AbortSignal,
  open: typeof openSettings = openSettings,
): Promise<TurnRole> {
  const { flock } = await open(
    `${args.workspaceId}:wf:workspace`,
    getGrant,
    signal,
  );
  return bindTurnRole(flock.get(['agentRole', args.roleId]), args);
}

export function bindTurnRole(
  row: unknown,
  args: {
    roleId: string;
    userId: string;
    machineId: string;
    agentConfigId: string;
  },
): TurnRole {
  const role = readRole(row, args.roleId);
  if (!role || !readableRole(role, args.userId))
    throw new Error('role_unavailable');
  const target = role.targets.find(
    (entry) => entry.machineId === args.machineId,
  );
  if (!target || target.agentConfigId !== args.agentConfigId)
    throw new Error('role_unavailable');
  return {
    id: role.id,
    revision: role.revision,
    name: role.name,
    emoji: role.emoji ?? DEFAULT_ROLE_EMOJI,
    promptPrefix: role.promptPrefix ?? '',
    runConfig: roleRunConfig(target.runConfig),
  };
}
