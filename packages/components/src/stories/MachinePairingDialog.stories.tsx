import { buildDaemonInstallCommands } from '@/lib/daemon-installation';
import type { Meta, StoryObj } from '@storybook/react';
import { MachinePairingDialog } from '@/components/chat/machine-pairing-dialog';

const requestId = 'pairing-request-story';
const { command, windowsCommand } = buildDaemonInstallCommands({
  auth: 'lody_pair_example',
});

const meta = {
  title: 'Chat/MachinePairingDialog',
  component: MachinePairingDialog,
  args: {
    open: true,
    onOpenChange: () => {},
    requestId,
    status: 'pending',
    command,
    windowsCommand,
    expiresAt: Date.now() + 30 * 60 * 1000,
    creating: false,
    createError: null,
    onRetry: () => {},
    onCancelRequest: async () => {},
    onConfigureAgents: () => {},
  },
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof MachinePairingDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Pending: Story = {};

export const Claimed: Story = {
  args: { status: 'claimed', command: null },
};

export const Registered: Story = {
  args: { status: 'registered', command: null },
};

export const Connected: Story = {
  args: {
    status: 'registered',
    command: null,
    machineId: 'machine-story',
    machineName: 'zx-macbook',
  },
};

export const Expired: Story = {
  args: { status: 'expired', command: null },
};

export const Creating: Story = {
  args: { requestId: null, status: null, command: null, creating: true, expiresAt: null },
};

export const CreateFailed: Story = {
  args: {
    requestId: null,
    status: null,
    command: null,
    creating: false,
    createError: 'network_error',
    expiresAt: null,
  },
};
