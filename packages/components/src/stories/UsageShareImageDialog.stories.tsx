import type { Meta, StoryObj } from '@storybook/react';
import { useState, type ComponentProps } from 'react';
import { UsageShareImageDialog } from '@/components/settings/usage-share-image-dialog';
import { USAGE_CALENDAR_CELLS } from '@/components/settings/usage-calendar-model';
import type {
  SettingsUsageCalendarData,
  SettingsUsageTimelineBucket,
  SettingsUsageTimelineData,
} from '@/components/settings/settings-data-cache';

const DAY_MS = 24 * 60 * 60 * 1000;
const START_MS = Date.UTC(2025, 8, 7); // Sunday
const LAST_MS = START_MS + 358 * DAY_MS;

/** Synthetic year of usage: a ramping habit with weekends mostly off. */
const CALENDAR: SettingsUsageCalendarData = {
  workspaceId: 'ws-demo',
  timezone: 'UTC',
  startMs: START_MS,
  endMs: START_MS + (USAGE_CALENDAR_CELLS - 1) * DAY_MS,
  days: Array.from({ length: USAGE_CALENDAR_CELLS }, (_, index) => {
    const dayStartMs = START_MS + index * DAY_MS;
    const weekend = index % 7 === 0 || index % 7 === 6;
    const wave = Math.sin(index * 0.21) * 0.5 + 0.5;
    const ramp = 0.3 + (0.7 * index) / USAGE_CALENDAR_CELLS;
    const tokens = weekend && index % 13 !== 0 ? 0 : Math.round(wave * ramp * 9_400_000);
    return {
      dayStartMs,
      date: new Date(dayStartMs).toISOString().slice(0, 10),
      tokens,
      costUSD: tokens * 0.0000042,
      isFuture: index > 358,
    };
  }),
};

const MODEL_MIX = [
  { modelId: 'claude-opus-5', weight: 0.52 },
  { modelId: 'gpt-5.2-codex', weight: 0.24 },
  { modelId: 'gemini-3-pro', weight: 0.13 },
  { modelId: 'kimi-k2', weight: 0.11 },
];

const MEMBER_MIX = [
  { userId: 'u1', name: 'Ada Lovelace', weight: 0.44 },
  { userId: 'u2', name: 'Grace Hopper', weight: 0.31 },
  { userId: 'u3', name: 'Alan Turing', weight: 0.25 },
];

function buildTimeline(memberCount: number): SettingsUsageTimelineData {
  const members = MEMBER_MIX.slice(0, memberCount);
  const buckets = Array.from({ length: 30 }, (_, index): SettingsUsageTimelineBucket => {
    const tokens = Math.round(41_000_000 * (0.4 + Math.abs(Math.sin(index * 0.7))));
    return {
      bucketStartMs: LAST_MS - (29 - index) * DAY_MS,
      bucketLabel: String(index),
      tokens,
      costUSD: tokens * 0.0000042,
      byModel: MODEL_MIX.map((entry) => ({
        modelId: entry.modelId,
        tokens: Math.round(tokens * entry.weight),
        costUSD: 0,
      })),
      byUser: members.map((entry) => ({
        userId: entry.userId,
        tokens: Math.round(tokens * entry.weight),
        costUSD: 0,
      })),
    };
  });
  const tokens = buckets.reduce((sum, item) => sum + item.tokens, 0);
  return {
    workspaceId: 'ws-demo',
    range: 'month',
    startMs: buckets[0]!.bucketStartMs,
    endMs: LAST_MS,
    bucketSizeMs: DAY_MS,
    totals: { tokens, costUSD: tokens * 0.0000042 },
    users: Object.fromEntries(members.map((entry) => [entry.userId, { name: entry.name }])),
    buckets,
  };
}

const meta = {
  title: 'Settings/UsageShareImageDialog',
  component: UsageShareImageDialog,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof UsageShareImageDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

function DialogHarness(args: ComponentProps<typeof UsageShareImageDialog>) {
  const [open, setOpen] = useState(args.open);
  return <UsageShareImageDialog {...args} open={open} onOpenChange={setOpen} />;
}

const renderDialog: Story['render'] = (args) => <DialogHarness {...args} />;

export const Default: Story = {
  args: {
    open: true,
    onOpenChange: () => {},
    calendar: CALENDAR,
    timeline: buildTimeline(3),
    range: 'month',
    workspaceName: 'Loro',
  },
  render: renderDialog,
};

/** One contributor: the member mode stays disabled rather than shipping a one-row leaderboard. */
export const SingleContributor: Story = {
  ...Default,
  args: { ...Default.args, timeline: buildTimeline(1) },
};

/** No timeline yet: the card falls back to the calendar and drops the split block. */
export const TimelinePending: Story = {
  ...Default,
  args: { ...Default.args, timeline: undefined },
};
