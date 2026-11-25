import type { Meta, StoryObj } from '@storybook/react';
import type { MachineLifecycleCapability } from '@lody/shared';
import { MachineBatchUpdateDialog } from '@/components/settings/machine-batch-update-dialog';

const daemon: MachineLifecycleCapability = {
  launchMode: 'daemon',
  canRemoteRestart: true,
  canRemoteUpgrade: true,
};
const capabilities: Record<string, MachineLifecycleCapability> = {
  'studio-mac': daemon,
  'build-box': daemon,
  laptop: {
    launchMode: 'electron',
    canRemoteRestart: false,
    canRemoteUpgrade: false,
    reason: 'electron',
  },
  'windows-pc': {
    launchMode: 'daemon',
    canRemoteRestart: true,
    canRemoteUpgrade: false,
    reason: 'unsupported_install',
  },
};
const machine = (
  id: string,
  name: string,
  overrides: { isOnline?: boolean; os?: string; running?: number } = {}
) => ({
  id,
  name,
  os: overrides.os ?? 'linux',
  isOwn: true,
  isOnline: overrides.isOnline ?? true,
  cliVersion: '1.4.0',
  supportsManagedUpdates: true,
  runningSessionCount: overrides.running ?? 0,
});

const meta = {
  title: 'Settings/MachineBatchUpdateDialog',
  component: MachineBatchUpdateDialog,
  args: {
    open: true,
    onOpenChange: () => {},
    latestByChannel: { stable: '1.5.0' },
    machines: [
      machine('studio-mac', 'Studio Mac', { os: 'darwin', running: 2 }),
      machine('build-box', 'Build box'),
      machine('laptop', 'Laptop'),
      machine('windows-pc', 'Windows PC', { os: 'win32' }),
      machine('home-server', 'Home server', { isOnline: false }),
    ],
    probe: async (machineId: string) => ({ lifecycle: capabilities[machineId] ?? null }),
    requestUpgrade: async () => {},
  },
  tags: ['autodocs'],
} satisfies Meta<typeof MachineBatchUpdateDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Review: Story = {};

export const RequestRejected: Story = {
  args: {
    requestUpgrade: async () => {
      throw new Error('Update authorization expired');
    },
  },
};
