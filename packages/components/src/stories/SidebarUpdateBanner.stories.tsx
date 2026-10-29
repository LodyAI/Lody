import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { useLayoutEffect, type ReactNode } from 'react';
import { SidebarUpdateBanner } from '@/components/sidebar-update-banner';

const meta: Meta<typeof SidebarUpdateBanner> = {
  title: 'Components/SidebarUpdateBanner',
  component: SidebarUpdateBanner,
  args: {
    version: '1.4.2',
    isRestarting: false,
    onViewChangelog: fn(),
    onRestart: fn(),
    onLater: fn(),
  },
  render: (args) => (
    <div className="w-72">
      <SidebarUpdateBanner {...args} />
    </div>
  ),
};

export default meta;
type Story = StoryObj<typeof SidebarUpdateBanner>;

export const Downloading: Story = {
  args: { stage: 'downloading', percent: 38 },
};

// Some feeds report no percent at all; the banner then drops the progress row
// instead of showing a bar stuck at zero.
export const DownloadingWithoutProgress: Story = {
  args: { stage: 'downloading', percent: null },
};

export const Downloaded: Story = {
  args: { stage: 'downloaded', percent: null },
};

export const Restarting: Story = {
  args: { stage: 'downloaded', percent: null, isRestarting: true },
};

function SpacingScope({ children, scope }: { children: ReactNode; scope: 'root' | 'subtree' }) {
  useLayoutEffect(() => {
    const target = scope === 'root' ? document.documentElement : document.body;
    const previous = target.style.getPropertyValue('--spacing');
    target.style.setProperty('--spacing', '5px');
    return () => {
      if (previous) target.style.setProperty('--spacing', previous);
      else target.style.removeProperty('--spacing');
    };
  }, [scope]);
  return <div data-update-spacing={scope}>{children}</div>;
}
export const RestartingRootSpacing: Story = {
  args: Restarting.args,
  decorators: [
    (Story) => (
      <SpacingScope scope="root">
        <Story />
      </SpacingScope>
    ),
  ],
};
export const RestartingSubtreeSpacing: Story = {
  args: Restarting.args,
  decorators: [
    (Story) => (
      <SpacingScope scope="subtree">
        <Story />
      </SpacingScope>
    ),
  ],
};
