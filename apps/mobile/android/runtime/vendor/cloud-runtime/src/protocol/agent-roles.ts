// LodyAI/Lody a15cdae: agent-role.ts v1 inline / v2 targets wire shapes.
// Keep the stored row intact: mobile edits shared metadata, not run configuration.
type RecordValue = Record<string, unknown>;
export const record = (value: unknown): value is RecordValue =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const label = (value: unknown): value is string =>
  typeof value === 'string' &&
  !!value.trim() &&
  value.length <= 4096 &&
  !/[\x00-\x1f\x7f]/.test(value);
const identifier = (value: unknown): value is string =>
  label(value) && !/[\s@]/.test(value);
const runConfig = (value: unknown) => {
  if (value === undefined) return true;
  if (!record(value)) return false;
  const memory = value.memory;
  return (
    memory === undefined ||
    (record(memory) &&
      Object.keys(memory).every((key) =>
        ['providerId', 'memoryId'].includes(key),
      ) &&
      typeof memory.providerId === 'string' &&
      !!memory.providerId.trim() &&
      memory.providerId.length <= 100 &&
      typeof memory.memoryId === 'string' &&
      !!memory.memoryId.trim() &&
      memory.memoryId.length <= 200)
  );
};
export const roleSlug = (value: string) =>
  Array.from(
    value
      .trim()
      .replace(/^@+/u, '')
      .replace(/\p{Cc}/gu, '')
      .replace(/\s+/gu, '-')
      .replace(/-{2,}/gu, '-')
      .replace(/^-+|-+$/gu, ''),
  )
    .slice(0, 40)
    .join('');
export type StoredTarget = {
  machineId: string;
  agentConfigId: string;
  alias?: string;
  runConfig?: RecordValue;
};
export type StoredRole = {
  id: string;
  ownerUserId: string;
  visibility: 'private' | 'workspace';
  name: string;
  description?: string;
  promptPrefix?: string;
  emoji?: string;
  revision: number;
  updatedAt: number;
  targets: StoredTarget[];
};
export function readRole(value: unknown, id: unknown): StoredRole | undefined {
  if (
    !record(value) ||
    !identifier(id) ||
    value.id !== id ||
    !identifier(value.ownerUserId) ||
    !label(value.name) ||
    !roleSlug(value.name) ||
    !['private', 'workspace'].includes(String(value.visibility)) ||
    typeof value.revision !== 'number' ||
    !Number.isFinite(value.revision) ||
    typeof value.createdAt !== 'number' ||
    !Number.isFinite(value.createdAt) ||
    typeof value.updatedAt !== 'number' ||
    !Number.isFinite(value.updatedAt) ||
    (value.emoji !== undefined && typeof value.emoji !== 'string') ||
    (value.description !== undefined &&
      typeof value.description !== 'string') ||
    (value.promptPrefix !== undefined && typeof value.promptPrefix !== 'string')
  )
    return;
  let targets: unknown[];
  if (value.v === 2 && Array.isArray(value.targets)) targets = value.targets;
  else if (
    value.v === 1 &&
    (value.additionalTargets === undefined ||
      Array.isArray(value.additionalTargets))
  )
    targets = [value, ...((value.additionalTargets as unknown[]) ?? [])];
  else return;
  if (
    !targets.length ||
    targets.length > 64 ||
    targets.some(
      (target) =>
        !record(target) ||
        !identifier(target.machineId) ||
        !identifier(target.agentConfigId) ||
        (target.alias !== undefined && typeof target.alias !== 'string') ||
        !runConfig(target.runConfig),
    )
  )
    return;
  const unique = new Map<string, StoredTarget>();
  for (const target of targets as StoredTarget[])
    if (!unique.has(target.machineId)) {
      const alias = Array.from(target.alias?.trim() ?? '')
        .slice(0, 60)
        .join('');
      unique.set(target.machineId, {
        ...target,
        alias: roleSlug(alias) ? alias : undefined,
      });
    }
  return {
    id,
    ownerUserId: value.ownerUserId,
    visibility: value.visibility as StoredRole['visibility'],
    name: value.name.trim(),
    description: value.description as string | undefined,
    promptPrefix: (value.promptPrefix as string | undefined)?.trim(),
    emoji: roleEmoji(value.emoji),
    revision: Math.max(1, Math.trunc(value.revision)),
    updatedAt: value.updatedAt,
    targets: [...unique.values()],
  };
}
export const readableRole = (role: StoredRole, userId: string) =>
  !!userId && (role.ownerUserId === userId || role.visibility === 'workspace');

