import type { SettingsUsageTimelineBucket, SettingsUsageTimelineData } from './settings-data-cache';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Hourly charts share the viewer's time zone. Offsets distinguish repeated clock hours. */
export function createUsageTimelineFormatter(
  locale: string,
  timeZone?: string
): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
    timeZoneName: 'shortOffset',
  });
}

export function formatUsageTimelineWindow(
  timeline: Pick<SettingsUsageTimelineData, 'startMs' | 'endMs'>,
  formatter: Intl.DateTimeFormat
): string {
  return `${formatter.format(timeline.startMs)} – ${formatter.format(timeline.endMs)}`;
}

/** One label per returned bucket, in its original order, including cross-day windows. */
export function usageTimelineHourLabels(
  buckets: Pick<SettingsUsageTimelineBucket, 'bucketStartMs'>[],
  timeZone: string
): string[] {
  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return buckets.map((bucket) => clock.format(bucket.bucketStartMs).replace(/:00$/, ''));
}

/** One column per local hour, with an extra track for each repeated hour at a clock change. */
export function groupUsageWeekBuckets(buckets: SettingsUsageTimelineBucket[], timeZone: string) {
  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    hourCycle: 'h23',
  });
  const days = new Map<number, number[][]>();
  for (const [index, bucket] of buckets.entries()) {
    const wall = Object.fromEntries(
      clock.formatToParts(bucket.bucketStartMs).map(({ type, value }) => [type, Number(value)])
    );
    // Encode the local calendar date for the gutter's date-only formatter.
    const dateMs = Date.UTC(wall.year!, wall.month! - 1, wall.day!);
    let hours = days.get(dateMs);
    if (!hours) {
      hours = Array.from({ length: 24 }, () => []);
      days.set(dateMs, hours);
    }
    hours[wall.hour!]!.push(index);
  }

  const hoursByDay = [...days.values()];
  const columns = Array.from({ length: 24 }, (_, hour) => {
    const repeats = Math.max(1, ...hoursByDay.map((hours) => hours[hour]!.length));
    return Array.from({ length: repeats }, (_, occurrence) => ({ hour, occurrence }));
  }).flat();

  return {
    labels: columns.map(({ hour }) => String(hour).padStart(2, '0')),
    rows: [...days]
      .sort(([left], [right]) => left - right)
      .map(([dateMs, hours]) => ({
        dateMs,
        bucketIndexes: columns.map(({ hour, occurrence }) => hours[hour]![occurrence]),
      })),
  };
}

/** Show the returned bucket's extent clipped to the selected query window. */
export function formatUsageTimelineBucketInterval(
  timeline: Pick<SettingsUsageTimelineData, 'startMs' | 'endMs' | 'bucketSizeMs'>,
  bucket: Pick<SettingsUsageTimelineBucket, 'bucketStartMs'>,
  formatter: Intl.DateTimeFormat
): string {
  return formatUsageTimelineWindow(
    {
      startMs: Math.max(timeline.startMs, bucket.bucketStartMs),
      endMs: Math.min(timeline.endMs, bucket.bucketStartMs + timeline.bucketSizeMs),
    },
    formatter
  );
}

export function formatUsageTimelineBucketLabel(
  timeline: Pick<SettingsUsageTimelineData, 'bucketSizeMs'>,
  bucket: Pick<SettingsUsageTimelineBucket, 'bucketStartMs' | 'bucketLabel'>,
  timeFormatter: Intl.DateTimeFormat
): string {
  if (timeline.bucketSizeMs >= DAY_MS) {
    return bucket.bucketLabel;
  }

  return timeFormatter.format(bucket.bucketStartMs);
}
