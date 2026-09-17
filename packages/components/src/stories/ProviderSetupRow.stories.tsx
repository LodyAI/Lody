import type { Meta, StoryObj } from '@storybook/react';
import {
  getServerNow,
  type AgentConfigId,
  type MachineId,
  type MachineViewMeta,
  type ProviderSetupTask,
} from '@lody/shared';

import { ProviderSetupRow } from '@/components/settings/provider-setup-row';

const machineId = 'machine-provider-setup' as MachineId;
const now = getServerNow();
const machine: MachineViewMeta = {
  id: machineId,
  name: 'Workstation',
  cliVersion: '0.76.0',
  os: 'linux',
  sessions: [],
  raceLimits: {},
  protocolCapabilities: { providerSetup: 1 },
};

const baseSetup: ProviderSetupTask = {
  v: 1,
  id: 'provider-setup-codex' as AgentConfigId,
  machineId,
  config: {
    id: 'provider-setup-codex' as AgentConfigId,
    machineId,
    name: 'Codex',
    description: undefined,
    cliType: 'builtin',
    agentType: 'codex',
    env: {},
  },
  status: 'queued',
  attempt: 1,
  createdAt: now,
  updatedAt: now,
};

const meta = {
  title: 'Settings/ProviderSetupRow',
  component: ProviderSetupRow,
  decorators: [
    (Story) => (
      <div className="w-[560px] max-w-[calc(100vw-2rem)]">
        <Story />
      </div>
    ),
  ],
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  args: {
    setup: baseSetup,
    machine,
    onRetry: async () => {},
    onDelete: async () => {},
  },
} satisfies Meta<typeof ProviderSetupRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Queued: Story = {};

export const PreparingRuntime: Story = {
  args: {
    setup: { ...baseSetup, status: 'preparing-runtime' },
  },
};

export const Verifying: Story = {
  args: {
    setup: { ...baseSetup, status: 'verifying' },
  },
};

export const AwaitingAuthentication: Story = {
  args: {
    setup: { ...baseSetup, status: 'awaiting-auth' },
  },
};

export const RuntimeDownloadFailed: Story = {
  args: {
    setup: {
      ...baseSetup,
      status: 'failed',
      failureCode: 'runtime-install-failed',
    },
  },
};

export const VerificationFailed: Story = {
  args: {
    setup: {
      ...baseSetup,
      status: 'failed',
      failureCode: 'verification-failed',
    },
  },
};

export const BubNotInstalled: Story = {
  args: {
    setup: {
      ...baseSetup,
      config: { ...baseSetup.config, agentType: 'bub', name: 'Bub' },
      status: 'failed',
      failureCode: 'runtime-unavailable',
    },
  },
};
