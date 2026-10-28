import { useState, type ReactNode } from 'react';
import { createStore, Provider } from 'jotai';
import { developerModeEnabledAtom, sessionContinuationBetaEnabledAtom } from '@/atoms/settings';
import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import {
  SessionContinuationTweaks,
  type SessionContinuationTweaksProps,
  type SessionContinuationTweaksValue,
} from '@/components/sessions/session-continuation-tweaks';

function Card({ children }: { children: ReactNode }) {
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
          width: 340,
          padding: 14,
          borderRadius: 12,
          background: 'var(--popover)',
          color: 'var(--popover-foreground)',
          boxShadow: 'var(--shadow-popover)',
        }}
      >
        {children}
      </div>
    </Provider>
  );
}

function StatefulTweaks(props: SessionContinuationTweaksProps) {
  const [value, setValue] = useState<SessionContinuationTweaksValue>(props.value);
  return (
    <Card>
      <SessionContinuationTweaks
        {...props}
        value={value}
        onChange={(key, checked) => {
          props.onChange(key, checked);
          setValue((current) => ({ ...current, [key]: checked }));
        }}
      />
    </Card>
  );
}

const meta = {
  title: 'Sessions/SessionContinuationTweaks',
  component: SessionContinuationTweaks,
  parameters: { layout: 'centered' },
  args: {
    value: {
      recoverCapacity: false,
      archiveAfterMerge: true,
      compactWhenIdle: false,
    },
    onChange: fn(),
  },
  render: (args) => <StatefulTweaks {...args} />,
} satisfies Meta<typeof SessionContinuationTweaks>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const QuotaUnavailable: Story = {
  args: {
    capabilities: {
      recoverCapacity: {
        supported: false,
        reason: '当前 Provider 没有可用的额度窗口',
      },
    },
  },
};
