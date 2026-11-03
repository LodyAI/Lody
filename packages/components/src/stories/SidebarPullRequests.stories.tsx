import type { Meta, StoryObj } from '@storybook/react';
import { SidebarPullRequests } from '../components/sidebar-pull-requests';

const meta = { title: 'Sidebar/Pull requests', component: SidebarPullRequests } satisfies Meta<
  typeof SidebarPullRequests
>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Single: Story = {
  args: {
    alignWithBranch: true,
    pullRequests: [{ url: 'https://github.com/example/one/pull/42', status: 'open' }],
  },
};

export const Multiple: Story = {
  args: {
    alignWithBranch: true,
    pullRequests: [
      { url: 'https://github.com/example/one/pull/42', status: 'open' },
      { url: 'https://github.com/example/two/pull/42', status: 'merged' },
      { url: 'https://github.com/example/three/pull/7', status: 'draft' },
    ],
  },
};

export const Merged: Story = {
  args: {
    pullRequests: [{ url: 'https://github.com/example/one/pull/42', status: 'merged' }],
  },
};
