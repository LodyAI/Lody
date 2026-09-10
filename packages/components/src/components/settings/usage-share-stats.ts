import type { UsageCalendarCell, UsageCalendarModel } from './usage-calendar-model';
import type { SettingsUsageRange, SettingsUsageTimelineData } from './settings-data-cache';

/**
 * The three headline cells under the hero number. Day and week ranges bucket by
 * hour, so their trio counts intervals rather than days — the same split the
 * on-screen summary already makes, kept in one place so the card and the page
 * can never disagree about a number the user is about to publish.
 */
export type UsageShareTrio = 'daily' | 'interval';

export type UsageShareSlice = {
  id: string;
  label: string;
  tokens: number;
  /** Fraction of the range total, in [0, 1]. */
  share: number;
  /** Member avatar URL; only ever set for member slices. */
  image?: string | null;
};

export type UsageShareStats = {
  trio: UsageShareTrio;
  totalTokens: number;
  totalCostUSD: number;
  /** Days (or hourly intervals) inside the range that recorded usage. */
  activeCount: number;
  /** Longest run of consecutive active days/intervals inside the range. */
  longestStreak: number;
  /** Range total divided by its elapsed days/intervals, including quiet ones. */
  average: number;
  /** Largest single day/interval in the range. */
  peak: number;
  /** Calendar cells the range covers; the card lights these and dims the rest. */
  litDayStartMs: { fromMs: number; toMs: number } | null;
  /**
   * The range's absolute span, always set. `litDayStartMs` answers "what does the
   * heatmap highlight" and is null for all-time; this answers "which dates is this
   * card about", which a shared image must state even when nothing is highlighted.
   */
  periodMs: { fromMs: number; toMs: number };
};

const MAX_SLICES = 4;

function streaks(values: number[]): { active: number; longest: number } {
  let active = 0;
  let longest = 0;
  let run = 0;
  for (const value of values) {
    if (value > 0) {
      active += 1;
      run += 1;
      longest = Math.max(longest, run);
    } else {
      run = 0;
    }
  }
  return { active, longest };
}

/**
 * Everything the share card prints, derived from the range the stats page is
 * showing. The calendar supplies the 53-week heatmap; the timeline supplies the
 * range's own totals, so the hero number always matches the KPI tile the user
 * was looking at when they pressed Share.
 */
export function computeUsageShareStats(
  calendar: UsageCalendarModel,
  timeline: SettingsUsageTimelineData | undefined,
  range: SettingsUsageRange
): UsageShareStats {
  if (timeline && (range === 'day' || range === 'week')) {
    const values = timeline.buckets.map((bucket) => bucket.tokens);
    const { active, longest } = streaks(values);
    return {
      trio: 'interval',
      totalTokens: timeline.totals.tokens,
      totalCostUSD: timeline.totals.costUSD,
      activeCount: active,
      longestStreak: longest,
      average: values.length > 0 ? timeline.totals.tokens / values.length : 0,
      peak: values.length > 0 ? Math.max(...values) : 0,
      litDayStartMs: { fromMs: timeline.startMs, toMs: timeline.endMs },
      periodMs: { fromMs: timeline.startMs, toMs: timeline.endMs },
    };
  }

  // Day-denominated ranges read the calendar directly, so the heatmap, the
  // streak, and the average are all counting the same cells.
  const elapsed = calendar.cells.filter((cell: UsageCalendarCell) => !cell.isFuture);
  const inRange = timeline
    ? elapsed.filter(
        (cell) => cell.dayStartMs >= timeline.startMs && cell.dayStartMs <= timeline.endMs
      )
    : elapsed;
  const window = inRange.length > 0 ? inRange : elapsed;
  const values = window.map((cell) => cell.tokens);
  const { active, longest } = streaks(values);
  const totalTokens = timeline
    ? timeline.totals.tokens
    : values.reduce((sum, value) => sum + value, 0);

  return {
    trio: 'daily',
    totalTokens,
    totalCostUSD: timeline
      ? timeline.totals.costUSD
      : window.reduce((sum, cell) => sum + cell.costUSD, 0),
    activeCount: active,
    longestStreak: longest,
    average: window.length > 0 ? totalTokens / window.length : 0,
    peak: values.length > 0 ? Math.max(...values) : 0,
    litDayStartMs:
      // `total` covers the whole calendar; lighting a window would imply the
      // rest is out of scope when it is not.
      range === 'total' || !timeline
        ? null
        : { fromMs: timeline.startMs, toMs: timeline.endMs },
    periodMs: timeline
      ? { fromMs: timeline.startMs, toMs: timeline.endMs }
      : {
          fromMs: window[0]?.dayStartMs ?? 0,
          toMs: window.at(-1)?.dayStartMs ?? 0,
        },
  };
}

/**
 * Top model slices for the range, largest first, with everything past
 * {@link MAX_SLICES} folded into one remainder slice so the card's legend has a
 * fixed height at every range.
 */
export function computeUsageShareModelSlices(
  timeline: SettingsUsageTimelineData | undefined,
  labelModel: (modelId: string) => string,
  otherLabel: string
): UsageShareSlice[] {
  if (!timeline) return [];
  const totals = new Map<string, number>();
  for (const bucket of timeline.buckets) {
    for (const item of bucket.byModel) {
      totals.set(item.modelId, (totals.get(item.modelId) ?? 0) + item.tokens);
    }
  }
  return foldSlices(
    [...totals].map(([modelId, tokens]) => ({
      id: modelId,
      label: labelModel(modelId),
      tokens,
      share: 0,
    })),
    otherLabel
  );
}

/**
 * Top member slices for the range. Members are identified by their display name
 * and avatar only — an email is an identifier the card would publish, and the
 * user sharing the image is not necessarily the person it identifies.
 */
export function computeUsageShareMemberSlices(
  timeline: SettingsUsageTimelineData | undefined,
  fallbackLabel: (userId: string) => string,
  otherLabel: string
): UsageShareSlice[] {
  if (!timeline) return [];
  const totals = new Map<string, number>();
  for (const bucket of timeline.buckets) {
    for (const item of bucket.byUser) {
      totals.set(item.userId, (totals.get(item.userId) ?? 0) + item.tokens);
    }
  }
  return foldSlices(
    [...totals].map(([userId, tokens]) => ({
      id: userId,
      label: timeline.users?.[userId]?.name?.trim() || fallbackLabel(userId),
      tokens,
      share: 0,
      image: timeline.users?.[userId]?.image ?? null,
    })),
    otherLabel
  );
}

function foldSlices(rows: UsageShareSlice[], otherLabel: string): UsageShareSlice[] {
  const sorted = rows.filter((row) => row.tokens > 0).sort((a, b) => b.tokens - a.tokens);
  const total = sorted.reduce((sum, row) => sum + row.tokens, 0);
  if (total <= 0) return [];

  const head = sorted.slice(0, MAX_SLICES);
  const restTokens = sorted.slice(MAX_SLICES).reduce((sum, row) => sum + row.tokens, 0);
  const slices = restTokens > 0 ? [...head, { id: '__other', label: otherLabel, tokens: restTokens, share: 0 }] : head;
  return slices.map((row) => ({ ...row, share: row.tokens / total }));
}
