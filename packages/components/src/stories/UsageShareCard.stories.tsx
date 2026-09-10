import type { Meta, StoryObj } from '@storybook/react';
import {
  createUsageCalendarModel,
  USAGE_CALENDAR_CELLS,
  type UsageCalendarData,
} from '@/components/settings/usage-calendar-model';
import { UsageShareCard } from '@/components/settings/usage-share-card';
import {
  computeUsageShareGraphic,
  computeUsageShareMemberSlices,
  computeUsageShareModelSlices,
  computeUsageShareStats,
} from '@/components/settings/usage-share-stats';
import type {
  SettingsUsageTimelineBucket,
  SettingsUsageTimelineData,
} from '@/components/settings/settings-data-cache';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const START_MS = Date.UTC(2025, 8, 7); // Sunday

/** Deterministic year of usage: a ramping habit with weekends off and a burst. */
function buildCalendar(): UsageCalendarData {
  return {
    startMs: START_MS,
    endMs: START_MS + (USAGE_CALENDAR_CELLS - 1) * DAY_MS,
    days: Array.from({ length: USAGE_CALENDAR_CELLS }, (_, index) => {
      const dayStartMs = START_MS + index * DAY_MS;
      const weekend = index % 7 === 0 || index % 7 === 6;
      const wave = Math.sin(index * 0.21) * 0.5 + 0.5;
      const ramp = 0.3 + (0.7 * index) / USAGE_CALENDAR_CELLS;
      const burst = index > 300 && index < 330 ? 2.1 : 1;
      const tokens =
        weekend && index % 13 !== 0 ? 0 : Math.round(wave * ramp * burst * 9_400_000);
      return {
        dayStartMs,
        date: new Date(dayStartMs).toISOString().slice(0, 10),
        tokens,
        costUSD: tokens * 0.0000042,
        isFuture: index > 358,
      };
    }),
  };
}

const CALENDAR = buildCalendar();
const MODEL = createUsageCalendarModel(CALENDAR, 'tokens');

const MODEL_MIX = [
  { modelId: 'claude-opus-5', weight: 0.52 },
  { modelId: 'gpt-5.2-codex', weight: 0.24 },
  { modelId: 'gemini-3-pro', weight: 0.13 },
  { modelId: 'kimi-k2', weight: 0.07 },
  { modelId: 'deepseek-v3', weight: 0.04 },
];

const MEMBER_MIX = [
  { userId: 'u1', name: 'Ada Lovelace', weight: 0.44 },
  { userId: 'u2', name: 'Grace Hopper', weight: 0.31 },
  { userId: 'u3', name: 'Alan Turing', weight: 0.17 },
  { userId: 'u4', name: 'Katherine Johnson', weight: 0.08 },
];

/** Buckets end at the calendar's last completed day, the way live data does. */
function buildBuckets(count: number, stepMs: number, perBucket: number) {
  const lastMs = START_MS + 358 * DAY_MS;
  return Array.from({ length: count }, (_, index): SettingsUsageTimelineBucket => {
    const tokens = Math.round(perBucket * (0.4 + Math.abs(Math.sin(index * 0.7))));
    return {
      bucketStartMs: lastMs - (count - 1 - index) * stepMs,
      bucketLabel: String(index),
      tokens,
      costUSD: tokens * 0.0000042,
      byModel: MODEL_MIX.map((entry) => ({
        modelId: entry.modelId,
        tokens: Math.round(tokens * entry.weight),
        costUSD: 0,
      })),
      byUser: MEMBER_MIX.map((entry) => ({
        userId: entry.userId,
        tokens: Math.round(tokens * entry.weight),
        costUSD: 0,
      })),
    };
  });
}

