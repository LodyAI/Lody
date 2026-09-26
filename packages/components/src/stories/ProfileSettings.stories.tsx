import type { Meta, StoryObj } from '@storybook/react';
import { AvatarEditor } from '@/components/settings/avatar-editor';
import { AvatarCropDialog } from '@/components/settings/avatar-crop-dialog';
import { ChangePasswordButton } from '@/components/settings/change-password-button';
import { LinkedAccountsList } from '@/components/settings/linked-accounts-list';

const noop = async () => {};

const cropDemoFile = () =>
  new File(
    [
      Uint8Array.from(
        atob(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
        ),
        (character) => character.charCodeAt(0)
      ),
    ],
    'avatar.png',
    { type: 'image/png' }
  );

const mockAccounts = [
  { id: 'acc-1', providerId: 'github', accountId: 'gh-1', createdAt: new Date('2025-01-15') },
  { id: 'acc-2', providerId: 'google', accountId: 'g-1', createdAt: new Date('2025-02-20') },
  { id: 'acc-3', providerId: 'credential', accountId: 'cred-1', createdAt: new Date('2024-12-01') },
];

const meta = {
  title: 'Settings/ProfileSettings',
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const UserAvatarEmpty: Story = {
  render: () => (
    <AvatarEditor kind="user" name="Alice Chen" email="alice@example.com" onUpload={noop} />
  ),
};

export const UserAvatarWithImage: Story = {
  render: () => (
    <AvatarEditor
      kind="user"
      name="Alice Chen"
      email="alice@example.com"
      image="https://avatars.githubusercontent.com/u/1?v=4"
      onUpload={noop}
    />
  ),
};

export const WorkspaceAvatar: Story = {
  render: () => <AvatarEditor kind="workspace" name="Acme Corp" onUpload={noop} />,
};

export const AvatarCropper: Story = {
  render: () => (
    <AvatarCropDialog
      file={cropDemoFile()}
      kind="user"
      open
      onOpenChange={() => {}}
      onConfirm={async () => true}
    />
  ),
};

export const LinkedAccounts: Story = {
  render: () => (
    <div className="w-80">
      <LinkedAccountsList accounts={mockAccounts} onConnect={async () => {}} />
    </div>
  ),
};

export const LinkedAccountsAllConnected: Story = {
  render: () => (
    <div className="w-80">
      <LinkedAccountsList
        accounts={[
          { id: 'a1', providerId: 'github' },
          { id: 'a2', providerId: 'google' },
          { id: 'a3', providerId: 'apple' },
          { id: 'a4', providerId: 'discord' },
        ]}
      />
    </div>
  ),
};

export const LinkedAccountsLoading: Story = {
  render: () => (
    <div className="w-80">
      <LinkedAccountsList accounts={[]} loading />
    </div>
  ),
};

export const LinkedAccountsNoneBound: Story = {
  render: () => (
    <div className="w-80">
      <LinkedAccountsList accounts={[]} />
    </div>
  ),
};

export const ChangePassword: Story = {
  render: () => (
    <ChangePasswordButton
      hasPassword
      onChangePassword={noop}
      onVerifyCurrentPassword={async () => true}
      onSetupPassword={noop}
    />
  ),
};

export const SetupPassword: Story = {
  render: () => (
    <ChangePasswordButton hasPassword={false} onChangePassword={noop} onSetupPassword={noop} />
  ),
};
