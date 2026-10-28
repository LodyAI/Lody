import type { Meta, StoryObj } from '@storybook/react';
import { E2eeIdentityRecovery } from '@/components/pages/e2ee-identity-recovery';

const meta = {
  title: 'Components/E2eeIdentityRecovery',
  component: E2eeIdentityRecovery,
  args: {
    workspaceId: 'synthetic-workspace',
    error: 'e2ee_corrupt',
    runtime: {
      resetIdentity: async () => ({ archive: '/synthetic/archive' }),
      resetLocalAgent: async () => {},
    },
    onReset: () => {},
  },
  parameters: { layout: 'centered' },
} satisfies Meta<typeof E2eeIdentityRecovery>;
export default meta;
type Story = StoryObj<typeof meta>;
export const LostIdentity: Story = {};
export const LockedKeyring: Story = { args: { error: 'e2ee_custody_unavailable' } };
export const RepairPermissions: Story = { args: { error: 'e2ee_permissions' } };
export const LocalMachine: Story = { args: { error: 'e2ee_machine_corrupt', machine: true } };
