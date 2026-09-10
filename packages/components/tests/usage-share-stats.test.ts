import { describe, expect, it } from 'vitest';
import {
  createUsageCalendarModel,
  USAGE_CALENDAR_CELLS,
  type UsageCalendarData,
} from '../src/components/settings/usage-calendar-model';
import {
  computeUsageShareMemberSlices,
  computeUsageShareModelSlices,
  computeUsageShareStats,
} from '../src/components/settings/usage-share-stats';
import type {
  SettingsUsageTimelineBucket,
  SettingsUsageTimelineData,
} from '../src/components/settings/settings-data-cache';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const START_MS = Date.UTC(2025, 6, 20); // Sunday, so the grid starts on column 0.

function createCalendar(tokensByIndex: Record<number, number> = {}): UsageCalendarData {
  return {
    startMs: START_MS,
    endMs: START_MS + (USAGE_CALENDAR_CELLS - 1) * DAY_MS,
    days: Array.from({ length: USAGE_CALENDAR_CELLS }, (_, index) => {
      const dayStartMs = START_MS + index * DAY_MS;
      const tokens = tokensByIndex[index] ?? 0;
      return {
        dayStartMs,
        date: new Date(dayStartMs).toISOString().slice(0, 10),
        tokens,
        costUSD: tokens / 1000,
        isFuture: false,
      };
    }),
  };
}

function createTimeline(
  overrides: Partial<SettingsUsageTimelineData> & Pick<SettingsUsageTimelineData, 'range'>
): SettingsUsageTimelineData {
  return {
    workspaceId: 'ws',
    startMs: START_MS,
    endMs: START_MS + 29 * DAY_MS,
    bucketSizeMs: DAY_MS,
    totals: { tokens: 0, costUSD: 0 },
    buckets: [],
    ...overrides,
  };
}

function bucket(
  bucketStartMs: number,
  tokens: number,
  byModel: SettingsUsageTimelineBucket['byModel'] = [],
  byUser: SettingsUsageTimelineBucket['byUser'] = []
): SettingsUsageTimelineBucket {
  return {
    bucketStartMs,
    bucketLabel: String(bucketStartMs),
    tokens,
    costUSD: tokens / 1000,
    byModel,
    byUser,
  };
}

