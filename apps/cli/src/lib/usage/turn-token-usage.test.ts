import { describe, expect, it } from 'vitest';
import type { SessionUsageUpdate } from 'acp-extension-core';
import { TurnTokenUsageLedger, turnTokenUsageFromUpdate } from './turn-token-usage';

const usageUpdate = (costUSD?: number): SessionUsageUpdate => {
  const usage = {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadInputTokens: 2,
    cacheCreationInputTokens: 1,
    reasoningOutputTokens: 1,
    ...(costUSD !== undefined ? { costUSD } : {}),
  };
  return { sessionId: 's', usage, delta: { usage, modelUsage: { model: usage } } };
};

const requiredUsage = (update: SessionUsageUpdate) => {
  const usage = turnTokenUsageFromUpdate(update);
  if (!usage) throw new Error('expected a per-turn usage');
  return usage;
};

describe('per-turn usage from a Core delta', () => {
  it('carries the adapter cost into the stored turn usage', () => {
    expect(turnTokenUsageFromUpdate(usageUpdate(0.25))).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 2,
      cacheCreationInputTokens: 1,
      reasoningOutputTokens: 1,
      costUSD: 0.25,
    });
  });

  it('records an unknown tariff instead of dropping the cost field', () => {
    expect(turnTokenUsageFromUpdate(usageUpdate())?.costUSD).toBeNull();
    expect(turnTokenUsageFromUpdate(usageUpdate(-1))?.costUSD).toBeNull();
  });

  it('ignores updates without a delta or without tokens', () => {
    expect(
      turnTokenUsageFromUpdate({
        sessionId: 's',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0 },
      })
    ).toBeUndefined();
    expect(
      turnTokenUsageFromUpdate({
        sessionId: 's',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
        delta: {
          usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
          modelUsage: {},
        },
      })
    ).toBeUndefined();
  });

  it('never turns a mixed known/unknown turn into a partial cost', () => {
    const ledger = new TurnTokenUsageLedger();
    ledger.add('s', 'a', requiredUsage(usageUpdate(0.5)));
    ledger.add('s', 'a', requiredUsage(usageUpdate()));
    ledger.add('s', 'a', requiredUsage(usageUpdate(0.1)));
    expect(ledger.take('s', 'a')).toMatchObject({ inputTokens: 30, costUSD: null });
  });
});
