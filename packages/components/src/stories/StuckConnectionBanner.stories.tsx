import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

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
    // The banner positions itself fixed at the viewport top.
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
