import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';

import { WeekBento } from '@/components/chat/home/week-bento';
import { homeWeekAgentIcon, homeWeekAgentLabel, homeWeekFixture } from './fixtures/home-week';
const storyLayout = stylex.create({
  frame: {
    width: '640px',
    'max-width': '100%',
    'border-radius': 'var(--radius-2xl)',
    'background-color': 'hsl(var(--background) / 1)',
    padding: 'calc(var(--spacing) * 10)',
    color: 'hsl(var(--foreground) / 1)',
  },
});

const meta = {
  title: 'Chat/WeekBento',
  component: WeekBento,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div {...stylex.props(storyLayout.frame)}>
        <Story />
      </div>
    ),
  ],
  args: {
    model: homeWeekFixture('busy'),
    agentLabel: homeWeekAgentLabel,
    agentIcon: homeWeekAgentIcon,
    animate: false,
  },
} satisfies Meta<typeof WeekBento>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A full week: code shipped with its activity wall, merged PRs, the agents and the repository. */
export const Busy: Story = {};

/** Two sessions: the comparison is omitted and the repository share is of very few sessions. */
export const Quiet: Story = {
  args: { model: homeWeekFixture('quiet') },
};

/** A quiet week, or an account with no sessions yet: the same tiles, at zero. */
export const NothingYet: Story = {
  args: { model: homeWeekFixture('new') },
};

/** Numbers roll up from zero and the wall fades in once when the page is shown. */
export const Rolling: Story = {
  args: { animate: true },
};

export const Dark: Story = {
  globals: { theme: 'dark' },
};
