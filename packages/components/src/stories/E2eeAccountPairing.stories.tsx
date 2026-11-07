import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from 'storybook/test';
import type { E2eeAccountPairingPreview, E2eeAccountPairingRequestState } from '@lody/platform';
import {
  E2eeAccountPairingApprove,
  E2eeAccountPairingRequest,
} from '@/components/pages/e2ee-account-pairing';

// Synthetic code (packages/e2ee-core/test/pairing-vector.json); no real secret.
const CODE = '50M6-HA79-55MT-KTHA-DANE-PAVB-NF38';
const NOW = Date.UTC(2026, 10, 1, 9, 0);
const waiting: E2eeAccountPairingRequestState = {
  direction: 'requester-shows',
  pairingString: CODE,
  expiresAt: NOW + 600_000,
  status: 'waiting',
  workspaces: [{ workspaceId: 'synthetic-1', name: 'Synthetic team', state: 'pending' }],
};
const preview: E2eeAccountPairingPreview = {
  requestId: 'synthetic-request',
  deviceName: 'Synthetic phone',
  approximateLocation: 'Helsinki, FI',
  requestedAt: NOW,
  expiresAt: NOW + 600_000,
  workspaces: [
    { workspaceId: 'synthetic-1', name: 'Synthetic team' },
    { workspaceId: 'synthetic-2', name: 'Side project' },
  ],
  unavailable: [{ workspaceId: 'synthetic-3', name: 'Shared archive' }],
};
const requester = (state: E2eeAccountPairingRequestState | null) => ({
  requestAccountPairing: async () => waiting,
  accountPairingRequest: async () => state,
  cancelAccountPairing: async () => {},
});
const approver = {
  accountPairingCode: async () => ({ pairingString: CODE, expiresAt: NOW + 600_000 }),
  inspectAccountPairing: async () => preview,
  approveAccountPairing: async (input: { workspaceIds: string[] }) => ({
    workspaces: input.workspaceIds.map((workspaceId) => ({
      workspaceId,
      outcome: 'admitted' as const,
    })),
  }),
  declineAccountPairing: async () => {},
};

const meta = {
  title: 'Pages/EncryptedWorkspace/AccountPairing',
  component: E2eeAccountPairingRequest,
  parameters: { layout: 'padded' },
  args: { runtime: requester(waiting), autoStart: true, onJoined: () => {}, pollMs: 60_000 },
} satisfies Meta<typeof E2eeAccountPairingRequest>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NewDeviceShowsCode: Story = {};
export const WebAsksFirst: Story = { args: { runtime: requester(null), autoStart: false } };
export const RequestExpired: Story = {
  args: { runtime: requester({ ...waiting, status: 'expired', pairingString: null }) },
};

export const ApproverConfirms: Story = {
  render: () => <E2eeAccountPairingApprove runtime={approver} pollMs={60_000} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('textbox'), CODE);
    await userEvent.click(canvas.getByRole('button', { name: /Check request|检查请求/ }));
    await expect(await canvas.findByText('Synthetic phone')).toBeVisible();
  },
};
export const ApproverShowsCode: Story = {
  render: () => (
    <E2eeAccountPairingApprove
      runtime={{ ...approver, inspectAccountPairing: async () => null }}
      pollMs={60_000}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole('button', { name: /Show a code on this device instead|改为在这台设备上显示配对码/ })
    );
    await expect(await canvas.findByText(CODE)).toBeVisible();
  },
};
