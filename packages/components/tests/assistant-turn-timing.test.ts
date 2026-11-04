import { describe, expect, it } from 'vitest';
import {
  buildAssistantTurnTimingRows,
  LIVE_SYNC_SETTLE_MS,
  resolveTurnLiveness,
  resolveTurnSilenceMs,
  TURN_SILENCE_NOTICE_MS,
} from '../src/components/ai-gui/assistant-turn-timing';

const OPENED = '2026-10-15T10:41:02.000Z';
const OPENED_MS = Date.parse(OPENED);
const UNITS = { hour: 'h', minute: 'm', second: 's', separator: ' ' };

describe('buildAssistantTurnTimingRows', () => {
  const updated = { kind: 'updated', sinceMs: 12_000, stale: false } as const;

  it('reports a finished turn as started, ended and its Worked-for duration, without liveness', () => {
    const rows = buildAssistantTurnTimingRows(
      { timestamp: OPENED, endedAt: OPENED_MS + 90_000, permissionWaitMs: 30_000 },
      { liveness: null, nowMs: OPENED_MS + 3_600_000 }
    );
    expect(rows).toEqual([
      { kind: 'started', atMs: OPENED_MS, runningMs: null },
      { kind: 'ended', atMs: OPENED_MS + 90_000 },
      // Same quantity as "Worked for": the permission wait is not work.
      { kind: 'duration', durationMs: 60_000 },
    ]);
  });

  it('shows an unfinished turn nothing is running as only started', () => {
    expect(
      buildAssistantTurnTimingRows(
        { timestamp: OPENED },
        { liveness: null, nowMs: OPENED_MS + 3 * 86_400_000 }
      )
    ).toEqual([{ kind: 'started', atMs: OPENED_MS, runningMs: null }]);
  });
});

describe('resolveTurnLiveness', () => {
  const LIVE_SINCE = OPENED_MS;
  const base = {
    activity: 'working',
    sync: 'live',
    liveSince: LIVE_SINCE,
    lastUpdateAt: LIVE_SINCE + 5_000,
    nowMs: LIVE_SINCE + 17_000,
  } as const;

  it('never dates a catch-up batch: changes before or just after live sync began do not count', () => {
    expect(resolveTurnLiveness({ ...base, lastUpdateAt: LIVE_SINCE - 60_000 })).toEqual({
      kind: 'noUpdateYet',
    });
    expect(
      resolveTurnLiveness({ ...base, lastUpdateAt: LIVE_SINCE + LIVE_SYNC_SETTLE_MS - 1 })
    ).toEqual({ kind: 'noUpdateYet' });
    expect(resolveTurnLiveness({ ...base, lastUpdateAt: null })).toEqual({ kind: 'noUpdateYet' });
  });
});

describe('resolveTurnSilenceMs', () => {
  it('reports silence only for output received live, past the notice threshold', () => {
    const at = (sinceMs: number) => ({ kind: 'updated', sinceMs, stale: true }) as const;
    expect(resolveTurnSilenceMs(at(TURN_SILENCE_NOTICE_MS - 1))).toBeNull();
    expect(resolveTurnSilenceMs(at(250_000))).toBe(250_000);
    expect(resolveTurnSilenceMs({ kind: 'awaitingUser' })).toBeNull();
    expect(resolveTurnSilenceMs({ kind: 'offline' })).toBeNull();
    expect(resolveTurnSilenceMs({ kind: 'noUpdateYet' })).toBeNull();
  });
});
