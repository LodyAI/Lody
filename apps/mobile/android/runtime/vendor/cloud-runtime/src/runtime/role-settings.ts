import { Flock } from '@loro-dev/flock-wasm/base64';
import type {
  AgentRoleItem,
  AgentRoleRequest,
  AgentRoleSnapshot,
  RoleAgent,
} from '../models/agent-roles';
import {
  DEFAULT_ROLE_EMOJI,
  readRole,
  readableRole,
  record,
  roleRunConfig,
  roleSlug,
} from '../protocol/agent-roles';
import { encodeFrame } from '../frames';
import { openSettings } from './settings';
import { creationOptions } from './create-session';
import { clientFor } from './session';

export function roleSnapshot(
  flock: Flock,
  userId: string,
  meta: Flock,
  machines: Map<string, Flock>,
): AgentRoleSnapshot {
  const agents: RoleAgent[] = creationOptions(undefined, meta, machines).agents;
  const roles: AgentRoleItem[] = [];
  for (const row of flock.scan()) {
    if (row.key.length !== 2 || row.key[0] !== 'agentRole') continue;
    const role = readRole(row.value, row.key[1]);
    if (!role || !readableRole(role, userId)) continue;
    roles.push({
      id: role.id,
      ownerUserId: role.ownerUserId,
      visibility: role.visibility,
      name: role.name,
      description: role.description ?? '',
      promptPrefix: role.promptPrefix ?? '',
      emoji: role.emoji ?? DEFAULT_ROLE_EMOJI,
      revision: role.revision,
      updatedAt: role.updatedAt,
      targets: role.targets.map((target) => {
        const agent = agents.find(
          (agent) =>
            agent.machineId === target.machineId &&
            agent.id === target.agentConfigId,
        );
        let state: AgentRoleItem['targets'][number]['state'] = 'configured';
        if (!machines.has(target.machineId)) state = 'machineUnavailable';
        else if (!agent) state = 'agentUnavailable';
        // Memory stays out of the listing; the runtime applies it when the Role runs.
        const { memory: _memory, ...pinned } = roleRunConfig(target.runConfig);
        return {
          machineId: target.machineId,
          agentConfigId: target.agentConfigId,
          ...(target.alias ? { alias: target.alias } : {}),
          ...(Object.keys(pinned).length ? { runConfig: pinned } : {}),
          machineName: agent?.machineName ?? target.machineId,
          agentName: agent?.name ?? target.agentConfigId,
          state,
        };
      }),
    });
  }
  return {
    roles: roles.sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    ),
    agents,
  };
}

