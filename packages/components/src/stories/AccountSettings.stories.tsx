import type { Meta, StoryObj } from '@storybook/react';
import { AccountSettingsPure } from '@/components/settings';
import type { AccountSettingsPureProps } from '@/components/settings';
import type { Invitation } from 'better-auth/plugins';
import { userEvent, within } from 'storybook/test';

const mockCurrentUser = {
  id: 'user-1',
  name: 'Alice Chen',
  email: 'alice@example.com',
  image: null,
};

const mockOrganization = {
  id: 'org-1',
  name: 'Acme Corp',
  slug: 'acme-corp',
  logo: null,
};

const mockLinkedAccounts = [
  { id: 'acc-1', providerId: 'github', accountId: 'gh-1', createdAt: new Date('2025-01-15') },
  { id: 'acc-2', providerId: 'google', accountId: 'g-1', createdAt: new Date('2025-02-20') },
  { id: 'acc-3', providerId: 'credential', accountId: 'cred-1', createdAt: new Date('2024-12-01') },
];

const mockMembers = [
  {
    id: 'member-1',
    userId: 'user-1',
    role: 'owner',
    user: mockCurrentUser,
  },
  {
    id: 'member-2',
    userId: 'user-2',
    role: 'admin',
    user: {
      id: 'user-2',
      name: 'Bob Smith',
      email: 'bob@example.com',
      image: null,
    },
  },
  {
    id: 'member-3',
    userId: 'user-3',
    role: 'member',
    user: {
      id: 'user-3',
      name: 'Carol Wang',
      email: 'carol@example.com',
      image: null,
    },
  },
];

const mockPendingInvitations: Invitation[] = [
  {
    id: 'inv-1',
    email: 'dave@example.com',
    role: 'member',
    status: 'pending',
    organizationId: 'org-1',
    inviterId: 'user-1',
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    createdAt: new Date(),
    teamId: null,
  },
  {
    id: 'inv-2',
    email: 'eve@example.com',
    role: 'admin',
    status: 'pending',
    organizationId: 'org-1',
    inviterId: 'user-1',
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    createdAt: new Date(),
    teamId: null,
  },
];

const noop = async () => {};
const noopInvite = async () => null;

const defaultProps: AccountSettingsPureProps = {
  currentUser: mockCurrentUser,
  organization: mockOrganization,
  role: 'owner',
  hasAdminPermission: true,
  members: mockMembers,
  pendingInvitations: [],
  onSignOut: () => {},
  onInviteMember: noopInvite,
  onRemoveMember: noop,
  onUpdateRole: noop,
  onCopyInviteLink: noop,
  onCancelInvitation: noop,
  onLeaveOrganization: noop,
  onDeleteOrganization: noop,
  onDeleteAccount: noop,
  onRenameOrganization: noop,
  getInviteLink: (inv) => `https://app.example.com/invite/${inv.id}`,
  onUpdateUserName: noop,
  onUploadAvatar: async () => 'https://example.com/avatar.png',
  linkedAccounts: mockLinkedAccounts,
  isLoadingLinkedAccounts: false,
  hasPasswordCredential: true,
  onChangePassword: noop,
  onVerifyCurrentPassword: async () => true,
  onSetupPassword: noop,
};

const meta = {
  title: 'Settings/AccountSettings',
  component: AccountSettingsPure,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  args: defaultProps,
} satisfies Meta<typeof AccountSettingsPure>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OwnerView: Story = {};

export const WorkspaceGeneralMerged: Story = {
  args: {
    surface: 'workspace',
    pendingInvitations: mockPendingInvitations,
  },
};

export const MemberView: Story = {
  args: {
    role: 'member',
    hasAdminPermission: false,
  },
};

export const AdminView: Story = {
  args: {
    role: 'admin',
    hasAdminPermission: true,
  },
};

export const WithPendingInvitations: Story = {
  args: {
    pendingInvitations: mockPendingInvitations,
  },
};

export const FreeMemberLimitReached: Story = {
  args: {
    memberLimit: 3,
    memberLimitReached: true,
    onOpenBilling: () => {},
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /invite member/i }));
  },
};

export const WithCliAuthKey: Story = {
  args: {
    canGenerateCliApiKey: true,
    cliApiKeys: [
      {
        id: 'key-1',
        name: 'Lody CLI Token',
        keyStart: 'lody_cli_',
        keyPreview: 'lody_cli_abc******123456',
        note: 'CI runner',
        source: 'manual',
        createdAt: Date.now() - 60_000,
        lastRequest: Date.now() - 120_000,
        expiresAt: null,
        enabled: true,
      },
      {
        id: 'key-2',
        name: 'Lody CLI Token',
        keyStart: 'lody_cli_',
        keyPreview: 'lody_cli_xyz******654321',
        note: null,
        source: 'auto',
        createdAt: Date.now() - 600_000,
        lastRequest: null,
        expiresAt: null,
        enabled: true,
      },
    ],
    isCreatingCliApiKey: false,
    onGenerateCliApiKey: noop,
    onCopyGeneratedCliApiKey: noop,
    onRevokeCliApiKey: noop,
  },
};

export const Loading: Story = {
  args: {
    loading: true,
  },
};

export const DarkMode: Story = {
  globals: {
    theme: 'dark',
  },
};

export const DarkModeWithInvitations: Story = {
  globals: {
    theme: 'dark',
  },
  args: {
    pendingInvitations: mockPendingInvitations,
  },
};
