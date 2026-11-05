import { describe, expect, it } from 'vitest';
import { getRateLimitEntryKey } from '@lody/shared';

import { buildHomeWeekUsage } from '../src/lib/home-week-usage';
import type { MachineRateLimits } from '../src/lib/session-usage';

const HOUR = 60 * 60;

const limits = (
  windows: Array<{ used: number; seconds: number | null; resets?: number | null }>,
  limitName?: string
): MachineRateLimits[string] => ({
  limitId: 'codex',
  scope: { providerId: 'codex' },
  planName: null,
  ...(limitName ? { limitName } : {}),
  windows: windows.map((window) => ({
    usedPercent: window.used,
    windowDurationSeconds: window.seconds,
    resetsAtEpochSeconds: window.resets ?? null,
  })),
});

const codex = (value: MachineRateLimits[string]): MachineRateLimits => ({
  [getRateLimitEntryKey('codex', 'codex')]: value,
});

describe('buildHomeWeekUsage', () => {
  it('meters the shortest window and keeps the week beside it, each with its reset time', () => {
    const usage = buildHomeWeekUsage({
      rateLimits: codex(
        limits([
          { used: 40, seconds: 168 * HOUR, resets: 2_000_000 },
          { used: 25, seconds: 5 * HOUR, resets: 1_000_000 },
        ])
      ),
      agentType: 'codex',
    });
    expect([
      usage?.window.usedPercent,
      usage?.window.resetsAtEpochSeconds,
      usage?.otherWindow?.usedPercent,
      usage?.otherWindow?.resetsAtEpochSeconds,
    ]).toEqual([25, 1_000_000, 40, 2_000_000]);
    expect(usage?.name).toBeNull();
  });

  it('keeps two windows at most: the week is the one behind the 5-hour segment', () => {
    const usage = buildHomeWeekUsage({
      rateLimits: codex(
        limits([
          { used: 1, seconds: null },
          { used: 2, seconds: 168 * HOUR },
          { used: 3, seconds: 5 * HOUR },
        ])
      ),
      agentType: 'codex',
    });
    expect([usage?.window.usedPercent, usage?.otherWindow?.usedPercent]).toEqual([3, 2]);

    const alone = buildHomeWeekUsage({
      rateLimits: codex(limits([{ used: 1, seconds: null }])),
      agentType: 'codex',
    });
    expect(alone?.window.usedPercent).toBe(1);
    expect(alone?.otherWindow).toBeNull();
  });
});
