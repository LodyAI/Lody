import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { Provider, createStore } from 'jotai';
import { workspaceContentModeAtom } from '@/atoms/workspace-content-mode';
import { WorkspaceFeatureNotice } from '@/components/workspace-feature-notice';

const meta = {
  title: 'Workspace/FeatureNotice',
  component: WorkspaceFeatureNotice,
  decorators: [
    (Story) => {
      const [store] = useState(() => {
        const value = createStore();
        value.set(workspaceContentModeAtom, {
          accountId: 'storybook',
          workspaceSlug: 'encrypted',
          workspaceId: 'encrypted',
          descriptor: { contentMode: 'e2ee', contentModeVersion: 1 },
        } as never);
        return value;
      });
      return (
        <Provider store={store}>
          <Story />
        </Provider>
      );
    },
  ],
} satisfies Meta<typeof WorkspaceFeatureNotice>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Schedules: Story = { args: { feature: 'schedules' } };
export const RemoteMachine: Story = { args: { feature: 'rpc' } };
export const CodeCollab: Story = { args: { feature: 'code-collab-index' } };