// Web `DEFAULT_AGENT_ROLE_EMOJI` / `normalizeAgentRoleEmoji`: one short glyph, no
// whitespace or control characters; a Role without one reads as the default.
export const DEFAULT_ROLE_EMOJI = '🪼';
export function roleEmoji(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const glyph = Array.from(value.replace(/\p{Cc}/gu, '').replace(/\s+/gu, ''))
    .slice(0, 8)
    .join('');
  return glyph || undefined;
}

// Web `isSensitiveAgentRoleConfigOptionKey`, applied on read as well as on write:
// a Role is a replicated row, so secret-shaped option keys never reach a turn.
const SENSITIVE_OPTION =
  /(?:api[_-]?key|auth|bearer|credential|password|passwd|secret|token)/i;
const SENSITIVE_ROLE_OPTION = /(?:\bkey\b|cookie|session[_-]?id|private)/i;
export const sensitiveRoleOption = (key: string) =>
  SENSITIVE_OPTION.test(key) || SENSITIVE_ROLE_OPTION.test(key);

export type RoleRunConfig = {
  modelId?: string;
  modeId?: string;
  configOptionValues?: Record<string, string | boolean>;
  memory?: { providerId: string; memoryId: string };
};

/** Web `normalizeAgentRoleRunConfig`: what one target pins, trimmed and filtered. */
export function roleRunConfig(value: unknown): RoleRunConfig {
  if (!record(value)) return {};
  const modelId = typeof value.modelId === 'string' ? value.modelId.trim() : '';
  const modeId = typeof value.modeId === 'string' ? value.modeId.trim() : '';
  const options: Record<string, string | boolean> = {};
  if (record(value.configOptionValues))
    for (const [raw, entry] of Object.entries(value.configOptionValues)) {
      const key = raw.trim();
      if (!key || sensitiveRoleOption(key)) continue;
      if (typeof entry === 'string' || typeof entry === 'boolean')
        options[key] = entry;
    }
  const memory = record(value.memory) ? value.memory : undefined;
  return {
    ...(modelId ? { modelId } : {}),
    ...(modeId ? { modeId } : {}),
    ...(Object.keys(options).length ? { configOptionValues: options } : {}),
    ...(memory &&
    typeof memory.providerId === 'string' &&
    typeof memory.memoryId === 'string'
      ? {
          memory: { providerId: memory.providerId, memoryId: memory.memoryId },
        }
      : {}),
  };
}

/**
 * Web `isAgentRoleRunConfigApplied`: every value the Role PINS is what will run.
 * Unpinned values are the agent's own; independent Plan toggles (`plan_mode`, a
 * plan/default `collaboration_mode`) are per-turn overrides that keep the Role.
 */
export function roleRunConfigApplied(
  pinned: RoleRunConfig,
  selection: {
    modelId?: string | null;
    modeId?: string | null;
    configOptionValues?: Record<string, unknown>;
  },
): boolean {
  if (pinned.modeId && selection.modeId !== pinned.modeId) return false;
  if (pinned.modelId && selection.modelId !== pinned.modelId) return false;
  const plan = (value: unknown) => value === 'plan' || value === 'default';
  for (const [key, value] of Object.entries(pinned.configOptionValues ?? {})) {
    const selected = selection.configOptionValues?.[key];
    if (
      key === 'plan_mode' &&
      typeof value === 'boolean' &&
      typeof selected === 'boolean'
    )
      continue;
    if (key === 'collaboration_mode' && plan(value) && plan(selected)) continue;
    if (selected !== value) return false;
  }
  return true;
}
