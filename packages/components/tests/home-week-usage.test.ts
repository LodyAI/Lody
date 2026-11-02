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
  it('shows the shortest window, with when it resets', () => {
    const usage = buildHomeWeekUsage({
      rateLimits: codex(
        limits([
          { used: 40, seconds: 168 * HOUR, resets: 2_000_000 },
          { used: 25, seconds: 5 * HOUR, resets: 1_000_000 },
        ])
      ),
      agentType: 'codex',
    });
    expect(
      usage?.windows.map((window) => [window.usedPercent, window.resetsAtEpochSeconds])
    ).toEqual([[25, 1_000_000]]);
    expect(usage?.name).toBeNull();
  });

  it('keeps one window: the shortest, and one of unknown length only when it is alone', () => {
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
    expect(usage?.windows.map((window) => window.usedPercent)).toEqual([3]);

    const alone = buildHomeWeekUsage({
      rateLimits: codex(limits([{ used: 1, seconds: null }])),
      agentType: 'codex',
    });
    expect(alone?.windows.map((window) => window.usedPercent)).toEqual([1]);
  });

  it('prefers a window with a known length over one without', () => {
    const usage = buildHomeWeekUsage({
      rateLimits: codex(
        limits([
          { used: 9, seconds: null },
          { used: 7, seconds: 168 * HOUR },
        ])
      ),
      agentType: 'codex',
    });
    expect(usage?.windows.map((window) => window.usedPercent)).toEqual([7]);
  });

  it('names the tier the provider named', () => {
    const usage = buildHomeWeekUsage({
      rateLimits: codex(limits([{ used: 10, seconds: 5 * HOUR }], '  GPT-5.3-Codex-Spark ')),
      agentType: 'codex',
    });
    expect(usage?.name).toBe('GPT-5.3-Codex-Spark');
  });

  it('is null when there is no entry for the agent or the provider reported no window', () => {
    expect(buildHomeWeekUsage({ rateLimits: undefined, agentType: 'codex' })).toBeNull();
    expect(
      buildHomeWeekUsage({
        rateLimits: codex(limits([{ used: 10, seconds: 5 * HOUR }])),
        agentType: 'claude',
      })
    ).toBeNull();
    expect(buildHomeWeekUsage({ rateLimits: codex(limits([])), agentType: 'codex' })).toBeNull();
  });
});
