import { E2eeSettingsGlyph } from '@/components/settings/e2ee/security-state';
import type { Meta, StoryObj } from '@storybook/react';
import { E2eeDevicesPanel, E2eeSecurityPanel } from '@/components/settings/e2ee/security-panel';
const state = {
  epoch: 3,
  rotationRequired: true,
  updatePending: false,
  mayRotate: true,
  devices: [
    {
      key: 'a1'.repeat(32),
      kind: 'personal' as const,
      machineId: null,
      self: true,
      mayRevoke: false,
    },
    {
      key: 'b2'.repeat(32),
      kind: 'machine' as const,
      machineId: 'MacBook-Pro',
      self: false,
      mayRevoke: true,
    },
  ],
};
const meta = {
  title: 'Settings/Encrypted workspace security',
  component: E2eeSecurityPanel,
  args: {
    state,
    onUpdate: () => {},
    onRetry: () => {},
    onOpenConsole: () => {},
  },
  parameters: { layout: 'padded' },
} satisfies Meta<typeof E2eeSecurityPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Current: Story = { args: { state: { ...state, rotationRequired: false } } };
export const KeyUpdateNeeded: Story = {};
export const JoinRequestWaiting: Story = {
  args: { state: { ...state, rotationRequired: false }, joinRequests: true },
};
export const StagingRetry: Story = {
  args: { error: 'e2ee_management_retry', state: { ...state, updatePending: true } },
};
export const NoAdministrator: Story = { args: { state: { ...state, mayRotate: false } } };
export const IdentityLost: Story = { args: { state: undefined } };
/** The entry card's failure in the console's card format: one step that helps. */
export const IdentityLostError: Story = {
  args: { state: undefined, error: 'e2ee_missing-binding', onOpenConsole: () => {} },
};
export const RestartRequired: Story = {
  args: { state: { ...state, updatePending: true }, error: 'e2ee_restart-required' },
};
export const CandidateRecovery: Story = {
  args: {
    error: 'e2ee_rotation_candidate_unavailable',
    state: { ...state, rotationRequired: false, updatePending: true },
  },
};

/** The console's Devices tab: every device with revoke, and the key update it leaves. */
export const ConsoleDevices: Story = {
  render: (args) => (
    <E2eeDevicesPanel
      state={args.state}
      onUpdate={() => {}}
      onRetry={() => {}}
      onRevoke={() => {}}
    />
  ),
};

export const SettingsEntryAttention: Story = {
  render: () => (
    <span style={{ display: 'inline-flex', width: 20, height: 20 }}>
      <E2eeSettingsGlyph attention />
    </span>
  ),
};

/** Clicking remove opens the same explicit recovery-credential warning as production. */
export const LastPersonalDevice: Story = {
  ...ConsoleDevices,
  args: {
    state: {
      ...state,
      rotationRequired: false,
      devices: [
        {
          key: 'a1'.repeat(32),
          kind: 'personal',
          machineId: null,
          self: true,
          mayRevoke: true,
          requiresRecoveryConfirmation: true,
        },
        { key: 'c3'.repeat(32), kind: 'recovery', machineId: null, self: false, mayRevoke: false },
      ],
    },
  },
};
