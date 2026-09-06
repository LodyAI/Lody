import type { Meta, StoryObj } from '@storybook/react';
import { AccountProfileList } from '@/components/settings/account-profile-list';
const meta = {
  title: 'Settings/Account profiles',
  component: AccountProfileList,
  args: { onSignIn: () => {} },
} satisfies Meta<typeof AccountProfileList>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SystemDefault: Story = {
  args: {
    profiles: [
      {
        accountProfileId: 'system-default',
        label: 'System Default',
        identity: 'work@example.com',
        status: 'authenticated',
      },
    ],
  },
};
export const AdditionalAccounts: Story = {
  args: {
    profiles: [
      {
        accountProfileId: 'system-default',
        label: 'System Default',
        identity: 'work@example.com',
        status: 'authenticated',
      },
      {
        accountProfileId: 'account-b',
        label: 'Account B',
        identity: 'personal@example.com',
        status: 'authenticated',
      },
      { accountProfileId: 'account-c', label: 'Account C', status: 'unauthenticated' },
    ],
  },
};
export const UnknownStatus: Story = { args: { profiles: [] } };
