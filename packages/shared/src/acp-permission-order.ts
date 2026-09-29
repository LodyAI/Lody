import { isAcpPlanModeConfigOption } from './acp-run-config';
import type { AcpConfigOptionValue } from './ai';
import { normalizeSessionTurnInputConfig } from './message-schemas';

/**
 * How far each built-in agent's permission modes let the agent act without a
 * human, used to decide whether the mode an agent ended up in is wider than the
 * one requested. The UI's `classifyPermissionModeFace` only decides how a button
 * looks and is not an ordering.
 *
 * Only built-in agents are ranked: a third-party mode id or description carries
 * no general permission meaning, so its modes are never "restrictive" and never
 * comparable. Two different modes with the same rank are not comparable either
 * (Claude `acceptEdits` and `auto` widen different things).
 */
type PermissionModeRank = { rank: number; restrictive?: true };

const BUILTIN_PERMISSION_MODE_RANKS: Record<string, Record<string, PermissionModeRank>> = {
  claude: {
    plan: { rank: 0, restrictive: true },
    default: { rank: 1 },
    // Denies anything not pre-approved instead of asking: never wider than default.
    dontAsk: { rank: 1 },
    acceptEdits: { rank: 2 },
    auto: { rank: 2 },
    bypassPermissions: { rank: 3 },
  },
  codex: {
    'read-only': { rank: 0, restrictive: true },
    agent: { rank: 1 },
    'agent-auto-review': { rank: 2 },
    'agent-full-access': { rank: 3 },
    'danger-full-access': { rank: 3 },
  },
};

export type PermissionModeComparison = 'same' | 'narrower' | 'wider' | 'incomparable';

const rankOf = (
  agent: { cliType?: string | null; agentType?: string | null },
  modeId: string
): PermissionModeRank | undefined =>
  agent.cliType === 'builtin' && agent.agentType
    ? BUILTIN_PERMISSION_MODE_RANKS[agent.agentType]?.[modeId]
    : undefined;

/** Whether requesting this mode promises the user a restricted (read-only or plan) turn. */
export const isRestrictivePermissionMode = (
  agent: { cliType?: string | null; agentType?: string | null },
  modeId: string
): boolean => rankOf(agent, modeId)?.restrictive === true;

/** How the mode an agent ended up in relates to the requested one. */
export const comparePermissionModes = (
  agent: { cliType?: string | null; agentType?: string | null },
  requested: string,
  actual: string
): PermissionModeComparison => {
  if (requested === actual) return 'same';
  const requestedRank = rankOf(agent, requested);
  const actualRank = rankOf(agent, actual);
  if (!requestedRank || !actualRank || requestedRank.rank === actualRank.rank) {
    return 'incomparable';
  }
  return actualRank.rank < requestedRank.rank ? 'narrower' : 'wider';
};

/**
 * The permission mode and Plan setting in force for a turn. Turn configs are
 * sparse, so a turn that omits one still runs under the latest turn that set
 * it; each field is resolved separately because Plan is independent of
 * permission. An explicit Plan `false` is kept: it means off, not unset.
 */
export type SessionSafetyIntent = {
  modeId?: string;
  plan?: { configId: string; value: AcpConfigOptionValue };
};

/**
 * Resolves the safety intent up to and including `uptoUserTurnId` from history
 * directory rows (which carry each turn's input config without its body).
 * Later rows, such as queued turns, never leak into an earlier turn.
 */
export const resolveSessionSafetyIntent = (
  rows: readonly { readonly turnId?: string; readonly inputConfig?: unknown }[],
  uptoUserTurnId: string | undefined
): SessionSafetyIntent => {
  const intent: SessionSafetyIntent = {};
  for (const row of rows) {
    const config = normalizeSessionTurnInputConfig(row.inputConfig);
    if (config?.modeId) intent.modeId = config.modeId;
    for (const [configId, value] of Object.entries(config?.configOptionValues ?? {})) {
      if (isAcpPlanModeConfigOption({ id: configId })) intent.plan = { configId, value };
    }
    if (uptoUserTurnId !== undefined && row.turnId === uptoUserTurnId) break;
  }
  return intent;
};
