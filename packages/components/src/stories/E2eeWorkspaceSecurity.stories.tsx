import { E2eeSettingsGlyph } from '@/components/settings/e2ee/security-state';
import type { Meta, StoryObj } from '@storybook/react';
import { E2eeDevicesPanel, E2eeSecurityPanel } from '@/components/settings/e2ee/security-panel';
const ownerAvatar = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#e5dccf"/><path d="M5 64c0-21 54-21 54 0" fill="#526b6b"/><ellipse cx="32" cy="27" rx="16" ry="20" fill="#e8ba94"/><path d="M16 27C9 0 55 0 48 29L40 15c-4 9-14 5-24 12" fill="#4a352b"/><circle cx="26" cy="28" r="1.5"/><circle cx="38" cy="28" r="1.5"/><path d="M27 37q5 5 10 0" fill="none" stroke="#8c4d42" stroke-width="2"/></svg>')}`;
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

/** Synthetic display data, wired to the production Devices panel. */
export const ReadableDeviceIdentities: Story = {
  render: () => (
    <E2eeDevicesPanel
      state={{
        epoch: 3,
        mayRotate: true,
        rotationRequired: false,
        updatePending: false,
        devices: [
          {
            key: 'a1'.repeat(32),
            cryptoUserId: 'alice',
            kind: 'personal',
            machineId: null,
            self: true,
            mayRevoke: true,
          },
          {
            key: 'b2'.repeat(32),
            cryptoUserId: 'alice',
            kind: 'personal',
            machineId: null,
            self: false,
            mayRevoke: true,
          },
          {
            key: 'c3'.repeat(32),
            cryptoUserId: 'bob',
            kind: 'machine',
            machineId: 'a504d5a8-2fcc-44a3-b1a3-0b9705831dae',
            self: false,
            mayRevoke: true,
          },
          {
            key: 'd4'.repeat(32),
            cryptoUserId: 'bob',
            kind: 'personal',
            machineId: null,
            self: false,
            mayRevoke: true,
          },
          { key: 'e5'.repeat(32), kind: 'personal', machineId: null, self: false, mayRevoke: true },
        ],
      }}
      directory={{
        workspaceId: 'synthetic',
        profiles: [
          { cryptoUserId: 'alice', name: 'Alice Chen', image: ownerAvatar },
          { cryptoUserId: 'bob', name: 'Bob Wang', image: null },
        ],
        devices: [
          {
            signingPublicKey: 'a1'.repeat(32),
            profile: {
              client: 'mobile',
              model: 'iPhone 17 Pro',
              os: 'iOS',
              osVersion: '26.0',
              appVersion: '1.2.3',
            },
          },
          {
            signingPublicKey: 'b2'.repeat(32),
            profile: {
              client: 'desktop',
              name: 'Alice’s MacBook Pro',
              os: 'macOS',
              osVersion: '26.1',
              appVersion: '1.2.3',
            },
          },
          {
            signingPublicKey: 'c3'.repeat(32),
            profile: {
              client: 'daemon',
              name: 'Build server',
              os: 'Linux',
              osVersion: '6.8.0',
              appVersion: '1.2.3',
            },
          },
          {
            signingPublicKey: 'd4'.repeat(32),
            profile: { client: 'web', os: 'Windows', appVersion: '1.2.3' },
          },
        ],
      }}
      onRetry={() => {}}
      onUpdate={() => {}}
      onRevoke={() => {}}
    />
  ),
};

/** No stored device profiles yet: this device uses local facts, machines their
 * directory name, and other devices fall back to owner and device kind. */
export const DeviceIdentitiesBeforeReports: Story = {
  render: () => (
    <E2eeDevicesPanel
      state={{
        epoch: 3,
        mayRotate: true,
        rotationRequired: false,
        updatePending: false,
        devices: [
          {
            key: 'a1'.repeat(32),
            cryptoUserId: 'alice',
            kind: 'personal',
            machineId: null,
            self: true,
            mayRevoke: true,
          },
          {
            key: 'b2'.repeat(32),
            cryptoUserId: 'alice',
            kind: 'personal',
            machineId: null,
            self: false,
            mayRevoke: true,
          },
          {
            key: 'c3'.repeat(32),
            cryptoUserId: 'bob',
            kind: 'machine',
            machineId: 'a504d5a8-2fcc-44a3-b1a3-0b9705831dae',
            self: false,
            mayRevoke: true,
          },
        ],
      }}
      directory={{
        workspaceId: 'synthetic',
        profiles: [
          { cryptoUserId: 'alice', name: 'Alice Chen', image: ownerAvatar },
          { cryptoUserId: 'bob', name: 'Bob Wang', image: null },
        ],
      }}
      localProfile={{ client: 'web', os: 'macOS', appVersion: '1.2.3' }}
      machines={
        new Map([
          [
            'a504d5a8-2fcc-44a3-b1a3-0b9705831dae',
            { name: 'Build server', os: 'linux', cliVersion: '1.2.3' },
          ],
        ])
      }
      onRetry={() => {}}
      onUpdate={() => {}}
      onRevoke={() => {}}
    />
  ),
};
