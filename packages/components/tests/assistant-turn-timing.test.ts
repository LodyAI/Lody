import { describe, expect, it } from 'vitest';
import {
  buildAssistantTurnTimingRows,
  formatSilenceCompact,
  formatTurnClockTime,
  LIVE_SYNC_SETTLE_MS,
  resolveHistoryLiveSync,
  resolveTurnLiveness,
  resolveTurnSilenceMs,
  TURN_LAST_UPDATE_STALE_MS,
  TURN_SILENCE_NOTICE_MS,
} from '../src/components/ai-gui/assistant-turn-timing';

const OPENED = '2026-10-15T10:41:02.000Z';
const OPENED_MS = Date.parse(OPENED);
const UNITS = { hour: 'h', minute: 'm', second: 's', separator: ' ' };

describe('buildAssistantTurnTimingRows', () => {
  const updated = { kind: 'updated', sinceMs: 12_000, stale: false } as const;

  it('reports a running turn as started, running and its liveness', () => {
    const rows = buildAssistantTurnTimingRows(
      { timestamp: OPENED, startedAt: OPENED_MS },
      { liveness: updated, nowMs: OPENED_MS + 372_000 }
    );
    expect(rows).toEqual([
      { kind: 'started', atMs: OPENED_MS, runningMs: 372_000 },
      { kind: 'lastUpdate', liveness: updated },
    ]);
  });

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

  it('falls back to timestamp when startedAt is missing and tolerates missing fields', () => {
    expect(
      buildAssistantTurnTimingRows({ timestamp: OPENED }, { liveness: null, nowMs: OPENED_MS })
    ).toEqual([{ kind: 'started', atMs: OPENED_MS, runningMs: null }]);
    expect(
      buildAssistantTurnTimingRows(
        { timestamp: 'not-a-date', endedAt: OPENED_MS },
        { liveness: null, nowMs: OPENED_MS }
      )
    ).toEqual([{ kind: 'ended', atMs: OPENED_MS }]);
  });

  it('prefers a recorded startedAt over the entry timestamp for the start row', () => {
    const rows = buildAssistantTurnTimingRows(
      { timestamp: OPENED, startedAt: OPENED_MS + 2_000 },
      { liveness: null, nowMs: OPENED_MS }
    );
    expect(rows[0]).toEqual({ kind: 'started', atMs: OPENED_MS + 2_000, runningMs: null });
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

  it('reports the age of output received while live, and flags it once stale', () => {
    expect(resolveTurnLiveness(base)).toEqual({ kind: 'updated', sinceMs: 12_000, stale: false });
    expect(
      resolveTurnLiveness({ ...base, nowMs: base.lastUpdateAt + TURN_LAST_UPDATE_STALE_MS })
    ).toEqual({ kind: 'updated', sinceMs: TURN_LAST_UPDATE_STALE_MS, stale: true });
  });

  it('never dates a catch-up batch: changes before or just after live sync began do not count', () => {
    expect(resolveTurnLiveness({ ...base, lastUpdateAt: LIVE_SINCE - 60_000 })).toEqual({
      kind: 'noUpdateYet',
    });
    expect(
      resolveTurnLiveness({ ...base, lastUpdateAt: LIVE_SINCE + LIVE_SYNC_SETTLE_MS - 1 })
    ).toEqual({ kind: 'noUpdateYet' });
    expect(resolveTurnLiveness({ ...base, lastUpdateAt: null })).toEqual({ kind: 'noUpdateYet' });
  });

  it('says why there is no time: catching up, offline, or waiting on the user', () => {
    expect(resolveTurnLiveness({ ...base, sync: 'syncing', liveSince: null })).toEqual({
      kind: 'syncing',
    });
    expect(resolveTurnLiveness({ ...base, sync: 'offline', liveSince: null })).toEqual({
      kind: 'offline',
    });
    expect(resolveTurnLiveness({ ...base, activity: 'awaitingUser' })).toEqual({
      kind: 'awaitingUser',
    });
  });
});

describe('resolveHistoryLiveSync', () => {
  it('is live only when synced and online', () => {
    expect(resolveHistoryLiveSync('synced', true)).toBe('live');
    expect(resolveHistoryLiveSync('synced', false)).toBe('offline');
    expect(resolveHistoryLiveSync('connecting', true)).toBe('syncing');
    expect(resolveHistoryLiveSync('reconnecting', true)).toBe('offline');
    expect(resolveHistoryLiveSync('disconnected', true)).toBe('offline');
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

  it('formats the silence in whole minutes', () => {
    expect(formatSilenceCompact(250_000, UNITS)).toBe('4m');
    expect(formatSilenceCompact(3_900_000, UNITS)).toBe('1h 05m');
  });
});

describe('formatTurnClockTime', () => {
  const zone = 'Asia/Shanghai';

  it("shows only the time for today's instants, in the given zone", () => {
    const clock = formatTurnClockTime(OPENED_MS, {
      locale: 'en-GB',
      nowMs: OPENED_MS + 60_000,
      timeZone: zone,
    });
    expect(clock.short).toBe('18:41:02');
    expect(clock.full).toContain('18:41:02');
    expect(clock.full).toContain('Thursday');
  });

  it('adds the date across a local midnight even when less than a day has passed', () => {
    // 23:30 local on the 14th, viewed at 00:10 local on the 15th.
    const lateNight = Date.parse('2026-10-14T15:30:00.000Z');
    const clock = formatTurnClockTime(lateNight, {
      locale: 'en-GB',
      nowMs: Date.parse('2026-10-14T16:10:00.000Z'),
      timeZone: zone,
    });
    expect(clock.short).toBe('14 Oct, 23:30:00');
  });

  it('adds the year for an instant from another year', () => {
    const clock = formatTurnClockTime(Date.parse('2025-12-31T02:00:00.000Z'), {
      locale: 'en-GB',
      nowMs: OPENED_MS,
      timeZone: zone,
    });
    expect(clock.short).toContain('2025');
  });
});
