import type { Meta, StoryObj } from '@storybook/react';
import { userEvent, within } from 'storybook/test';
import { E2eePersonalPairing } from '@/components/pages/e2ee-personal-pairing';
const offer = {
  version: 1 as const,
  workspaceId: 'synthetic-workspace',
  genesisHash: '11'.repeat(32),
  genesisRecordHex: 'aabb',
  endorser: '22'.repeat(32),
  membershipId: '33'.repeat(16),
  pairingSessionId: '44'.repeat(16),
};
const meta = {
  title: 'Components/E2eePersonalPairing',
  component: E2eePersonalPairing,
  args: {
    workspaceId: offer.workspaceId,
    canApprove: true,
    onJoined: () => {},
    runtime: {
      personalPairingOffer: async () => offer,
      preparePersonalJoin: async () => ({
        pairingSessionId: offer.pairingSessionId,
        signingPublicKey: '55'.repeat(32),
        status: 'pending',
      }),
      inspectPersonalJoin: async () => ({
        pairingSessionId: offer.pairingSessionId,
        signingPublicKey: '55'.repeat(32),
        encryptionPublicKey: '66'.repeat(32),
        credentialHash: '77'.repeat(32),
        protection: 'os-keystore' as const,
      }),
      approvePersonalJoin: async () => ({ admitted: true as const, invitationPublished: true }),
      claimPersonalJoin: async () => ({ ready: true, status: 'published' }),
      cancelPersonalJoin: async () => ({ status: 'cancelled' as const }),
    },
  },
  parameters: { layout: 'padded' },
} satisfies Meta<typeof E2eePersonalPairing>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ExistingDesktop: Story = {};
export const JoiningDesktop: Story = { args: { canApprove: false } };
export const SavedJoiningRequest: Story = {
  args: {
    canApprove: false,
    runtime: {
      ...meta.args.runtime,
      pendingPersonalJoin: async () => ({
        pairingSessionId: offer.pairingSessionId,
        signingPublicKey: '55'.repeat(32),
        offer,
      }),
    },
  },
};
export const Confirm: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /Add a desktop|添加桌面设备/ }));
    await userEvent.click(
      canvas.getByRole('button', { name: /Check joining desktop|检查申请加入的设备/ })
    );
  },
};