describe('usage share stats', () => {
  it('counts active days and the longest streak inside the shared window only', () => {
    // Days 0-2 active, day 3 quiet, days 4-5 active — all inside the window.
    // Days 40-46 are a longer run that sits outside it and must not be counted.
    const calendar = createUsageCalendarModel(
      createCalendar({
        0: 10,
        1: 20,
        2: 30,
        4: 40,
        5: 50,
        40: 99,
        41: 99,
        42: 99,
        43: 99,
        44: 99,
        45: 99,
        46: 99,
      }),
      'tokens'
    );
    const timeline = createTimeline({
      range: 'month',
      startMs: START_MS,
      endMs: START_MS + 9 * DAY_MS,
      totals: { tokens: 150, costUSD: 0.15 },
    });

    const stats = computeUsageShareStats(calendar, timeline, 'month');

    expect(stats.trio).toBe('daily');
    expect(stats.activeCount).toBe(5);
    expect(stats.longestStreak).toBe(3);
    expect(stats.peak).toBe(50);
    // The hero number is the timeline's own total, so the card and the KPI tile
    // the user was looking at can never disagree.
    expect(stats.totalTokens).toBe(150);
    // Ten elapsed days in the window, quiet days included.
    expect(stats.average).toBe(15);
    expect(stats.litDayStartMs).toEqual({ fromMs: START_MS, toMs: START_MS + 9 * DAY_MS });
    expect(stats.periodMs).toEqual({ fromMs: START_MS, toMs: START_MS + 9 * DAY_MS });
  });

  it('switches to interval counting for the hourly ranges', () => {
    const calendar = createUsageCalendarModel(createCalendar({ 0: 100 }), 'tokens');
    const timeline = createTimeline({
      range: 'day',
      bucketSizeMs: HOUR_MS,
      totals: { tokens: 240, costUSD: 0.24 },
      buckets: [
        bucket(START_MS, 100),
        bucket(START_MS + HOUR_MS, 60),
        bucket(START_MS + 2 * HOUR_MS, 0),
        bucket(START_MS + 3 * HOUR_MS, 80),
      ],
    });

    const stats = computeUsageShareStats(calendar, timeline, 'day');

    expect(stats.trio).toBe('interval');
    expect(stats.activeCount).toBe(3);
    expect(stats.longestStreak).toBe(2);
    expect(stats.peak).toBe(100);
    expect(stats.average).toBe(60);
  });

  it('lights the whole calendar for the all-time range', () => {
    const calendar = createUsageCalendarModel(createCalendar({ 3: 70 }), 'tokens');
    const timeline = createTimeline({ range: 'total', totals: { tokens: 70, costUSD: 0.07 } });

    const stats = computeUsageShareStats(calendar, timeline, 'total');
    expect(stats.litDayStartMs).toBeNull();
    // Nothing is highlighted, but the card still has to say which dates it covers.
    expect(stats.periodMs).toEqual({ fromMs: START_MS, toMs: START_MS + 29 * DAY_MS });
  });

  it('falls back to the calendar when the range has no timeline yet', () => {
    const calendar = createUsageCalendarModel(createCalendar({ 0: 5, 1: 15 }), 'tokens');

    const stats = computeUsageShareStats(calendar, undefined, 'month');

    expect(stats.totalTokens).toBe(20);
    expect(stats.activeCount).toBe(2);
    expect(stats.litDayStartMs).toBeNull();
    // No timeline: the span falls back to the calendar's elapsed days.
    expect(stats.periodMs).toEqual({
      fromMs: START_MS,
      toMs: START_MS + (USAGE_CALENDAR_CELLS - 1) * DAY_MS,
    });
  });

  it('ranks model slices, folds the tail into one remainder, and normalizes shares', () => {
    const timeline = createTimeline({
      range: 'month',
      buckets: [
        bucket(START_MS, 0, [
          { modelId: 'a', tokens: 50, costUSD: 0 },
          { modelId: 'b', tokens: 20, costUSD: 0 },
          { modelId: 'c', tokens: 10, costUSD: 0 },
        ]),
        bucket(START_MS + DAY_MS, 0, [
          { modelId: 'a', tokens: 10, costUSD: 0 },
          { modelId: 'd', tokens: 5, costUSD: 0 },
          { modelId: 'e', tokens: 3, costUSD: 0 },
          { modelId: 'f', tokens: 2, costUSD: 0 },
        ]),
      ],
    });

    const slices = computeUsageShareModelSlices(timeline, (id) => id.toUpperCase(), 'Other');

    expect(slices.map((slice) => slice.id)).toEqual(['a', 'b', 'c', 'd', '__other']);
    expect(slices[0]).toMatchObject({ label: 'A', tokens: 60 });
    // e (3) + f (2) fold together rather than adding legend rows.
    expect(slices.at(-1)).toMatchObject({ label: 'Other', tokens: 5 });
    expect(slices.reduce((sum, slice) => sum + slice.share, 0)).toBeCloseTo(1, 10);
  });

  it('labels members by display name only and never by email', () => {
    const timeline = createTimeline({
      range: 'month',
      users: {
        u1: { name: 'Ada', email: 'ada@example.com', image: 'https://img/1' },
        u2: { email: 'grace@example.com' },
      },
      buckets: [
        bucket(
          START_MS,
          0,
          [],
          [
            { userId: 'u1', tokens: 90, costUSD: 0 },
            { userId: 'u2', tokens: 10, costUSD: 0 },
          ]
        ),
      ],
    });

    const slices = computeUsageShareMemberSlices(timeline, () => 'Unknown member', 'Other');

    expect(slices).toEqual([
      { id: 'u1', label: 'Ada', tokens: 90, share: 0.9, image: 'https://img/1' },
      { id: 'u2', label: 'Unknown member', tokens: 10, share: 0.1, image: null },
    ]);
    expect(JSON.stringify(slices)).not.toContain('@example.com');
  });

  it('returns no slices when the range recorded no usage', () => {
    const empty = createTimeline({ range: 'month', buckets: [bucket(START_MS, 0)] });

    expect(computeUsageShareModelSlices(empty, (id) => id, 'Other')).toEqual([]);
    expect(computeUsageShareMemberSlices(empty, () => 'Unknown', 'Other')).toEqual([]);
  });
});
