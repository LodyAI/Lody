import type { SettingsUsageTimelineBucket, SettingsUsageTimelineData } from './settings-data-cache';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Calendar, skyline and split charts share UTC; midnight is 00:00, never 24:00. */
export function createUsageTimelineFormatter(locale: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'UTC',
  });
}

export function formatUsageTimelineWindow(
  timeline: Pick<SettingsUsageTimelineData, 'startMs' | 'endMs'>,
  formatter: Intl.DateTimeFormat
): string {
  return `${formatter.format(new Date(timeline.startMs))} – ${formatter.format(new Date(timeline.endMs))} UTC`;
}

/** One label per returned bucket, in its original order, including cross-day windows. */
export function usageTimelineHourLabels(
  buckets: Pick<SettingsUsageTimelineBucket, 'bucketStartMs'>[]
): string[] {
  return buckets.map((bucket) =>
    String(new Date(bucket.bucketStartMs).getUTCHours()).padStart(2, '0')
  );
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

  return `${timeFormatter.format(new Date(bucket.bucketStartMs))} UTC`;
}
