import type { AgentConfigId, AgentRoleId, MachineId } from './ids';
import { isSensitiveAcpConfigOptionId } from './session-preparation';

/**
 * Agent Role — a named, mentionable preset for *creating* a Session.
 *
 * A Role says how to USE an Agent Config (model, reasoning, run options, prompt
 * prefix); it is never a provider and never a running agent. That boundary is
 * the reason for most of the rules below:
 *
 * - No secrets. A workspace Flock row is replicated to every member's client,
 *   so `private` limits trusted UI discovery and editing; it is not transport
 *   or storage confidentiality, and MCP creation may resolve an explicit id.
 *   V1 therefore refuses to persist anything secret-shaped in the first place
 *   (`isSensitiveAgentRoleConfigOptionKey`), rather than pretending a private
 *   row is a safe place to put one.
 * - No silent fallback. `machineId + agentConfigId` bind the execution site
 *   exactly; when either is gone the Role stays in Settings marked unavailable
 *   with the precise reason, and never becomes a submittable mention.
 * - `id` is the stable identity. The mention token is DERIVED from the name and
 *   changes when the name does, so a mention range carries the id.
 */

export const AGENT_ROLE_VERSION = 1;

export type AgentRoleVisibility = 'private' | 'workspace';

/**
 * The non-sensitive half of a Session config: what the agent capability itself
 * advertises. Deliberately not `AcpConfigOptionValue`-typed against the ACP
 * module — a Role stores only the primitive shapes an option selector produces.
 */
export type AgentRoleRunConfig = {
  modeId?: string;
  modelId?: string;
  configOptionValues?: Record<string, string | boolean>;
};

