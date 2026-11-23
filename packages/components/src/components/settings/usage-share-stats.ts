import type {
  UsageCalendarCell,
  UsageCalendarMetric,
  UsageCalendarModel,
} from './usage-calendar-model';
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
  /** In the card's chosen metric — tokens or USD, never both. */
  value: number;
  /** Fraction of the range total, in [0, 1]. */
  share: number;
  /** Member avatar URL; only ever set for member slices. */
  image?: string | null;
};

export type UsageShareStats = {
  trio: UsageShareTrio;
  /**
   * The unit every number here is in. It travels with the numbers rather than
   * beside them: a caller that passed stats derived in one metric and a label in
   * another would render a token count with a dollar sign in front of it.
   */
  metric: UsageCalendarMetric;
  /**
   * The range's total in the chosen metric. The card is denominated end to end —
   * headline, cells, graphic and split all read the same unit — so carrying both
   * would invite a card that mixes them.
   */
  total: number;
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
  range: SettingsUsageRange,
  metric: UsageCalendarMetric = 'tokens'
): UsageShareStats {
  const pick = (row: { tokens: number; costUSD: number }) =>
    metric === 'tokens' ? row.tokens : row.costUSD;

  if (timeline && (range === 'day' || range === 'week')) {
    const values = timeline.buckets.map(pick);
    const { active, longest } = streaks(values);
    const total = pick(timeline.totals);
    return {
      trio: 'interval',
      metric,
      total,
      activeCount: active,
      longestStreak: longest,
      average: values.length > 0 ? total / values.length : 0,
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
  const values = window.map(pick);
  const { active, longest } = streaks(values);
  const total = timeline
    ? pick(timeline.totals)
    : values.reduce((sum, value) => sum + value, 0);

  return {
    trio: 'daily',
    metric,
    total,
    activeCount: active,
    longestStreak: longest,
    average: window.length > 0 ? total / window.length : 0,
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
  otherLabel: string,
  metric: UsageCalendarMetric = 'tokens'
): UsageShareSlice[] {
  if (!timeline) return [];
  const totals = new Map<string, number>();
  for (const bucket of timeline.buckets) {
    for (const item of bucket.byModel) {
      const value = metric === 'tokens' ? item.tokens : item.costUSD;
      totals.set(item.modelId, (totals.get(item.modelId) ?? 0) + value);
    }
  }
  return foldSlices(
    [...totals].map(([modelId, value]) => ({
      id: modelId,
      label: labelModel(modelId),
      value,
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
  otherLabel: string,
  metric: UsageCalendarMetric = 'tokens'
): UsageShareSlice[] {
  if (!timeline) return [];
  const totals = new Map<string, number>();
  for (const bucket of timeline.buckets) {
    for (const item of bucket.byUser) {
      const value = metric === 'tokens' ? item.tokens : item.costUSD;
      totals.set(item.userId, (totals.get(item.userId) ?? 0) + value);
    }
  }
  return foldSlices(
    [...totals].map(([userId, value]) => ({
      id: userId,
      label: timeline.users?.[userId]?.name?.trim() || fallbackLabel(userId),
      value,
      share: 0,
      image: timeline.users?.[userId]?.image ?? null,
    })),
    otherLabel
  );
}

function foldSlices(rows: UsageShareSlice[], otherLabel: string): UsageShareSlice[] {
  const sorted = rows.filter((row) => row.value > 0).sort((a, b) => b.value - a.value);
  const total = sorted.reduce((sum, row) => sum + row.value, 0);
  if (total <= 0) return [];

  const head = sorted.slice(0, MAX_SLICES);
  const rest = sorted.slice(MAX_SLICES).reduce((sum, row) => sum + row.value, 0);
  const slices =
    rest > 0 ? [...head, { id: '__other', label: otherLabel, value: rest, share: 0 }] : head;
  return slices.map((row) => ({ ...row, share: row.value / total }));
}

/**
 * Which graphic the card draws for a range. The Usage screen already speaks three
 * visual languages — an hour skyline for 24h, a day-by-hour dot matrix for 7d, the
 * 53-week calendar for the longer windows — and the card following the same split
 * is what makes a 24h card worth looking at. Drawing the year for every range left
 * the 24h card with a single lit cell.
 */
export type UsageShareGraphic =
  | { kind: 'calendar' }
  /** One value per hour of the shared day. */
  | { kind: 'hours'; values: number[] }
  /** One row per day, each row one value per hour. */
  | { kind: 'weekHours'; rows: Array<{ dayStartMs: number; values: number[] }> };

const HOUR_MS = 60 * 60 * 1000;
const HOURS_PER_DAY = 24;

/**
 * Picks the graphic for the range. Hourly ranges need hour-granular buckets to say
 * anything; when the timeline is missing or coarser than an hour the calendar is
 * the honest fallback, because it is the one series always present.
 */
export function computeUsageShareGraphic(
  timeline: SettingsUsageTimelineData | undefined,
  range: SettingsUsageRange,
  metric: UsageCalendarMetric = 'tokens'
): UsageShareGraphic {
  const hourly =
    timeline && timeline.bucketSizeMs <= HOUR_MS && timeline.buckets.length > 0
      ? timeline.buckets
      : null;
  if (!hourly || (range !== 'day' && range !== 'week')) return { kind: 'calendar' };

  const pick = (row: { tokens: number; costUSD: number }) =>
    metric === 'tokens' ? row.tokens : row.costUSD;
  if (range === 'day') return { kind: 'hours', values: hourly.map(pick) };

  // 7d: group the hour buckets into whole days so every row is a real day, and a
  // day the range only partly covers still lines its hours up with the others.
  const rows = new Map<number, number[]>();
  for (const bucket of hourly) {
    const date = new Date(bucket.bucketStartMs);
    const dayStartMs = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    const values = rows.get(dayStartMs) ?? new Array<number>(HOURS_PER_DAY).fill(0);
    values[date.getUTCHours()] += pick(bucket);
    rows.set(dayStartMs, values);
  }
  return {
    kind: 'weekHours',
    rows: [...rows.entries()]
      .sort(([a], [b]) => a - b)
      .map(([dayStartMs, values]) => ({ dayStartMs, values })),
  };
}
