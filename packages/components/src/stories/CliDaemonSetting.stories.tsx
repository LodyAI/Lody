import type { Meta, StoryObj } from '@storybook/react';
import type { ElectronCliState } from '@lody/shared';
import { CliDaemonSetting } from '@/components/settings/cli-daemon-setting';
import { CompactSection } from '@/components/settings/compact-layout';

function installElectronIpcMock(state: ElectronCliState): void {
  if (typeof window === 'undefined') return;
  window.__LODY_ELECTRON__ = true;
  window.ipc = {
    invoke: async (channel) => {
      if (channel === 'cli.getState') return state;
      if (channel === 'cli.restart') return { ok: true };
      if (channel === 'cli.terminate') return { ok: true };
      throw new Error(`unexpected invoke ${channel}`);
    },
    on: (channel, listener) => {
      if (channel === 'cli.state') listener(state);
      return () => {};
    },
    send: () => {},
  };
}

function Harness({ cliState }: { cliState: ElectronCliState }) {
  installElectronIpcMock(cliState);
  return (
    <div className="w-[640px] bg-background p-4">
      <CompactSection title="Startup">
        <CliDaemonSetting />
      </CompactSection>
    </div>
  );
}

const runningCliState: ElectronCliState = {
  phase: 'running',
  desiredState: 'running',
  localAgentEnabled: true,
  updatedAtMs: 0,
  preventSleepEnabled: true,
  connectivity: 'online',
};

const meta = {
  title: 'Desktop/CliDaemonSetting',
  component: Harness,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Running: Story = {
  args: { cliState: runningCliState },
};

export const Stopped: Story = {
  args: {
    cliState: {
      phase: 'stopped',
      desiredState: 'stopped',
      localAgentEnabled: true,
      updatedAtMs: 0,
      preventSleepEnabled: true,
    },
  },
};

export const LocalAgentDisabled: Story = {
  args: {
    cliState: {
      phase: 'stopped',
      desiredState: 'stopped',
      localAgentEnabled: false,
      updatedAtMs: 0,
      preventSleepEnabled: true,
    },
  },
};

export const Degraded: Story = {
  args: {
    cliState: { ...runningCliState, phase: 'degraded' },
  },
};

export const HostAccessDenied: Story = {
  args: {
    cliState: {
      phase: 'fatal',
      desiredState: 'running',
      localAgentEnabled: true,
      updatedAtMs: 0,
      preventSleepEnabled: true,
      hostAccessDenied: true,
    },
  },
};
