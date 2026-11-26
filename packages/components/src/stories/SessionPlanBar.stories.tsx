import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';

import type { SessionPlanEntry } from '@lody/shared';

import { SessionPlanBar } from '@/components/sessions/session-plan-bar';

const storyStyles = stylex.create({
  planFrame: { width: '520px', maxWidth: 'calc(100vw - 2rem)' },
});

const meta = {
  title: 'Sessions/SessionPlanBar',
  component: SessionPlanBar,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof SessionPlanBar>;

export default meta;
type Story = StoryObj<typeof meta>;

const samplePlan: SessionPlanEntry[] = [
  { status: 'completed', content: 'Scan repo structure and entry points', priority: 'low' },
  { status: 'in_progress', content: 'Add plan field to session schema', priority: 'high' },
  { status: 'pending', content: 'Sync ACP plan updates into Loro doc', priority: 'high' },
  { status: 'pending', content: 'Render plan bar above chat input', priority: 'medium' },
];

export const Collapsed: Story = {
  args: {
    entries: samplePlan,
    defaultOpen: false,
  },
  render: (args) => (
    <div {...stylex.props(storyStyles.planFrame)}>
      <SessionPlanBar {...args} />
    </div>
  ),
};

export const Expanded: Story = {
  args: {
    entries: samplePlan,
    defaultOpen: true,
  },
  render: (args) => (
    <div {...stylex.props(storyStyles.planFrame)}>
      <SessionPlanBar {...args} />
    </div>
  ),
};

