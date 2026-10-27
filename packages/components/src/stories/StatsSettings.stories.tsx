import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { StatsSettingsView } from '@/components/settings/stats-setting-pure';
import {
  createUsageTimelineFormatter,
  formatUsageTimelineBucketLabel,
} from '@/components/settings/usage-timeline-bucket-label';
import type { StackedAreaBucket } from '@/components/settings/usage-stacked-area-chart';
import type {
  SettingsUsageCalendarData,
  SettingsUsageRange,
  SettingsUsageTimelineData,
} from '@/components/settings/settings-data-cache';

/* Deterministic pseudo-usage so the charts render a believable shape without
   Math.random (stable across story reloads / visual regression). */
const MODELS = [
  { id: 'claude-opus-4-8', label: 'claude-opus-4-8', weight: 5 },
  { id: 'claude-sonnet-5', label: 'claude-sonnet-5', weight: 8 },
  { id: 'gpt-5-codex', label: 'gpt-5-codex', weight: 4 },
  { id: 'gemini-2.5-pro', label: 'gemini-2.5-pro', weight: 2 },
  { id: 'claude-haiku-4-5', label: 'claude-haiku-4-5', weight: 3 },
];

const MEMBERS = [
  { id: 'u1', name: 'Alice Chen', email: 'alice@acme.dev', weight: 6 },
  { id: 'u2', name: 'Bob Martinez', email: 'bob@acme.dev', weight: 4 },
  { id: 'u3', name: 'Carol Singh', email: 'carol@acme.dev', weight: 3 },
  { id: 'u4', name: 'Dave Kim', email: 'dave@acme.dev', weight: 2 },
  { id: 'u5', name: 'Eve Larsson', email: 'eve@acme.dev', weight: 1 },
];

const RANGE_BUCKETS: Record<SettingsUsageRange, number> = {
  day: 12,
  week: 7,
  month: 30,
  total: 365,
};

// A smooth-ish deterministic curve in [0.15, 1].
function wave(i: number, n: number, phase: number): number {
  const t = n <= 1 ? 0 : i / (n - 1);
  return 0.15 + 0.85 * (0.5 + 0.5 * Math.sin(t * Math.PI * 2.2 + phase));
}

const DAY_MS = 24 * 60 * 60 * 1000;
const CALENDAR_START_MS = Date.UTC(2025, 8, 22);

function buildCalendar(empty: boolean): SettingsUsageCalendarData {
  return {
    workspaceId: 'ws_1',
    timezone: 'UTC',
    startMs: CALENDAR_START_MS,
    endMs: CALENDAR_START_MS + 370 * DAY_MS,
    days: Array.from({ length: 371 }, (_, index) => {
      const dayStartMs = CALENDAR_START_MS + index * DAY_MS;
      const tokens =
        empty || index > 364
          ? 0
          : index % 9 === 0
            ? 0
            : Math.round(wave(index, 371, 0.3) * 180_000);
      return {
        dayStartMs,
        date: new Date(dayStartMs).toISOString().slice(0, 10),
        tokens,
        costUSD: tokens * 0.000012,
        isFuture: index > 364,
      };
    }),
  };
}

function buildTimelineData(
  calendar: SettingsUsageCalendarData,
  range: SettingsUsageRange,
  empty: boolean
): SettingsUsageTimelineData {
  const hourly = range === 'day' || range === 'week';
  const activeDays = calendar.days.filter((day) => !day.isFuture);
  const days = hourly
    ? activeDays.slice(-(range === 'day' ? 1 : 7))
    : activeDays.slice(-RANGE_BUCKETS[range]);
  const buckets = days.flatMap((day) =>
    (hourly ? Array.from({ length: 24 }, (_, hour) => hour) : [null]).map((hour) => {
      const hourlyWeight = Array.from({ length: 24 }, (_, index) => wave(index, 24, 0.9)).reduce(
        (sum, value) => sum + value,
        0
      );
      const tokens = empty
        ? 0
        : Math.round(day.tokens * (hour === null ? 1 : wave(hour, 24, 0.9) / hourlyWeight));
      const bucketStartMs = day.dayStartMs + (hour ?? 0) * 60 * 60 * 1000;
      return {
        bucketStartMs,
        bucketLabel: hour === null ? day.date : `${String(hour).padStart(2, '0')}:00`,
        tokens,
        costUSD: tokens * 0.000012,
        byModel: MODELS.map((model) => ({
          modelId: model.id,
          tokens: Math.round(
            (tokens * model.weight) / MODELS.reduce((sum, item) => sum + item.weight, 0)
          ),
          costUSD: 0,
        })),
        byUser: MEMBERS.map((member) => ({
          userId: member.id,
          tokens: Math.round((tokens * member.weight) / 16),
          costUSD: 0,
        })),
      };
    })
  );
  const tokens = buckets.reduce((sum, bucket) => sum + bucket.tokens, 0);
  return {
    workspaceId: calendar.workspaceId,
    range,
    startMs: days[0]?.dayStartMs ?? calendar.startMs,
    endMs: (days.at(-1)?.dayStartMs ?? calendar.startMs) + DAY_MS,
    bucketSizeMs: hourly ? 60 * 60 * 1000 : DAY_MS,
    totals: {
      tokens,
      costUSD: tokens * 0.000012,
      breakdown: {
        cacheReadInputTokens: Math.round(tokens * 0.52),
        cacheCreationInputTokens: Math.round(tokens * 0.11),
        inputTokens: Math.round(tokens * 0.16),
        outputTokens: Math.round(tokens * 0.15),
        reasoningOutputTokens: Math.round(tokens * 0.06),
      },
    },
    users: {
      u1: { name: 'Alice Chen' },
      u2: { name: 'Bob Martinez' },
      u3: { name: 'Carol Singh' },
      u4: { name: 'Dave Kim' },
      u5: { email: 'eve@acme.dev' },
    },
    buckets,
  };
}

