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
        disabled={false}
        paidRequired={false}
        onChange={fn()}
      />
    ),
  },
};
