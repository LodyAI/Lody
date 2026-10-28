import { useState, type ReactNode } from 'react';
import { createStore, Provider } from 'jotai';
import { developerModeEnabledAtom, sessionContinuationBetaEnabledAtom } from '@/atoms/settings';
import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import {
  SessionContinuationNote,
  type SessionContinuationNoteProps,
} from '@/components/sessions/session-continuation-note';
import type { SessionContinuationView } from '@/components/sessions/session-continuation';

const NOW = 1_700_000_000_000;

const waiting: SessionContinuationView = {
  id: 'wait-ci',
  reason: '等 CI 通过后继续',
  phase: 'waiting',
  nextCheckAt: NOW + 20_000,
  checkedAt: NOW - 10_000,
};

function Stage({ children, width = 680 }: { children: ReactNode; width?: number }) {
  const [store] = useState(() => {
    const next = createStore();
    next.set(developerModeEnabledAtom, true);
    next.set(sessionContinuationBetaEnabledAtom, true);
    return next;
  });
  return (
    <Provider store={store}>
      <div
        style={{
          width,
          minHeight: 220,
          padding: 28,
          background: 'var(--background)',
          color: 'var(--foreground)',
        }}
      >
        <div style={{ maxWidth: width - 56 }}>{children}</div>
      </div>
    </Provider>
  );
}

const meta = {
  title: 'Sessions/SessionContinuationNote',
  component: SessionContinuationNote,
  parameters: { layout: 'centered' },
  args: {
    view: waiting,
    now: NOW,
    onCancel: fn(),
    onResume: fn(),
    onAskAgent: fn(),
    onOpenTweaks: fn(),
  },
  render: (args: SessionContinuationNoteProps) => (
    <Stage width={args.compact ? 390 : 680}>
      <SessionContinuationNote {...args} />
    </Stage>
  ),
} satisfies Meta<typeof SessionContinuationNote>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Waiting: Story = {};

export const BlockedByStop: Story = {
  args: {
    view: {
      ...waiting,
      phase: 'matched',
      continuation: 'blocked',
      block: 'stopped',
      nextCheckAt: undefined,
    },
  },
};

export const Queued: Story = {
  args: {
    view: { ...waiting, phase: 'matched', continuation: 'queued', nextCheckAt: undefined },
  },
};

export const DeliveryUnknown: Story = {
  args: {
    view: { ...waiting, phase: 'matched', continuation: 'unknown', nextCheckAt: undefined },
  },
};

export const Failed: Story = {
  args: {
    view: { ...waiting, phase: 'failed', nextCheckAt: undefined },
  },
};

export const Offline: Story = {
  args: {
    view: { ...waiting, block: 'offline' },
  },
};

export const Phone: Story = {
  args: {
    compact: true,
  },
};