export type AgentRole = {
  v: typeof AGENT_ROLE_VERSION;
  id: AgentRoleId;
  ownerUserId: string;
  visibility: AgentRoleVisibility;

  name: string;
  /** Optional single glyph shown before the name wherever the Role is listed. */
  emoji?: string;

  machineId: MachineId;
  agentConfigId: AgentConfigId;
  runConfig: AgentRoleRunConfig;
  promptPrefix?: string;

  /** Bumped on every effective edit; frozen when a create Operation accepts this Role. */
  revision: number;
  createdAt: number;
  updatedAt: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export const isAgentRoleVisibility = (value: unknown): value is AgentRoleVisibility =>
  value === 'private' || value === 'workspace';

// ---------------------------------------------------------------------------
// Name, emoji, and the mention token derived from them
// ---------------------------------------------------------------------------

/** Long enough to stay readable inline, short enough not to dominate a prompt. */
export const AGENT_ROLE_MENTION_SLUG_MAX_LENGTH = 40;
export const AGENT_ROLE_NAME_MAX_LENGTH = 60;
/**
 * A few code points: one emoji, including a ZWJ sequence or a skin-tone
 * modifier, without becoming a second name field.
 */
export const AGENT_ROLE_EMOJI_MAX_LENGTH = 8;

/**
 * The mention token for a Role, derived from its name.
 *
 * A Role has ONE authored label. An `@` token ends at the next whitespace, so
 * the token cannot simply be the name — but a second authored field ("name" and
 * "mention name") is two things to keep in sync for one concept, and the id is
 * what the range actually carries. So the token is computed, and renaming a
 * Role renames its mention.
 */
export const getAgentRoleMentionSlug = (role: Pick<AgentRole, 'name'>): string =>
  normalizeAgentRoleMentionSlug(role.name);

/**
 * Normalize a name into a token the composer can carry.
 *
 * Whitespace is the only thing that MUST go: an `@` token ends at the next
 * space, so a token containing one could never be recovered from a reloaded
 * draft. Everything else — including CJK — is kept so a Chinese Role name stays
 * readable. A leading `@` is dropped so pasting `@reviewer` works.
 */
export const normalizeAgentRoleMentionSlug = (value: string): string => {
  const collapsed = value
    .trim()
    .replace(/^@+/u, '')
    // Control characters would be invisible in the composer but still part of
    // the token, so a slug carrying one could never be typed back.
    .replace(/\p{Cc}/gu, '')
    .replace(/\s+/gu, '-')
    .replace(/-{2,}/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return Array.from(collapsed).slice(0, AGENT_ROLE_MENTION_SLUG_MAX_LENGTH).join('');
};

/**
 * The glyph a Role shows when its owner has not picked one.
 *
 * A real default rather than a blank slot: every Role then reads the same way in
 * the list and the mention menu, and the picker is a change rather than a
 * decision the user has to make before the Role looks finished.
 */
export const DEFAULT_AGENT_ROLE_EMOJI = '🪼';

export const getAgentRoleEmoji = (role: Pick<AgentRole, 'emoji'>): string =>
  role.emoji || DEFAULT_AGENT_ROLE_EMOJI;

/**
 * Keep an emoji to one short, whitespace-free glyph.
 *
 * Capped and stripped rather than validated against an emoji table: the field
 * is decoration, so the only real requirements are that it cannot smuggle a
 * second line of text into a row and cannot carry invisible characters.
 */
export const normalizeAgentRoleEmoji = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const stripped = value.replace(/\p{Cc}/gu, '').replace(/\s+/gu, '');
  const capped = Array.from(stripped).slice(0, AGENT_ROLE_EMOJI_MAX_LENGTH).join('');
  return capped || undefined;
};

// ---------------------------------------------------------------------------
// Run config
// ---------------------------------------------------------------------------

/**
 * Option keys a Role may never persist.
 *
 * The shared `isSensitiveAcpConfigOptionId` rule is the base so a Role refuses
 * exactly what session preparation already refuses to retain — one rule, not two
 * that drift. The extra names are Role-specific: a Role is a durable, possibly
 * workspace-shared row, so anything that looks like a stored identity belongs
 * in the Agent Config, not here.
 *
 * Applied on read as well as on write: an agent may publish a config option
 * with any id it likes, and a row written by an older client must not reach a
 * Session config just because it is already in the document.
 */
const EXTRA_SENSITIVE_ROLE_OPTION_KEY_PATTERN = /(?:\bkey\b|cookie|session[_-]?id|private)/i;

export const isSensitiveAgentRoleConfigOptionKey = (key: string): boolean =>
  isSensitiveAcpConfigOptionId(key) || EXTRA_SENSITIVE_ROLE_OPTION_KEY_PATTERN.test(key);

/**
 * Keep only the option values a Role is allowed to carry: primitive, non-empty
 * keys that are not secret-shaped. Returns `undefined` for an empty result so
 * callers can omit the field instead of persisting `{}`.
 */
export const normalizeAgentRoleConfigOptionValues = (
  value: unknown
): Record<string, string | boolean> | undefined => {
  if (!isRecord(value)) return undefined;
  const normalized: Record<string, string | boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    const trimmedKey = key.trim();
    if (!trimmedKey || isSensitiveAgentRoleConfigOptionKey(trimmedKey)) continue;
    if (typeof entry === 'boolean') {
      normalized[trimmedKey] = entry;
      continue;
    }
    if (typeof entry === 'string') {
      normalized[trimmedKey] = entry;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
};

export const normalizeAgentRoleRunConfig = (value: unknown): AgentRoleRunConfig => {
  if (!isRecord(value)) return {};
  const modeId = typeof value.modeId === 'string' ? value.modeId.trim() : '';
  const modelId = typeof value.modelId === 'string' ? value.modelId.trim() : '';
  const configOptionValues = normalizeAgentRoleConfigOptionValues(value.configOptionValues);
  return {
    ...(modeId ? { modeId } : {}),
    ...(modelId ? { modelId } : {}),
    ...(configOptionValues ? { configOptionValues } : {}),
  };
};

/**
 * Stable serialization of a run config, so two configs that differ only in the
 * order their option keys were authored in do not read as an edit — which would
 * bump `revision` even though the effective Role configuration is unchanged.
 */
const serializeRunConfig = (value: AgentRoleRunConfig): string => {
  const normalized = normalizeAgentRoleRunConfig(value);
  const options = Object.entries(normalized.configOptionValues ?? {}).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  return JSON.stringify([normalized.modeId ?? '', normalized.modelId ?? '', options]);
};

const runConfigsEqual = (left: AgentRoleRunConfig, right: AgentRoleRunConfig): boolean =>
  serializeRunConfig(left) === serializeRunConfig(right);

// ---------------------------------------------------------------------------
// Role validation
// ---------------------------------------------------------------------------

/**
 * Whether an untrusted value is a Role row.
 *
 * Flock rows arrive from whatever wrote them — an older client, a newer one, or
 * a hand-edited document — so nothing reads a Role without passing through
 * here first.
 */
export const isAgentRole = (value: unknown): value is AgentRole => {
  if (
    !isRecord(value) ||
    value.v !== AGENT_ROLE_VERSION ||
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.ownerUserId) ||
    !isAgentRoleVisibility(value.visibility) ||
    !isNonEmptyString(value.name) ||
    !isNonEmptyString(value.machineId) ||
    !isNonEmptyString(value.agentConfigId) ||
    !isFiniteNumber(value.revision) ||
    !isFiniteNumber(value.createdAt) ||
    !isFiniteNumber(value.updatedAt)
  ) {
    return false;
  }
  if (value.emoji !== undefined && typeof value.emoji !== 'string') return false;
  if (value.promptPrefix !== undefined && typeof value.promptPrefix !== 'string') return false;
  if (value.runConfig !== undefined && !isRecord(value.runConfig)) return false;
  // A name that normalizes to nothing (only punctuation the token strips) has no
  // mention token, so it could never be used for what a Role is for.
  return getAgentRoleMentionSlug({ name: value.name.trim() }).length > 0;
};

/**
 * Read a persisted Role into the shape the product uses.
 *
 * Normalizing on read rather than trusting the row is what keeps a secret-named
 * option written by an older or buggy client from reaching a Session config.
 */
export const normalizeAgentRole = (value: unknown): AgentRole | undefined => {
  if (!isAgentRole(value)) return undefined;
  const emoji = normalizeAgentRoleEmoji(value.emoji);
  const promptPrefix = value.promptPrefix?.trim();
  return {
    v: AGENT_ROLE_VERSION,
    id: value.id.trim() as AgentRoleId,
    ownerUserId: value.ownerUserId.trim(),
    visibility: value.visibility,
    name: value.name.trim(),
    ...(emoji ? { emoji } : {}),
    machineId: value.machineId.trim() as MachineId,
    agentConfigId: value.agentConfigId.trim() as AgentConfigId,
    runConfig: normalizeAgentRoleRunConfig(value.runConfig),
    ...(promptPrefix ? { promptPrefix } : {}),
    revision: Math.max(1, Math.trunc(value.revision)),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
};

/**
 * Whether two Roles differ in anything worth a new revision.
 *
 * `revision` is recorded as Session provenance and in accepted Operations, so a
 * write that changes nothing must not create a new revision.
 */
export const isAgentRoleContentEqual = (left: AgentRole, right: AgentRole): boolean =>
  left.name === right.name &&
  (left.emoji ?? '') === (right.emoji ?? '') &&
  left.visibility === right.visibility &&
  left.machineId === right.machineId &&
  left.agentConfigId === right.agentConfigId &&
  (left.promptPrefix ?? '') === (right.promptPrefix ?? '') &&
  runConfigsEqual(left.runConfig, right.runConfig);

// ---------------------------------------------------------------------------
// Visibility and ownership
// ---------------------------------------------------------------------------

/**
 * The authoritative trusted-UI discovery rule for Settings and the mention menu.
 */
export const canReadAgentRole = (role: AgentRole, userId: string | null | undefined): boolean =>
  role.visibility === 'workspace' || (Boolean(userId) && role.ownerUserId === userId);

/** V1: only the owner edits, shares, unshares, or deletes. */
export const canManageAgentRole = (role: AgentRole, userId: string | null | undefined): boolean =>
  Boolean(userId) && role.ownerUserId === userId;

export const listAccessibleAgentRoles = (
  roles: readonly AgentRole[],
  userId: string | null | undefined
): AgentRole[] => roles.filter((role) => canReadAgentRole(role, userId));

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export type AgentRoleUnavailableReason =
  | 'machine_unknown'
  | 'machine_offline'
  | 'agent_config_missing'
  | 'agent_config_machine_mismatch';

export type AgentRoleAvailability =
  | { kind: 'available' }
  /** The binding cannot be judged yet — that machine's configs are not loaded. */
  | { kind: 'unknown' }
  | { kind: 'unavailable'; reason: AgentRoleUnavailableReason };

export type AgentRoleAvailabilityContext = {
  /** Machines the current user may reach at all. */
  authorizedMachineIds: ReadonlySet<MachineId>;
  onlineMachineIds: ReadonlySet<MachineId>;
  /** Agent config id -> the machine it belongs to. */
  agentConfigMachineIds: ReadonlyMap<AgentConfigId, MachineId>;
  /**
   * Machines whose agent configs have actually been read. A machine outside
   * this set yields `unknown`, never `agent_config_missing`: reporting a Role
   * broken because its config list has not loaded is the same silent lie as
   * falling back to another config.
   */
  loadedAgentConfigMachineIds: ReadonlySet<MachineId>;
};

export const resolveAgentRoleAvailability = (
  role: AgentRole,
  context: AgentRoleAvailabilityContext
): AgentRoleAvailability => {
  if (!context.authorizedMachineIds.has(role.machineId)) {
    return { kind: 'unavailable', reason: 'machine_unknown' };
  }
  if (!context.loadedAgentConfigMachineIds.has(role.machineId)) {
    return { kind: 'unknown' };
  }
  const configMachineId = context.agentConfigMachineIds.get(role.agentConfigId);
  if (configMachineId === undefined) {
    return { kind: 'unavailable', reason: 'agent_config_missing' };
  }
  if (configMachineId !== role.machineId) {
    return { kind: 'unavailable', reason: 'agent_config_machine_mismatch' };
  }
  if (!context.onlineMachineIds.has(role.machineId)) {
    return { kind: 'unavailable', reason: 'machine_offline' };
  }
  return { kind: 'available' };
};

// ---------------------------------------------------------------------------
// Work-context scope
// ---------------------------------------------------------------------------

/**
 * Where the mentioned Role is allowed to run, given what the composer is
 * attached to.
 *
 * - `machine`: a Local Project, or a child Session that shares this physical
 *   workspace — the target has to be the same machine.
 * - `authorized_machines`: plain chat or a GitHub project whose target Session
 *   can clone the repo itself on another authorized machine.
 */
export type AgentRoleMentionScope =
  | { kind: 'machine'; machineId: MachineId | null }
  | { kind: 'authorized_machines'; machineIds: ReadonlySet<MachineId> };

export const isAgentRoleInMentionScope = (
  role: AgentRole,
  scope: AgentRoleMentionScope
): boolean =>
  scope.kind === 'machine'
    ? scope.machineId !== null && role.machineId === scope.machineId
    : scope.machineIds.has(role.machineId);

/**
 * The Roles a composer may execute: readable by this user, executable right now,
 * and inside the current work context.
 *
 * Order is visibility- and scope-independent so the menu stays stable: name
 * first, id as the tie-break.
 */
export const selectMentionableAgentRoles = (
  roles: readonly AgentRole[],
  options: {
    currentUserId: string | null | undefined;
    scope: AgentRoleMentionScope;
    getAvailability: (role: AgentRole) => AgentRoleAvailability;
  }
): AgentRole[] =>
  listAccessibleAgentRoles(roles, options.currentUserId)
    .filter(
      (role) =>
        isAgentRoleInMentionScope(role, options.scope) &&
        options.getAvailability(role).kind === 'available'
    )
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
