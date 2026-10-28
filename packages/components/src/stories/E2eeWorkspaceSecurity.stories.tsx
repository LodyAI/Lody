import { E2eeSettingsGlyph } from '@/components/settings/e2ee/security-state';
import type { Meta, StoryObj } from '@storybook/react';
import { E2eeSecurityPanel } from '@/components/settings/e2ee/security-panel';
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
  args: { state, onUpdate: () => {}, onRevoke: () => {}, onRetry: () => {}, onAuthorize: () => {} },
  parameters: { layout: 'padded' },
} satisfies Meta<typeof E2eeSecurityPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const KeyUpdateNeeded: Story = {};
export const StagingRetry: Story = {
  args: { error: 'e2ee_management_retry', state: { ...state, updatePending: true } },
};
export const NoAdministrator: Story = { args: { state: { ...state, mayRotate: false } } };
export const IdentityLost: Story = { args: { state: undefined } };
export const CandidateRecovery: Story = {
  args: {
    error: 'e2ee_rotation_candidate_unavailable',
    state: { ...state, rotationRequired: false, updatePending: true },
  },
};

export const SettingsEntryAttention: Story = {
  render: () => (
    <span style={{ display: 'inline-flex', width: 20, height: 20 }}>
      <E2eeSettingsGlyph attention />
    </span>
  ),
};
