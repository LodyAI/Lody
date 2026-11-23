import type { Meta, StoryObj } from '@storybook/react';
import { userEvent, within } from 'storybook/test';
import { UsageCalendarVisualization } from '@/components/settings/usage-calendar-visualization';
import { useState } from 'react';
import { Button } from '@lody/ui/button';
import type {
  SettingsUsageCalendarData,
  SettingsUsageDayData,
  SettingsUsageRange,
  SettingsUsageTimelineData,
} from '@/components/settings/settings-data-cache';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const START_MS = Date.UTC(2025, 6, 20);

function wave(index: number): number {
  const primary = Math.sin(index * 0.43) * 0.5 + 0.5;
  const secondary = Math.sin(index * 0.11 + 1.3) * 0.5 + 0.5;
  return primary * secondary;
}

type Shape = 'default' | 'empty' | 'outlier' | 'recent' | 'largeTotal';

const RECENT_ACTIVE_DAYS = 124;
const LARGE_TOTAL_TOKENS = 71_061_000_000;

function buildRecentTokens(totalTokens?: number): number[] {
  const weights = Array.from({ length: RECENT_ACTIVE_DAYS }, (_, index) =>
    Math.max(1, Math.round((0.2 + wave(index + 241)) * 1_000))
  );
  if (totalTokens === undefined) return weights.map((weight) => weight * 180);

  const totalWeight = weights.reduce((total, weight) => total + weight, 0);
  const tokens = weights.map((weight) => Math.floor((totalTokens * weight) / totalWeight));
  tokens[tokens.length - 1]! += totalTokens - tokens.reduce((total, value) => total + value, 0);
  return tokens;
}

