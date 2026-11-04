import type { Meta, StoryObj } from '@storybook/react';
import { CreditCard, Github, MailCheck, Terminal } from 'lucide-react';

import { Button } from '@lody/ui/button';
import { SecondaryPage } from '@/components/pages/secondary-page';

const meta = {
  title: 'Pages/SecondaryPage',
  component: SecondaryPage,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  args: {
    from: <Github size={22} strokeWidth={1.6} aria-hidden="true" />,
    markLabel: 'GitHub and Lody',
    title: 'Continue in Lody Desktop',
    description: 'GitHub is installed. Finish connecting it in the app.',
  },
} satisfies Meta<typeof SecondaryPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Lody is still checking what arrived: the connector flows, no action yet. */
export const Arrive: Story = {
  args: {
    state: 'arrive',
    title: 'Connecting GitHub',
    description: 'Getting Lody Desktop ready',
  },
};

/** The next move is the person's: the connector carries an arrow. */
export const Ask: Story = {
  args: {
    state: 'ask',
    actions: (
      <>
        <Button variant="secondary" size="large">
          Copy link
        </Button>
        <Button size="large">Open Lody Desktop</Button>
      </>
    ),
    note: 'Nothing happened? Copy the link and paste it into the address bar.',
  },
};

/** One action spans the row; here the value sits in the one recessed well. */
export const Done: Story = {
  args: {
    state: 'done',
    from: <MailCheck size={22} strokeWidth={1.6} aria-hidden="true" />,
    markLabel: 'Email and Lody',
    title: 'Email verified',
    description: 'You can now sign in.',
    well: <span>user@example.com</span>,
    actions: <Button size="large">Sign in now</Button>,
    note: 'Redirecting to sign in in 3s…',
  },
};

/** The node is outlined in the destructive colour and the right tile fades. */
export const Blocked: Story = {
  args: {
    state: 'blocked',
    from: <CreditCard size={22} strokeWidth={1.6} aria-hidden="true" />,
    markLabel: 'Stripe and Lody',
    title: 'Payment failed',
    description: 'Your card was not charged. Try again from Lody Desktop.',
    actions: (
      <Button variant="secondary" size="large">
        Back to home
      </Button>
    ),
  },
};

/** A free content slot between the title and the actions, e.g. a form's fields. */
export const WithFormContent: Story = {
  args: {
    state: 'ask',
    from: <Terminal size={22} strokeWidth={1.6} aria-hidden="true" />,
    markLabel: 'Terminal and Lody',
    title: 'Device Authorization',
    description: 'Enter the verification code displayed in your CLI to authorize device access',
    children: (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 500 }}>Verification Code</span>
        <code style={{ fontSize: 20, letterSpacing: '0.2em' }}>ABCD-1234</code>
      </div>
    ),
    note: 'Login as Ada (ada@example.com)',
    actions: <Button size="large">Verify &amp; Authorize</Button>,
  },
};
