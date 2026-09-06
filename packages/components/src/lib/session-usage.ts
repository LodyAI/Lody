import {
  CODEX_SPARK_LIMIT_ID,
  normalizePersistedRateLimit,
  parseRateLimitEntryKey,
  resolveAgentBrandId,
  type AgentConfigCliType,
  type AgentConfigMeta,
  type MachineViewMeta,
  type SessionContextWindowUsage,
} from '@lody/shared';
import { clamp } from './clamp';
import type { TFunction } from 'i18next';

export const FIVE_HOUR_WINDOW_SECONDS = 5 * 60 * 60;
export const SEVEN_DAY_WINDOW_SECONDS = 7 * 24 * 60 * 60;

export type MachineRateLimits = MachineViewMeta['raceLimits'];
export type MachineRateLimitUsage = MachineRateLimits[string];

export type AgentRateLimitEntry = {
  key: string;
  limits: MachineRateLimitUsage;
  cliType: string;
  limitId: string | null;
};

export type ContextWindowUsageData = {
  usedTokens: number;
  remainingTokens: number;
  contextWindow: number;
  usedPercentage: number;
  remainingPercentage: number;
};

export type AgentRateLimitWindow = {
  label?: string;
  usedPercent: number;
  remainingPercent: number;
  windowDurationSeconds: number | null;
  resetsAtEpochSeconds: number | null;
};

const clampPercentage = (value: number): number => clamp(value, [0, 100]);

export function normalizeRateLimitUsedPercent(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return clampPercentage(value);
}

export function getRateLimitRemainingPercent(value: number | null | undefined): number | null {
  const usedPercent = normalizeRateLimitUsedPercent(value);
  return usedPercent == null ? null : clampPercentage(100 - usedPercent);
}

export function getAgentRateLimitWindows(limits: MachineRateLimitUsage): AgentRateLimitWindow[] {
  return limits.windows.flatMap((window) => {
    const usedPercent = normalizeRateLimitUsedPercent(window.usedPercent);
    if (usedPercent === null) return [];
    return [
      {
        ...(window.label?.trim() ? { label: window.label.trim() } : {}),
        usedPercent,
        remainingPercent: clampPercentage(100 - usedPercent),
        windowDurationSeconds:
          window.windowDurationSeconds != null && Number.isFinite(window.windowDurationSeconds)
            ? window.windowDurationSeconds
            : null,
        resetsAtEpochSeconds: window.resetsAtEpochSeconds,
      },
    ];
  });
}

export function formatRateLimitWindowShortLabel(windowDurationSeconds: number | null): string {
  if (windowDurationSeconds == null || !Number.isFinite(windowDurationSeconds)) return 'Usage';
  if (windowDurationSeconds % (24 * 60 * 60) === 0) {
    return `${windowDurationSeconds / (24 * 60 * 60)}d`;
  }
  if (windowDurationSeconds % (60 * 60) === 0) {
    return `${windowDurationSeconds / (60 * 60)}h`;
  }
  return `${windowDurationSeconds / 60}m`;
}

export function formatAgentRateLimitWindowLabel(
  window: AgentRateLimitWindow,
  durationLabel: string,
  t: TFunction
): string {
  return window.label
    ? t('machines.rateLimits.namedWindow', '{{duration}} · {{label}}', {
        duration: durationLabel,
        label: window.label,
      })
    : durationLabel;
}

export function getContextWindowUsageData(
  usage: SessionContextWindowUsage | null | undefined
): ContextWindowUsageData | null {
  if (!usage || !Number.isFinite(usage.size) || usage.size <= 0) return null;

  const contextWindow = usage.size;
  const usedTokens = Number.isFinite(usage.used) ? Math.max(0, usage.used) : 0;
  const remainingTokens = Math.max(0, contextWindow - usedTokens);
  const usedPercentage = clampPercentage((usedTokens / contextWindow) * 100);

  return {
    usedTokens,
    remainingTokens,
    contextWindow,
    usedPercentage,
    remainingPercentage: clampPercentage(100 - usedPercentage),
  };
}

export function canShowSubscriptionRateLimits({
  cliType,
  agentType,
  config,
}: {
  cliType: AgentConfigCliType;
  agentType: string;
  config?: Pick<AgentConfigMeta, 'brandId' | 'env'> | null;
}): boolean {
  if (
    cliType !== 'builtin' ||
    (agentType !== 'claude' &&
      agentType !== 'codex' &&
      agentType !== 'grok' &&
      agentType !== 'kimi')
  ) {
    return false;
  }
  if (!config) return true;

  return (
    Object.keys(config.env).length === 0 &&
    !resolveAgentBrandId({ brandId: config.brandId, env: config.env })
  );
}

const normalizeModelName = (value: string | null | undefined): string =>
  value?.toLowerCase().replace(/[^a-z0-9]+/g, '') ?? '';

const modelNamesMatch = (left: string, right: string): boolean => {
  if (!left || !right) return false;
  return (
    left === right ||
    (left.length >= 4 && right.includes(left)) ||
    (right.length >= 4 && left.includes(right))
  );
};

export function getAgentRateLimitEntries(
  rateLimits: MachineRateLimits | null | undefined,
  agentType: string
): AgentRateLimitEntry[] {
  return Object.entries(rateLimits ?? {})
    .flatMap(([key, value]) => {
      const parsed = parseRateLimitEntryKey(key);
      const limits = normalizePersistedRateLimit(parsed.cliType, parsed.limitId, value);
      return limits ? [{ key, limits, cliType: parsed.cliType, limitId: parsed.limitId }] : [];
    })
    .filter((entry) => entry.cliType === agentType);
}

export function resolveAgentRateLimitForModel({
  rateLimits,
  agentType,
  modelId,
}: {
  rateLimits: MachineRateLimits | null | undefined;
  agentType: string;
  modelId: string | null | undefined;
}): AgentRateLimitEntry | null {
  const entries = getAgentRateLimitEntries(rateLimits, agentType);
  if (entries.length === 0) return null;

  const normalizedModelId = normalizeModelName(modelId);
  if (normalizedModelId) {
    const namedMatch = entries
      .map((entry) => ({ entry, name: normalizeModelName(entry.limits.limitName) }))
      .filter(({ name }) => modelNamesMatch(normalizedModelId, name))
      .sort((left, right) => right.name.length - left.name.length)[0]?.entry;
    if (namedMatch) return namedMatch;

    const exactLimitIdMatch = entries.find(
      (entry) => normalizeModelName(entry.limitId) === normalizedModelId
    );
    if (exactLimitIdMatch) return exactLimitIdMatch;

    const wantsCodexSpark = agentType === 'codex' && normalizedModelId.includes('spark');
    if (wantsCodexSpark) {
      return (
        entries.find(
          (entry) =>
            entry.limitId === CODEX_SPARK_LIMIT_ID ||
            normalizeModelName(entry.limits.limitName).includes('spark')
        ) ?? null
      );
    }
  }

  const genericEntry = entries.find(
    (entry) => entry.limitId === null || entry.limitId === agentType
  );
  if (genericEntry) return genericEntry;

  // With no selected model, a single provider-reported tier is still useful.
  // Once a model is selected, avoid showing a model-specific tier that did not
  // match it (for example, Spark quota beside a standard Codex model).
  return normalizedModelId ? null : (entries[0] ?? null);
}
