import type { AgentConfigId } from './ids';

export const RATE_LIMIT_ENTRY_KEY_SEPARATOR = '::';
const PROVIDER_RATE_LIMIT_ENTRY_KEY_PREFIX = 'provider';

/**
 * Known limitId values used to distinguish rate limit tiers.
 * - `codex`: standard Codex limit
 * - `codex_bengalfox`: Codex Spark limit
 */
export const CODEX_SPARK_LIMIT_ID = 'codex_bengalfox';

export const getRateLimitEntryKey = (
  cliType: string,
  limitId: string | null | undefined,
  agentConfigId?: AgentConfigId | null
): string => {
  const id = limitId?.trim() || cliType;
  if (agentConfigId) {
    return [
      PROVIDER_RATE_LIMIT_ENTRY_KEY_PREFIX,
      encodeURIComponent(agentConfigId),
      encodeURIComponent(cliType),
      encodeURIComponent(id),
    ].join(RATE_LIMIT_ENTRY_KEY_SEPARATOR);
  }
  return `${cliType}${RATE_LIMIT_ENTRY_KEY_SEPARATOR}${id}`;
};

export const parseRateLimitEntryKey = (
  key: string
): {
  agentConfigId: AgentConfigId | null;
  cliType: string;
  limitId: string | null;
} => {
  const parts = key.split(RATE_LIMIT_ENTRY_KEY_SEPARATOR);
  if (
    parts.length === 4 &&
    parts[0] === PROVIDER_RATE_LIMIT_ENTRY_KEY_PREFIX &&
    parts[1] &&
    parts[2] &&
    parts[3]
  ) {
    try {
      return {
        agentConfigId: decodeURIComponent(parts[1]) as AgentConfigId,
        cliType: decodeURIComponent(parts[2]),
        limitId: decodeURIComponent(parts[3]),
      };
    } catch {
      // Malformed scoped keys stay unreadable rather than being attributed to
      // an unrelated provider through the legacy parser below.
      return { agentConfigId: null, cliType: '', limitId: null };
    }
  }

  const separatorIndex = key.indexOf(RATE_LIMIT_ENTRY_KEY_SEPARATOR);
  if (separatorIndex === -1) {
    return {
      agentConfigId: null,
      cliType: key,
      limitId: null,
    };
  }

  const cliType = key.slice(0, separatorIndex);
  const limitId = key.slice(separatorIndex + RATE_LIMIT_ENTRY_KEY_SEPARATOR.length);
  if (!limitId) {
    return {
      agentConfigId: null,
      cliType,
      limitId: null,
    };
  }

  return {
    agentConfigId: null,
    cliType,
    limitId,
  };
};
