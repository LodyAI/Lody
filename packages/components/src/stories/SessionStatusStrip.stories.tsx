import type { Meta, StoryObj } from '@storybook/react';
import {
  SessionStatusStrip,
  resolveSessionStatusStripState,
} from '@/components/sessions/session-status-strip';

const meta = {
  title: 'Sessions/SessionStatusStrip',
  component: SessionStatusStrip,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="w-[560px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SessionStatusStrip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BrowserOffline: Story = {
  args: { state: { kind: 'browser-offline' } },
};

export const MachineRemoved: Story = {
  args: { state: { kind: 'machine-removed' } },
};

export const MachineOffline: Story = {
  args: { state: { kind: 'machine-offline', machineName: 'zx MacBook-Pro.local' } },
};

export const MachineOfflineUnnamed: Story = {
  args: { state: { kind: 'machine-offline', machineName: null } },
};

export const Healthy: Story = {
  args: {
    state: resolveSessionStatusStripState({
      browserOnline: true,
      machineRemoved: false,
      machineOnlineStatus: 'online',
      machineName: 'zx MacBook-Pro.local',
    }),
  },
};

/** Presence transport not synced → machine state is unknown → no offline claim. */
export const PresenceUnknownStaysSilent: Story = {
  args: {
    state: resolveSessionStatusStripState({
      browserOnline: true,
      machineRemoved: false,
      machineOnlineStatus: 'unknown',
      machineName: 'zx MacBook-Pro.local',
    }),
  },
};

/** E2EE has no presence transport yet; absence is not evidence of being offline. */
export const EncryptedPresenceUnavailable: Story = {
  args: { state: { kind: 'presence-unavailable' } },
};
