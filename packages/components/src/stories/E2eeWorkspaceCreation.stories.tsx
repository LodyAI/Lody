import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { CreateWorkspacePage } from '@/components/pages/create-workspace-page';
import { E2eeWorkspaceCreationOption } from '@/components/pages/e2ee-workspace-creation-option';

const meta = {
  title: 'Pages/EncryptedWorkspaceCreation',
  component: CreateWorkspacePage,
  parameters: { layout: 'fullscreen' },
  args: {
    workspaceName: 'Synthetic',
    workspaceSlug: 'synthetic',
    slugAvailable: true,
    onWorkspaceNameChange: fn(),
    onWorkspaceSlugChange: fn(),
    onResetWorkspaceSlug: fn(),
    onSubmit: fn(),
  },
} satisfies Meta<typeof CreateWorkspacePage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Available: Story = {
  args: {
    creationOptions: (
      <E2eeWorkspaceCreationOption
        selected
        supported
        pending={false}
        disabled={false}
        paidRequired={false}
        onChange={fn()}
      />
    ),
  },
};
export const UnsupportedHost: Story = {
  args: {
    creationOptions: (
      <E2eeWorkspaceCreationOption
        selected={false}
        supported={false}
        pending={false}
        disabled={false}
        paidRequired={false}
        onChange={fn()}
      />
    ),
  },
};
export const PendingRequests: Story = {
  args: {
    fieldsDisabled: true,
    retryPendingCreation: true,
    creationOptions: (
      <E2eeWorkspaceCreationOption
        selected
        supported
        pending
        disabled={false}
        paidRequired={false}
        onChange={fn()}
        requests={[
          {
            accountId: 'synthetic-account',
            requestId: 'request-1',
            name: 'Synthetic',
            slug: 'synthetic',
          },
          {
            accountId: 'synthetic-account',
            requestId: 'request-2',
            name: 'Research',
            slug: 'research',
          },
        ]}
        selectedRequestId="request-1"
        onSelectRequest={fn()}
        onNewRequest={fn()}
      />
    ),
  },
};
