import { clsx } from 'clsx';
import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { SessionNotFound } from '@/components/sessions/session-not-found';
import { fn } from 'storybook/test';
const storyLayout = stylex.create({
  frame: {
    height: '100vh',
  },
  frame2: {
    height: '100vh',
    'background-color': 'hsl(var(--background) / 1)',
  },
});

/**
 * SessionNotFound component is displayed when a session cannot be found.
 * It provides a friendly message and navigation back to the sessions list.
 */
const meta = {
  title: 'Components/SessionNotFound',
  component: SessionNotFound,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  argTypes: {
    onBack: {
      description: 'Callback when the back button is clicked',
      action: 'back clicked',
    },
  },
  decorators: [
    (Story) => (
      <div {...stylex.props(storyLayout.frame)}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SessionNotFound>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Default state - shows the session not found message
 * with a back button to return to the sessions list.
 */
export const Default: Story = {
  args: {
    onBack: fn(),
  },
};

/**
 * Dark mode variant
 */
export const DarkMode: Story = {
  args: {
    onBack: fn(),
  },
  decorators: [
    (Story) => (
      <div className={clsx(stylex.props(storyLayout.frame2).className, 'dark')}>
        <Story />
      </div>
    ),
  ],
};

/**
 * Mobile viewport
 */
export const Mobile: Story = {
  args: {
    onBack: fn(),
  },
  parameters: {
    viewport: {
      defaultViewport: 'mobile1',
    },
  },
};

/**
 * Tablet viewport
 */
export const Tablet: Story = {
  args: {
    onBack: fn(),
  },
  parameters: {
    viewport: {
      defaultViewport: 'tablet',
    },
  },
};
