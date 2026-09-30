import { z } from 'zod';

// # Per-turn token usage
//
// The tokens one assistant turn consumed, summed from the adapter's Core usage
// `delta`s (never from cumulative totals). Buckets are disjoint like Core
// `ModelUsage`: input excludes cache reads/writes, output excludes reasoning.

const tokenCount = z.number().int().nonnegative();

export const SessionTurnTokenUsageSchema = z.object({
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  cacheReadInputTokens: tokenCount,
  cacheCreationInputTokens: tokenCount,
  reasoningOutputTokens: tokenCount,
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

export function addSessionTurnTokenUsage(
  base: SessionTurnTokenUsage | undefined,
  delta: SessionTurnTokenUsage
): SessionTurnTokenUsage {
  const from = base ?? EMPTY_SESSION_TURN_TOKEN_USAGE;
  return {
    inputTokens: from.inputTokens + delta.inputTokens,
    outputTokens: from.outputTokens + delta.outputTokens,
    cacheReadInputTokens: from.cacheReadInputTokens + delta.cacheReadInputTokens,
    cacheCreationInputTokens: from.cacheCreationInputTokens + delta.cacheCreationInputTokens,
    reasoningOutputTokens: from.reasoningOutputTokens + delta.reasoningOutputTokens,
  };
}

export const isEmptySessionTurnTokenUsage = (usage: SessionTurnTokenUsage): boolean =>
  usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadInputTokens +
    usage.cacheCreationInputTokens +
    usage.reasoningOutputTokens ===
  0;