export function StatsSettingsFixture({
  empty = false,
  loading = false,
  noWorkspace = false,
  initialRange = 'day',
  latencyMs = 0,
  inline = false,
  shareCard = false,
  showBreakdown = true,
  renderBreakdown,
}: {
  empty?: boolean;
  loading?: boolean;
  noWorkspace?: boolean;
  initialRange?: SettingsUsageRange;
  /** Simulates a slow query: data stays absent for this long, then arrives. */
  latencyMs?: number;
  /** Drop the story width wrapper so the page can compose with another surface. */
  inline?: boolean;
  shareCard?: boolean;
  showBreakdown?: boolean;
  renderBreakdown?: (buckets: {
    byModelBuckets: StackedAreaBucket[];
    byMemberBuckets: StackedAreaBucket[];
  }) => ReactNode;
}) {
  const [range, setRange] = useState<SettingsUsageRange>(initialRange);
  const [settled, setSettled] = useState(latencyMs === 0);
  useEffect(() => {
    if (latencyMs === 0) return undefined;
    const timer = setTimeout(() => setSettled(true), latencyMs);
    return () => clearTimeout(timer);
  }, [latencyMs]);

  const calendar = useMemo(() => buildCalendar(empty), [empty]);
  const timeline = useMemo(
    () => buildTimelineData(calendar, range, empty),
    [calendar, empty, range]
  );

  const data = useMemo(() => {
    const formatter = createUsageTimelineFormatter('en');
    return {
      totals: timeline.totals,
      byModelBuckets: timeline.buckets.map((bucket) => ({
        label: formatUsageTimelineBucketLabel(timeline, bucket, formatter),
        values: bucket.byModel.map((model) => ({
          id: model.modelId,
          label: model.modelId,
          value: model.tokens,
        })),
      })),
      byMemberBuckets: timeline.buckets.map((bucket) => ({
        label: formatUsageTimelineBucketLabel(timeline, bucket, formatter),
        values: bucket.byUser.map((user) => ({
          id: user.userId,
          label: timeline.users?.[user.userId]?.name ?? user.userId,
          value: user.tokens,
        })),
      })),
    };
  }, [timeline]);

  const loadingNow = loading || !settled;
  const resolved = !loadingNow && !noWorkspace;

  const view = (
    <>
      <StatsSettingsView
        workspaceName="Acme Robotics"
        range={range}
        onRangeChange={setRange}
        ready={resolved}
        totals={resolved ? (empty ? { tokens: 0, costUSD: 0 } : data.totals) : null}
        byModelBuckets={resolved && !empty ? data.byModelBuckets : []}
        byMemberBuckets={resolved && !empty ? data.byMemberBuckets : []}
        usageCalendar={resolved ? calendar : undefined}
        usageTimeline={resolved ? timeline : undefined}
        workspaceId={noWorkspace ? null : 'ws_1'}
        loading={loadingNow}
        shareCard={shareCard}
        showBreakdown={showBreakdown}
      />
      {renderBreakdown?.(resolved && !empty ? data : { byModelBuckets: [], byMemberBuckets: [] })}
    </>
  );
  return inline ? view : <div className="mx-auto max-w-4xl">{view}</div>;
}

const meta: Meta<typeof StatsSettingsFixture> = {
  title: 'Settings/StatsSettings',
  component: StatsSettingsFixture,
  parameters: { layout: 'padded' },
};
export default meta;

type Story = StoryObj<typeof StatsSettingsFixture>;

export const Default: Story = { args: {} };
export const LongRange: Story = { args: { initialRange: 'total' } };
export const Loading: Story = { args: { loading: true } };
/** Loading placeholders resolve into the loaded view, like the real query. */
export const LoadingTransition: Story = { args: { latencyMs: 1600 } };
export const Empty: Story = { args: { empty: true } };
export const NoWorkspace: Story = { args: { noWorkspace: true } };

/** One synthetic peak shared by all three charts in a window crossing UTC midnight. */
export const CrossDayUTC: Story = {
  render: () => {
    const startMs = Date.UTC(2026, 8, 30, 16);
    const timeline: SettingsUsageTimelineData = {
      workspaceId: 'synthetic-workspace',
      range: 'day',
      startMs,
      endMs: startMs + DAY_MS,
      bucketSizeMs: 3_600_000,
      totals: { tokens: 500, costUSD: 0.005 },
      users: { member: { name: 'Synthetic member' } },
      buckets: Array.from({ length: 24 }, (_, index) => {
        const tokens = index === 7 ? 500 : 0;
        return {
          bucketStartMs: startMs + index * 3_600_000,
          bucketLabel: new Date(startMs + index * 3_600_000).toISOString().slice(11, 16),
          tokens,
          costUSD: tokens / 100_000,
          byModel: [{ modelId: 'synthetic-model', tokens, costUSD: tokens / 100_000 }],
          byUser: [{ userId: 'member', tokens, costUSD: tokens / 100_000 }],
        };
      }),
    };
    const formatter = createUsageTimelineFormatter('en');
    const buckets = timeline.buckets.map((bucket) => ({
      label: formatUsageTimelineBucketLabel(timeline, bucket, formatter),
      values: [{ id: 'synthetic', label: 'Synthetic', value: bucket.tokens }],
    }));
    return (
      <StatsSettingsView
        range="day"
        onRangeChange={() => {}}
        ready
        totals={timeline.totals}
        byModelBuckets={buckets}
        byMemberBuckets={buckets}
        usageCalendar={buildCalendar(true)}
        usageTimeline={timeline}
        workspaceId={timeline.workspaceId}
        loading={false}
      />
    );
  },
};