function buildTimeline(
  range: SettingsUsageTimelineData['range'],
  buckets: SettingsUsageTimelineBucket[],
  bucketSizeMs: number
): SettingsUsageTimelineData {
  const tokens = buckets.reduce((sum, item) => sum + item.tokens, 0);
  return {
    workspaceId: 'ws',
    range,
    startMs: buckets[0]?.bucketStartMs ?? START_MS,
    endMs: (buckets.at(-1)?.bucketStartMs ?? START_MS) + bucketSizeMs,
    bucketSizeMs,
    totals: { tokens, costUSD: tokens * 0.0000042 },
    users: Object.fromEntries(MEMBER_MIX.map((entry) => [entry.userId, { name: entry.name }])),
    buckets,
  };
}

const MONTH = buildTimeline('month', buildBuckets(30, DAY_MS, 41_000_000), DAY_MS);
const DAY = buildTimeline('day', buildBuckets(24, HOUR_MS, 3_100_000), HOUR_MS);
const WEEK = buildTimeline('week', buildBuckets(7 * 24, HOUR_MS, 1_900_000), HOUR_MS);

function cardProps(timeline: SettingsUsageTimelineData, rangeLabel: string) {
  return {
    calendar: MODEL,
    stats: computeUsageShareStats(MODEL, timeline, timeline.range),
    graphic: computeUsageShareGraphic(timeline, timeline.range),
    modelSlices: computeUsageShareModelSlices(timeline, (id) => id, 'Other'),
    memberSlices: computeUsageShareMemberSlices(timeline, () => 'Unknown member', 'Other'),
    rangeLabel,
    workspaceName: 'Loro',
  };
}

const meta = {
  title: 'Settings/UsageShareCard',
  component: UsageShareCard,
  parameters: { layout: 'centered' },
  argTypes: {
    aspect: { control: 'inline-radio', options: ['portrait', 'wide'] },
    subject: { control: 'inline-radio', options: ['personal', 'team'] },
    backdrop: { control: 'select', options: ['none', 'lody', 'aurora', 'ocean', 'sunset'] },
    theme: { control: 'inline-radio', options: [undefined, 'light', 'dark'] },
  },
  tags: ['autodocs'],
} satisfies Meta<typeof UsageShareCard>;

export default meta;
type Story = StoryObj<typeof UsageShareCard>;

/** The default a user sees when they open the dialog. */
export const Portrait: Story = {
  args: { ...cardProps(MONTH, 'Last 30 days'), aspect: 'portrait', theme: 'dark' },
};

export const Wide: Story = {
  args: { ...cardProps(MONTH, 'Last 30 days'), aspect: 'wide', theme: 'dark' },
};

/** Members replace models in the split block; avatars replace brand marks. */
export const TeamPortrait: Story = {
  args: {
    ...cardProps(MONTH, 'Last 30 days'),
    aspect: 'portrait',
    subject: 'team',
    theme: 'dark',
  },
};

/** Hourly range: the trio counts intervals and only a sliver of the year lights. */
export const HourlyRange: Story = {
  args: { ...cardProps(DAY, 'Last 24 hours'), aspect: 'portrait', theme: 'light' },
};

/** 7d draws the day-by-hour dot matrix, the Usage screen's own idiom for a week. */
export const WeekRange: Story = {
  args: { ...cardProps(WEEK, 'Last 7 days'), aspect: 'portrait', theme: 'dark' },
};

/** The hourly graphics have to survive 16:9's tighter height too. */
export const HourlyWide: Story = {
  args: { ...cardProps(DAY, 'Last 24 hours'), aspect: 'wide', theme: 'dark' },
};

export const WeekWide: Story = {
  args: { ...cardProps(WEEK, 'Last 7 days'), aspect: 'wide', theme: 'light' },
};

/** Cost is opt-in; this is what turning it on looks like. */
export const WithCost: Story = {
  args: {
    ...cardProps(MONTH, 'Last 30 days'),
    aspect: 'wide',
    showCost: true,
    backdrop: 'sunset',
    theme: 'light',
  },
};

/** No backdrop: the card is the whole image, in the pinned light palette. */
export const Bare: Story = {
  args: {
    ...cardProps(MONTH, 'Last 30 days'),
    aspect: 'portrait',
    backdrop: 'none',
    theme: 'light',
  },
};
