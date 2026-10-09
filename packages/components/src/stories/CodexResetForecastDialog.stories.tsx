import type { Meta, StoryObj } from '@storybook/react-vite';

import { CodexResetForecastDialog } from '@/components/codex-reset/codex-reset-forecast-dialog';
import type { CodexResetWatch } from '@/lib/codex-reset-forecast';

const NOW_MS = Date.parse('2026-08-20T06:00:00.000Z');

const watch: CodexResetWatch = {
  level: 'strong',
  chancePercent: 65,
  // Free text off the wire; the dialog shows it verbatim as a labelled window.
  windowText: 'the next 6 hours',
  observedAtIso: '2026-08-20T05:00:00.000Z',
  observedAtMs: Date.parse('2026-08-20T05:00:00.000Z'),
  expiresAtIso: '2026-08-20T11:00:00.000Z',
  expiresAtMs: Date.parse('2026-08-20T11:00:00.000Z'),
  text: 'Old news actually from a bunch of days ago, but crossed that 15M. Enjoy a nice reset everyone.',
  source: { author: 'thsottiaux', url: 'https://x.com/thsottiaux/status/1' },
};

const latestReset = {
  announcedAtIso: '2026-08-13T01:01:37.000Z',
  announcedAtMs: Date.parse('2026-08-13T01:01:37.000Z'),
  text: 'Enjoy a nice reset everyone. Landing in the next hour or so.',
  source: { author: 'thsottiaux', url: 'https://x.com/thsottiaux/status/2' },
};

const meta = {
  title: 'CodexReset/CodexResetForecastDialog',
  component: CodexResetForecastDialog,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  args: {
    open: true,
    onOpenChange: () => {},
    onRetry: () => {},
    nowMs: NOW_MS,
    isExpired: false,
    watch: null,
    state: { status: 'idle', data: null, error: null },
  },
} satisfies Meta<typeof CodexResetForecastDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ActiveForecast: Story = {
  args: {
    watch,
    state: { status: 'ready', data: { watch, latestReset, scheduledReset: null }, error: null },
  },
};

export const WithoutProbability: Story = {
  args: {
    watch: { ...watch, chancePercent: null, level: 'elevated' },
    state: {
      status: 'ready',
      data: {
        watch: { ...watch, chancePercent: null, level: 'elevated' },
        latestReset,
        scheduledReset: null,
      },
      error: null,
    },
  },
};

export const NoActiveWatch: Story = {
  args: {
    state: {
      status: 'ready',
      data: { watch: null, latestReset, scheduledReset: null },
      error: null,
    },
  },
};

export const ExpiredForecast: Story = {
  args: {
    isExpired: true,
    state: { status: 'ready', data: { watch, latestReset, scheduledReset: null }, error: null },
  },
};

export const Loading: Story = {
  args: {
    state: { status: 'loading', data: null, error: null },
  },
};

export const LoadFailed: Story = {
  args: {
    state: { status: 'error', data: null, error: 'fetch failed' },
  },
};

export const RefreshFailedWithStaleForecast: Story = {
  args: {
    watch,
    state: {
      status: 'error',
      data: { watch, latestReset, scheduledReset: null },
      error: 'fetch failed',
    },
  },
};

const scheduledReset = {
  ...latestReset,
  text: 'A reset is scheduled for later today.',
  scheduledForIso: new Date(NOW_MS + 14 * 3_600_000).toISOString(),
  scheduledForMs: NOW_MS + 14 * 3_600_000,
};

export const ScheduledReset: Story = {
  args: {
    state: { status: 'ready', data: { watch: null, latestReset, scheduledReset }, error: null },
  },
};
export const ScheduledAwaitingExecution: Story = {
  args: { ...ScheduledReset.args, nowMs: scheduledReset.scheduledForMs },
};
export const ScheduledWithoutTime: Story = {
  args: {
    state: {
      status: 'ready',
      data: {
        watch: null,
        latestReset,
        scheduledReset: { ...scheduledReset, scheduledForIso: null, scheduledForMs: null },
      },
      error: null,
    },
  },
};
