import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { useLayoutEffect, useState, type CSSProperties } from 'react';

import { StuckConnectionBanner } from '@/components/stuck-connection-banner';

const labels = {
  title: 'Still connecting…',
  description: 'This can be a sign-in, network or local data problem.',
  recover: 'Recover…',
  dismissAriaLabel: 'Dismiss',
};

const zhLabels = {
  title: '连接时间较长',
  description: '可能是登录、网络或本地数据异常',
  recover: '恢复选项',
  dismissAriaLabel: '关闭',
};

const meta = {
  title: 'Workspace/StuckConnectionBanner',
  component: StuckConnectionBanner,
  args: {
    labels,
    onRecover: fn(),
    onDismiss: fn(),
  },
  parameters: {
    // The production banner owns its fixed placement above the mobile dock.
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="relative h-64 bg-background">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StuckConnectionBanner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Chinese: Story = {
  args: {
    labels: zhLabels,
  },
};

export const NarrowMobileViewport: Story = {
  decorators: [
    (Story) => (
      <div className="relative h-64 w-[360px] bg-background">
        <Story />
      </div>
    ),
  ],
};

function ObservedBanner({ scope }: { scope?: 'root' | 'subtree' }) {
  const [result, setResult] = useState('No action requested');
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const root = document.documentElement;
    const previous = root.style.getPropertyValue('--muted-foreground');
    if (scope === 'root') root.style.setProperty('--muted-foreground', '285 65% 42%');
    setReady(true);
    return () => {
      if (scope !== 'root') return;
      if (previous) root.style.setProperty('--muted-foreground', previous);
      else root.style.removeProperty('--muted-foreground');
    };
  }, [scope]);
  return (
    <div
      data-stuck-banner-observed=""
      data-stuck-banner-ready={ready}
      style={
        scope === 'subtree' ? ({ '--muted-foreground': '285 65% 42%' } as CSSProperties) : undefined
      }
    >
      <StuckConnectionBanner
        labels={
          scope
            ? {
                ...labels,
                title:
                  'Still connecting to the synthetic development workspace with a longer title…',
                description:
                  'The synthetic workspace is waiting for its initial connection. Existing rows and local preferences remain available while recovery options are reviewed.',
              }
            : labels
        }
        onRecover={() => setResult('Recovery callback requested')}
        onDismiss={() => setResult('Dismiss callback requested')}
      />
      <output data-stuck-banner-result="">{result}</output>
    </div>
  );
}

export const ObservedActions: Story = { render: () => <ObservedBanner /> };
export const RootInk: Story = { render: () => <ObservedBanner scope="root" /> };
export const SubtreeInk: Story = { render: () => <ObservedBanner scope="subtree" /> };
