import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import {
  SessionAccessReadFailed,
  SessionAccessUnavailable,
  SessionAccessWait,
} from '@/components/sessions/session-access-states';

/** The session pane while access to a conversation is decided, denied, or could not be checked. */
const meta = {
  title: 'Sessions/Session access states',
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div className="h-screen bg-background">
        <Story />
      </div>
    ),
  ],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** The mark fades in after a beat, so a short check shows only the empty pane. */
export const Opening: Story = { render: () => <SessionAccessWait /> };

export const NotShared: Story = { render: () => <SessionAccessUnavailable /> };

export const CheckFailed: Story = { render: () => <SessionAccessReadFailed onRetry={fn()} /> };
