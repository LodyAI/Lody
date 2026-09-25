import type { SessionUsageUpdate } from 'acp-extension-core';
import {
  addSessionTurnTokenUsage,
  isEmptySessionTurnTokenUsage,
  type SessionTurnTokenUsage,
} from '@lody/shared/session-data';

const count = (value: number | undefined) =>
  Number.isFinite(value) ? Math.max(0, Math.round(value ?? 0)) : 0;

/**
 * A turn's share of one usage update: only the Core `delta`, which adapters
 * compute resume-safely from native data. Cumulative totals are never used;
 * an adapter without `delta` contributes nothing rather than a guess.
 */
export function turnTokenUsageFromUpdate(
  update: SessionUsageUpdate
): SessionTurnTokenUsage | undefined {
  const delta = update.delta?.usage;
  if (!delta) return undefined;
  const usage: SessionTurnTokenUsage = {
    inputTokens: count(delta.inputTokens),
    outputTokens: count(delta.outputTokens),
    cacheReadInputTokens: count(delta.cacheReadInputTokens),
    cacheCreationInputTokens: count(delta.cacheCreationInputTokens),
    reasoningOutputTokens: count(delta.reasoningOutputTokens),
  };
  return isEmptySessionTurnTokenUsage(usage) ? undefined : usage;
}

/** Unwritten per-turn deltas, flushed into the assistant entry at turn end. */
export class TurnTokenUsageLedger {
  private readonly pending = new Map<string, SessionTurnTokenUsage>();

  private static key(sessionId: string, entryId: string) {
    return `${sessionId}\0${entryId}`;
  }

  add(sessionId: string, entryId: string, usage: SessionTurnTokenUsage): void {
    const key = TurnTokenUsageLedger.key(sessionId, entryId);
    this.pending.set(key, addSessionTurnTokenUsage(this.pending.get(key), usage));
  }

  /** Removes and returns the unwritten usage; a failed write may `add` it back. */
  take(sessionId: string, entryId: string): SessionTurnTokenUsage | undefined {
    const key = TurnTokenUsageLedger.key(sessionId, entryId);
    const usage = this.pending.get(key);
    this.pending.delete(key);
    return usage;
  }
}
