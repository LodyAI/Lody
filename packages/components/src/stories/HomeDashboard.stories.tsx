import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { FOCUS_TUNING, tuneFocusMotion } from '@/components/chat/home/focus-motion';
import { HomeDashboard } from '@/components/chat/home/home-dashboard';
import { WebChatLandingScreen } from '@/components/chat/web-chat-landing-screen';
import {
  HOME_WEEK_NOW,
  HOME_WEEK_USAGE_SOURCES,
  homeNowFixture,
  homeWeekAgentIcon,
  homeWeekAgentLabel,
  homeWeekFixture,
  homeWeekUsageFixture,
} from './fixtures/home-week';

const meta = {
  title: 'Chat/HomeDashboard',
  component: HomeDashboard,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  decorators: [
    (Story, context) =>
      context.parameters.layout === 'fullscreen' ? (
        <Story />
      ) : (
        <div className="w-[720px] max-w-full rounded-2xl bg-background p-10 text-foreground">
          <Story />
        </div>
      ),
  ],
  args: {
    now: homeNowFixture('busy'),
    week: homeWeekFixture('busy'),
    agentLabel: homeWeekAgentLabel,
    agentIcon: homeWeekAgentIcon,
    usage: homeWeekUsageFixture(),
    usageSources: HOME_WEEK_USAGE_SOURCES,
    usageSourceId: HOME_WEEK_USAGE_SOURCES[0]!.id,
    nowMs: HOME_WEEK_NOW.getTime(),
    onOpenSession: fn(),
    animate: false,
  },
} satisfies Meta<typeof HomeDashboard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** What the agents are doing: what needs you, the plan usage, what runs, what finished, what to pick back up. */
export const Now: Story = {};

/** The 5-hour window is nearly spent; the Codex reset the forecast knows about sits beside it. */
export const NowNearReset: Story = {
  args: {
    usage: homeWeekUsageFixture('nearReset'),
    forecast: { title: 'Codex reset forecast', chancePercent: 65, when: 'Today 2:00 PM' },
  },
};

/** No provider reports a plan: the lists pair up from the first row. */
export const NowWithoutUsage: Story = {
  args: { usage: null },
};

/** Nothing running or waiting: every list at its title in its place, beside the usage. */
export const AllQuiet: Story = {
  args: { now: homeNowFixture('quiet') },
};

/** The last seven days, switched to from the line; both segments keep their summaries. */
export const Week: Story = {
  args: { defaultBoard: 'week' },
};

/** Everything folded into the line: the same centred line, with no board under it. */
export const Folded: Story = {
  args: { defaultBoard: null },
};

function landingAt(height: string, storyArgs: Story['args'] = { defaultBoard: 'now' }): Story {
  return {
    args: storyArgs,
    parameters: { layout: 'fullscreen' },
    render: (args) => (
      <div style={{ height }}>
        <WebChatLandingScreen
          title="Let's ship something"
          ambient={<HomeDashboard {...args} />}
          composer={<div style={{ height: 120 }} />}
        />
      </div>
    ),
  };
}

/** The real landing stage: switching boards keeps the line in place; folding re-centres it. */
export const Landing: Story = landingAt('100vh', {});

/**
 * A short window under load: the lists give way to the rows the stage has room for, lower lists
 * first, and both columns end on one line. "Show all" opens a whole list over its column.
 */
export const LandingShortWindow: Story = landingAt('620px');

type MotionArgs = typeof FOCUS_TUNING;

/**
 * Tuning the whole list: press a tile's "Show all". The pressed tile grows to its column while the
 * rest of the column steps back; "Show less" at its foot lands it back in its tile. One spring
 * for both ways: response is the period in seconds, damping 1 means no overshoot. `slow`
 * multiplies every time, to watch it frame by frame.
 */
export const ShowAllMotion: StoryObj<MotionArgs> = {
  parameters: { layout: 'fullscreen' },
  args: { ...FOCUS_TUNING },
  argTypes: {
    response: { control: { type: 'range', min: 0.2, max: 1, step: 0.02 } },
    damping: { control: { type: 'range', min: 0.5, max: 1, step: 0.02 } },
    depth: { control: { type: 'range', min: 0.8, max: 1, step: 0.01 } },
    slow: { control: { type: 'range', min: 1, max: 6, step: 0.5 } },
  },
  render: (tuning) => {
    tuneFocusMotion(tuning);
    return (
      <div style={{ height: '100vh' }}>
        <WebChatLandingScreen
          title="Let's ship something"
          ambient={<HomeDashboard {...meta.args} defaultBoard="now" />}
          composer={<div style={{ height: 120 }} />}
        />
      </div>
    );
  },
};

/** Too short for even one row per list: the board folds into its line until there is room. */
export const LandingTinyWindow: Story = landingAt('380px');

export const Dark: Story = {
  globals: { theme: 'dark' },
};
