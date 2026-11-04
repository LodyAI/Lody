import { describe, expect, it } from 'vitest';

import { getRateLimitEntryKey, parseRateLimitEntryKey } from '../src/schema';
import type { AgentConfigId } from '../src';

describe('rate limit entry key helpers', () => {
  it('parses legacy keys (no separator)', () => {
    expect(parseRateLimitEntryKey('codex')).toEqual({
      agentConfigId: null,
      cliType: 'codex',
      limitId: null,
    });
  });

  it('round-trips provider-scoped keys without sharing an agent type', () => {
    const agentConfigId = 'work::codex' as AgentConfigId;
    const key = getRateLimitEntryKey('codex', 'codex::weekly', agentConfigId);

    expect(parseRateLimitEntryKey(key)).toEqual({
      agentConfigId,
      cliType: 'codex',
      limitId: 'codex::weekly',
    });
  });
});
