import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { useCallback, useState } from 'react';
import { fn } from 'storybook/test';
import { InviteScreenView, OnboardingBackdrop, type InviteEntry } from '@/components/onboarding';

const storyStyles = stylex.create({
  stage: { position: 'relative', minHeight: 760, width: '100%' },
  content: {
    position: 'relative',
    zIndex: 10,
    display: 'flex',
    minHeight: 760,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 'calc(var(--spacing) * 8)',
  },
});

function InvitePreviewWrapper({ children }: { children: React.ReactNode }) {
  return (
    <div {...stylex.props(storyStyles.stage)}>
      <OnboardingBackdrop />
      <div {...stylex.props(storyStyles.content)}>{children}</div>
    </div>
  );
}

function InteractiveInviteScreen({ initial }: { initial?: InviteEntry[] } = {}) {
  const [email, setEmail] = useState('');
  const [invites, setInvites] = useState<InviteEntry[]>(initial ?? []);
  const [sending, setSending] = useState(false);

  const handleAdd = useCallback(() => {
    const trimmed = email.trim();
    if (!trimmed) return;
    setInvites((prev) => [
      ...prev,
      { id: `${Date.now()}-${Math.random()}`, email: trimmed, status: 'pending' },
    ]);
    setEmail('');
  }, [email]);

  const handleSendAndContinue = useCallback(() => {
    setSending(true);
    setInvites((prev) =>
      prev.map((entry) => (entry.status === 'pending' ? { ...entry, status: 'sending' } : entry))
    );
    setTimeout(() => {
      setInvites((prev) =>
        prev.map((entry, idx) =>
          entry.status === 'sending'
            ? idx % 3 === 0
              ? { ...entry, status: 'failed', errorMessage: 'Email rejected by upstream' }
              : { ...entry, status: 'sent' }
            : entry
        )
      );
      setSending(false);
    }, 1200);
  }, []);

  return (
    <InviteScreenView
      email={email}
      onEmailChange={setEmail}
      onAdd={handleAdd}
      onRemove={(id) => setInvites((prev) => prev.filter((e) => e.id !== id))}
      invites={invites}
      sending={sending}
      inputError={null}
      onSkip={fn()}
      onBack={fn()}
      onSendAndContinue={handleSendAndContinue}
    />
  );
}

const meta = {
  title: 'Onboarding/InviteScreen',
  component: InviteScreenView,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  args: {
    onEmailChange: fn(),
    onAdd: fn(),
    onRemove: fn(),
    onSkip: fn(),
    onBack: fn(),
    onSendAndContinue: fn(),
  },
  decorators: [
    (Story) => (
      <InvitePreviewWrapper>
        <Story />
      </InvitePreviewWrapper>
    ),
  ],
} satisfies Meta<typeof InviteScreenView>;

export default meta;
type Story = StoryObj<typeof meta>;

const sample: InviteEntry[] = [
  { id: '1', email: 'alice@team.dev', status: 'pending' },
  { id: '2', email: 'bob@team.dev', status: 'pending' },
];

const mixed: InviteEntry[] = [
  { id: '1', email: 'alice@team.dev', status: 'sent' },
  { id: '2', email: 'bob@team.dev', status: 'sending' },
  { id: '3', email: 'charlie@team.dev', status: 'failed', errorMessage: 'Email rejected by upstream' },
  { id: '4', email: 'dana@team.dev', status: 'pending' },
];

export const Empty: Story = {
  args: {
    email: '',
    invites: [],
    sending: false,
    inputError: null,
  },
};

export const InputInvalid: Story = {
  args: {
    email: 'not-an-email',
    invites: [],
    sending: false,
    inputError: 'Enter a valid email address',
  },
};

export const TwoPending: Story = {
  args: {
    email: '',
    invites: sample,
    sending: false,
    inputError: null,
  },
};

export const SendingInProgress: Story = {
  args: {
    email: '',
    invites: sample.map((e) => ({ ...e, status: 'sending' })),
    sending: true,
    inputError: null,
  },
};

export const MixedStatuses: Story = {
  args: {
    email: '',
    invites: mixed,
    sending: false,
    inputError: null,
  },
};

export const ScrollsWhenLong: Story = {
  args: {
    email: '',
    invites: Array.from({ length: 9 }, (_, i) => ({
      id: `e-${i}`,
      email: `teammate-${i}@team.dev`,
      status: i % 4 === 0 ? 'sent' : 'pending',
    })),
    sending: false,
    inputError: null,
  },
};

export const Interactive: Story = {
  args: {
    email: '',
    invites: [],
    sending: false,
    inputError: null,
  },
  render: () => <InteractiveInviteScreen />,
};