export async function roleSettings(
  request: AgentRoleRequest,
  userId: string,
  meta: Flock,
  machines: Map<string, Flock>,
  grant: Parameters<typeof openSettings>[1],
  signal: AbortSignal,
  checkScope: () => void = () => {},
) {
  if (!userId || !['list', 'save', 'delete'].includes(request.action))
    throw new Error('role_invalid');
  checkScope();
  const stream = `${request.workspaceId}:wf:workspace`;
  let replica;
  let missing = false;
  try {
    replica = await openSettings(stream, grant, signal);
  } catch (error) {
    if (error instanceof Error && error.message === 'forbidden')
      throw new Error('role_forbidden');
    if (!(error instanceof Error) || error.message !== 'not_found') throw error;
    if (
      request.action !== 'list' &&
      (request.action !== 'save' || request.base !== null)
    )
      throw new Error('role_conflict');
    replica = {
      flock: new Flock(`lody-ios-roles-${crypto.randomUUID()}`),
      client: await clientFor(stream, grant),
    };
    missing = true;
  }
  const { flock, client } = replica;
  checkScope();
  const snapshot = () => roleSnapshot(flock, userId, meta, machines);
  const before = snapshot();
  if (request.action === 'list') return before;
  const base = request.base;
  const id = request.action === 'save' ? request.id : base?.id;
  if (
    typeof id !== 'string' ||
    !id ||
    /[\s@\x00-\x1f\x7f]/.test(id) ||
    id.length > 4096
  )
    throw new Error('role_invalid');
  const key = ['agentRole', id];
  const raw = flock.get(key);
  const current = before.roles.find((role) => role.id === id);
  if (base) {
    if (!current || current.ownerUserId !== userId || base.id !== id)
      throw new Error('role_read_only');
    const fields = [
      'name',
      'description',
      'promptPrefix',
      'visibility',
      'ownerUserId',
      'revision',
      'updatedAt',
    ] as const;
    const targets = (value: AgentRoleItem) =>
      value.targets.map((target) => [
        target.machineId,
        target.agentConfigId,
        target.alias ?? '',
      ]);
    if (
      !Array.isArray(base.targets) ||
      !base.targets.every(record) ||
      fields.some((field) => current[field] !== base[field]) ||
      JSON.stringify(targets(current)) !== JSON.stringify(targets(base))
    )
      throw new Error('role_conflict');
  } else if (raw !== undefined) throw new Error('role_conflict');
  const version = flock.version();
  if (request.action === 'delete') {
    if (!base) throw new Error('role_invalid');
    flock.delete(key);
  } else {
    const fields = request.fields;
    if (
      !record(fields) ||
      typeof fields.name !== 'string' ||
      !roleSlug(fields.name) ||
      Array.from(fields.name.trim()).length > 60 ||
      /[\x00-\x1f\x7f]/.test(fields.name) ||
      typeof fields.description !== 'string' ||
      Array.from(fields.description).length > 140 ||
      typeof fields.promptPrefix !== 'string' ||
      fields.promptPrefix.length > 32000 ||
      fields.promptPrefix.includes('\0') ||
      !['private', 'workspace'].includes(fields.visibility)
    )
      throw new Error('role_invalid');
    const slug = roleSlug(fields.name);
    if (
      before.roles.some(
        (role) =>
          role.id !== id &&
          [role.name, ...role.targets.map((t) => t.alias ?? '')].some(
            (label) => roleSlug(label) === slug,
          ),
      ) ||
      current?.targets.some(
        (target) => !!target.alias && roleSlug(target.alias) === slug,
      )
    )
      throw new Error('role_duplicate');
    let value: Record<string, unknown>;
    if (base && record(raw)) value = { ...raw };
    else {
      // shortcut: Mobile creates one target with Agent defaults; richer target/run editing stays on desktop.
      const agent = before.agents.find(
        (agent) =>
          agent.id === request.target?.agentConfigId &&
          agent.machineId === request.target?.machineId,
      );
      if (!agent) throw new Error('role_target_unavailable');
      value = {
        v: 1,
        id,
        ownerUserId: userId,
        createdAt: Date.now(),
        machineId: agent.machineId,
        agentConfigId: agent.id,
        runConfig: {},
      };
    }
    const name = fields.name.trim(),
      description = fields.description,
      promptPrefix = fields.promptPrefix.trim();
    if (
      current &&
      current.name === name &&
      current.description === description &&
      current.promptPrefix === promptPrefix &&
      current.visibility === fields.visibility
    )
      return snapshot();
    Object.assign(value, {
      name,
      description,
      promptPrefix,
      visibility: fields.visibility,
      revision: (current?.revision ?? 0) + 1,
      updatedAt: Date.now(),
    });
    flock.set(key, value as Parameters<Flock['set']>[1]);
  }
  flock.commit();
  signal.throwIfAborted();
  checkScope();
  let saved;
  try {
    if (missing) {
      const created = await client.create({
        contentType: 'application/octet-stream',
      });
      if (!created.ok)
        throw new Error(
          created.result.code === 'forbidden'
            ? 'role_forbidden'
            : 'role_write_unknown',
        );
      signal.throwIfAborted();
      checkScope();
    }
    saved = await client.append({
      part: {
        contentType: 'application/octet-stream',
        body: encodeFrame(
          new TextEncoder().encode(JSON.stringify(flock.exportJson(version))),
        ),
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'role_forbidden')
      throw error;
    throw new Error('role_write_unknown');
  }
  if (!saved.ok)
    throw new Error(
      saved.result.code === 'forbidden'
        ? 'role_forbidden'
        : 'role_write_unknown',
    );
  checkScope();
  return snapshot();
}
