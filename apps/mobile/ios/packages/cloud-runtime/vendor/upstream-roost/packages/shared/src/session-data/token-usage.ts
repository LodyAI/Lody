import { z } from 'zod';

// # Per-turn usage
//
// The tokens and cost one assistant turn consumed, summed from the adapter's
// Core usage `delta`s (never from cumulative totals). Token buckets are disjoint
// like Core `ModelUsage`: input excludes cache reads/writes, output excludes
// reasoning. Cost is a provider bill or adapter estimate, never an invoice.

const tokenCount = z.number().int().nonnegative();
const tokenCost = z.number().finite().nonnegative();

export const SessionTurnTokenUsageSchema = z.object({
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  cacheReadInputTokens: tokenCount,
  cacheCreationInputTokens: tokenCount,
  reasoningOutputTokens: tokenCount,
  /**
   * Estimated USD for this turn. `null` means at least one contribution had no
   * known tariff, so the displayed total would understate the turn; absent means
   * no contribution reported a cost.
   */
  costUSD: tokenCost.nullable().optional(),
});

export type SessionTurnTokenUsage = z.output<typeof SessionTurnTokenUsageSchema>;

export const EMPTY_SESSION_TURN_TOKEN_USAGE: SessionTurnTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  reasoningOutputTokens: 0,
};

/** Stored values are untrusted peer data; unreadable ones display as absent. */
export function readSessionTurnTokenUsage(value: unknown): SessionTurnTokenUsage | undefined {
  const parsed = SessionTurnTokenUsageSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

const totalTokenCount = (usage: SessionTurnTokenUsage): number =>
  usage.inputTokens +
  usage.outputTokens +
  usage.cacheReadInputTokens +
  usage.cacheCreationInputTokens +
  usage.reasoningOutputTokens;

/**
 * Known and unknown costs add like Core's cumulative usage: one unknown poisons
 * the total. An absent base cost is only a complete zero when the base has no
 * tokens; legacy rows that carry tokens without a cost are already unknown.
 */
function addSessionTurnCost(
  base: SessionTurnTokenUsage | undefined,
  delta: number | null | undefined
): number | null | undefined {
  if (base === undefined) {
    if (delta === undefined) return undefined;
    return delta;
  }
  const baseCost = base.costUSD;
  if (baseCost === undefined) {
    if (delta === undefined) return undefined;
    if (delta === null) return null;
    return totalTokenCount(base) > 0 ? null : delta;
  }
  if (baseCost === null || delta === undefined || delta === null) return null;
  return baseCost + delta;
}

export function addSessionTurnTokenUsage(
  base: SessionTurnTokenUsage | undefined,
  delta: SessionTurnTokenUsage
): SessionTurnTokenUsage {
  const from = base ?? EMPTY_SESSION_TURN_TOKEN_USAGE;
  const costUSD = addSessionTurnCost(base, delta.costUSD);
  return {
    inputTokens: from.inputTokens + delta.inputTokens,
    outputTokens: from.outputTokens + delta.outputTokens,
    cacheReadInputTokens: from.cacheReadInputTokens + delta.cacheReadInputTokens,
    cacheCreationInputTokens: from.cacheCreationInputTokens + delta.cacheCreationInputTokens,
    reasoningOutputTokens: from.reasoningOutputTokens + delta.reasoningOutputTokens,
    ...(costUSD !== undefined ? { costUSD } : {}),
  };
}

export const isEmptySessionTurnTokenUsage = (usage: SessionTurnTokenUsage): boolean => {
  return totalTokenCount(usage) === 0 && (usage.costUSD === undefined || usage.costUSD === null);
};