function buildCalendar(shape: Shape): SettingsUsageCalendarData {
  const recentTokens =
    shape === 'recent'
      ? buildRecentTokens()
      : shape === 'largeTotal'
        ? buildRecentTokens(LARGE_TOTAL_TOKENS)
        : null;
  return {
    workspaceId: 'workspace-story',
    timezone: 'UTC',
    startMs: START_MS,
    endMs: START_MS + 370 * DAY_MS,
    days: Array.from({ length: 371 }, (_, index) => {
      const dayStartMs = START_MS + index * DAY_MS;
      const recentIndex = index - (365 - RECENT_ACTIVE_DAYS);
      const recentActivity = recentIndex >= 0 ? (recentTokens?.[recentIndex] ?? 0) : 0;
      const activity =
        shape === 'empty' || index > 364
          ? 0
          : recentTokens
            ? recentActivity
            : Math.round(wave(index) * 180_000);
      // One launch-day spike that would flatten the whole ramp under a max-anchored scale.
      const spike = shape === 'outlier' && index === 300 ? 12_000_000 : 0;
      const tokens = recentTokens ? activity : index % 9 === 0 ? 0 : activity + spike;
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

/** Stand-in for the Convex per-day query so the expanded panel is reviewable. */
function buildDayDetail(dayStartMs: number): SettingsUsageDayData {
  const index = Math.round((dayStartMs - START_MS) / DAY_MS);
  const tokens = Math.max(1_000, Math.round(wave(index) * 180_000));
  return {
    workspaceId: 'workspace-story',
    dayStartMs,
    date: new Date(dayStartMs).toISOString().slice(0, 10),
    totals: {
      tokens,
      costUSD: tokens * 0.000012,
      inputTokens: Math.round(tokens * 0.18),
      outputTokens: Math.round(tokens * 0.12),
      cacheReadInputTokens: Math.round(tokens * 0.55),
      cacheCreationInputTokens: Math.round(tokens * 0.12),
      reasoningOutputTokens: Math.round(tokens * 0.03),
      webSearchRequests: index % 4,
    },
    byModel: [
      { modelId: 'claude-sonnet-5', tokens: Math.round(tokens * 0.52), costUSD: 0 },
      { modelId: 'claude-opus-4-8', tokens: Math.round(tokens * 0.24), costUSD: 0 },
      { modelId: 'gpt-5-codex', tokens: Math.round(tokens * 0.14), costUSD: 0 },
      { modelId: 'claude-haiku-4-5', tokens: Math.round(tokens * 0.06), costUSD: 0 },
      { modelId: 'gemini-2.5-pro', tokens: Math.round(tokens * 0.03), costUSD: 0 },
      { modelId: 'kimi-k2', tokens: Math.round(tokens * 0.01), costUSD: 0 },
    ],
    byUser: [
      { userId: 'u1', tokens: Math.round(tokens * 0.61), costUSD: 0 },
      { userId: 'u2', tokens: Math.round(tokens * 0.29), costUSD: 0 },
      { userId: 'u3', tokens: Math.round(tokens * 0.1), costUSD: 0 },
    ],
    users: {
      u1: { name: 'Ada Lovelace' },
      u2: { name: 'Grace Hopper' },
      u3: { email: 'kat@acme.dev' },
    },
  };
}

const RANGE_BUCKETS: Record<SettingsUsageRange, number> = {
  day: 24,
  week: 168,
  month: 30,
  total: 365,
};

function splitTokens(total: number, weights: number[]): number[] {
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const values = weights.map((weight) => Math.floor((total * weight) / weightTotal));
  values[0]! += total - values.reduce((sum, value) => sum + value, 0);
  return values;
}

function buildTimeline(
  calendar: SettingsUsageCalendarData,
  range: SettingsUsageRange
): SettingsUsageTimelineData {
  const activeDays = calendar.days.filter((day) => !day.isFuture);
  const latestDay = activeDays[activeDays.length - 1];
  if (!latestDay) {
    return {
      workspaceId: calendar.workspaceId,
      range,
      startMs: calendar.startMs,
      endMs: calendar.endMs,
      bucketSizeMs: range === 'day' || range === 'week' ? HOUR_MS : DAY_MS,
      totals: { tokens: 0, costUSD: 0 },
      users: {},
      buckets: [],
    };
  }

  const hourlyRange = range === 'day' || range === 'week';
  const days = hourlyRange
    ? activeDays.slice(-(range === 'day' ? 1 : 7))
    : activeDays.slice(-RANGE_BUCKETS[range]);
  const timelineStartMs = days[0]?.dayStartMs ?? calendar.startMs;
  const buckets = (
    hourlyRange
      ? days.flatMap((day, dayIndex) =>
          splitTokens(
            day.tokens,
            Array.from({ length: 24 }, (_, hour) => 8 + Math.round(wave(dayIndex * 29 + hour) * 32))
          ).map((tokens, hour) => ({ tokens, day, hour }))
        )
      : days.map((day) => ({ tokens: day.tokens, day, hour: null }))
  ).map(({ tokens, day, hour }) => {
    const modelTokens = splitTokens(tokens, [46, 27, 17, 7, 3]);
    const memberTokens = splitTokens(tokens, [52, 31, 12, 5]);
    const bucketStartMs = hour === null ? day.dayStartMs : day.dayStartMs + hour * HOUR_MS;
    const costUSD = day.tokens > 0 ? day.costUSD * (tokens / day.tokens) : 0;
    return {
      bucketStartMs,
      bucketLabel: hour === null ? day.date : `${String(hour).padStart(2, '0')}:00`,
      tokens,
      costUSD,
      byModel: [
        'claude-sonnet-5',
        'gpt-5-codex',
        'claude-opus-4-8',
        'gemini-2.5-pro',
        'claude-haiku-4-5',
      ].map((modelId, modelIndex) => ({
        modelId,
        tokens: modelTokens[modelIndex] ?? 0,
        costUSD: 0,
      })),
      byUser: ['u1', 'u2', 'u3', 'u4'].map((userId, userIndex) => ({
        userId,
        tokens: memberTokens[userIndex] ?? 0,
        costUSD: 0,
      })),
    };
  });
  const tokens = buckets.reduce((sum, bucket) => sum + bucket.tokens, 0);
  return {
    workspaceId: calendar.workspaceId,
    range,
    startMs: timelineStartMs,
    endMs: hourlyRange ? timelineStartMs + days.length * DAY_MS : calendar.endMs,
    bucketSizeMs: hourlyRange ? HOUR_MS : DAY_MS,
    totals: {
      tokens,
      costUSD: buckets.reduce((sum, bucket) => sum + bucket.costUSD, 0),
      // Token-type split the activity rings read; the shape mirrors a cache-heavy
      // agent workload.
      breakdown: {
        cacheReadInputTokens: Math.round(tokens * 0.52),
        cacheCreationInputTokens: Math.round(tokens * 0.11),
        inputTokens: Math.round(tokens * 0.16),
        outputTokens: Math.round(tokens * 0.15),
        reasoningOutputTokens: Math.round(tokens * 0.06),
      },
    },
    users: {
      u1: { name: 'Ada Lovelace' },
      u2: { name: 'Grace Hopper' },
      u3: { name: 'Katherine Johnson' },
      u4: { email: 'margaret@acme.dev' },
    },
    buckets,
  };
}

function Harness({
  shape = 'default',
  range = 'total',
  tokenBreakdown = true,
}: {
  shape?: Shape;
  range?: SettingsUsageRange;
  /** Off mirrors a deployment whose timeline reports no token-type split. */
  tokenBreakdown?: boolean;
}) {
  const [selectedDayMs, setSelectedDayMs] = useState<number | null>(null);
  const calendar = buildCalendar(shape);
  const timeline = buildTimeline(calendar, range);
  return (
    <div className="mx-auto max-w-5xl p-6">
      <UsageCalendarVisualization
        calendar={calendar}
        timeline={
          tokenBreakdown
            ? timeline
            : {
                ...timeline,
                totals: { tokens: timeline.totals.tokens, costUSD: timeline.totals.costUSD },
              }
        }
        workspaceName="Acme Robotics"
        dayDetail={selectedDayMs === null ? undefined : buildDayDetail(selectedDayMs)}
        onSelectedDayChange={setSelectedDayMs}
      />
    </div>
  );
}

const meta: Meta<typeof Harness> = {
  title: 'Settings/UsageCalendarVisualization',
  component: Harness,
  argTypes: {
    range: {
      control: {
        type: 'select',
        labels: {
          day: 'Last 24 hours',
          week: 'Last 7 days',
          month: 'Last 30 days',
          total: 'All time',
        },
      },
      options: ['day', 'week', 'month', 'total'],
    },
  },
  parameters: { layout: 'fullscreen' },
};
export default meta;

type Story = StoryObj<typeof Harness>;

export const Default: Story = { args: {} };
export const Empty: Story = { args: { shape: 'empty' } };
export const SingleDaySpike: Story = { args: { shape: 'outlier' } };
export const RecentActivity: Story = { args: { shape: 'recent' } };
export const LargeTotal: Story = { args: { shape: 'largeTotal' } };
export const Last24Hours: Story = { args: { range: 'day' } };
export const Last7Days: Story = { args: { range: 'week' } };
export const Last30Days: Story = { args: { range: 'month' } };
export const RangeSwitching: Story = {
  render: function RangeSwitchingStory() {
    const [range, setRange] = useState<SettingsUsageRange>('week');
    return (
      <>
        <div className="flex gap-2 p-6">
          {(['day', 'week', 'month', 'total'] as const).map((value, index) => (
            <Button key={value} onClick={() => setRange(value)} aria-pressed={range === value}>
              {['24h', '7d', '30d', 'All'][index]}
            </Button>
          ))}
        </div>
        <Harness range={range} />
      </>
    );
  },
};
/** Clicking an hour bar opens the breakdown of the day it belongs to. */
export const Last24HoursDaySelected: Story = {
  args: { range: 'day' },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getAllByRole('gridcell')[10]!);
  },
};
/** Clicking an hour dot opens that day's breakdown. */
export const Last7DaysDaySelected: Story = {
  args: { range: 'week' },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getAllByRole('gridcell')[2 * 24 + 10]!);
  },
};
/** No token-type split on the timeline: the rings fall back to the model mix. */
export const Last24HoursWithoutBreakdown: Story = {
  args: { range: 'day', tokenBreakdown: false },
};
