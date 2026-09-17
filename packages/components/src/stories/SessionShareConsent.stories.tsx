import type { Meta, StoryObj } from '@storybook/react';
import { SessionShareConsent } from '@/components/sharing/session-share-request-cards';

const idle = {
  busy: false,
  phase: 'idle' as const,
  progress: 0,
  error: null,
  hasPending: false,
  canCapture: true,
  conflict: false,
};
const meta = {
  title: 'Sharing/SessionShareConsent',
  component: SessionShareConsent,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <div className="w-[min(560px,calc(100vw-32px))]">
        <Story />
      </div>
    ),
  ],
  args: {
    request: {
      purpose: 'Share the design discussion with a reviewer.',
      sessionIds: ['main', 'implementation'],
      status: 'pending',
    },
    titles: { main: 'Static conversation sharing', implementation: 'Implementation review' },
    management: idle,
    busy: false,
    published: false,
    failed: false,
    onApprove: () => {},
    onDeny: () => {},
  },
} satisfies Meta<typeof SessionShareConsent>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Consent: Story = {};
export const Publishing: Story = {
  args: {
    busy: true,
    management: { ...idle, busy: true, phase: 'uploading', progress: 42, hasPending: true },
  },
};
export const Published: Story = { args: { published: true } };
export const Failed: Story = {
  args: {
    management: { ...idle, error: 'Could not publish. Retry this frozen copy.', hasPending: true },
  },
};
