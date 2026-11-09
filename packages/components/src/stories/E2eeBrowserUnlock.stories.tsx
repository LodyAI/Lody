import type { Meta, StoryObj } from '@storybook/react';
import { E2eeAccountPairingRequest } from '@/components/pages/e2ee-account-pairing';
import type { E2eeAccountPairingRequestState } from '@lody/platform';
let state: E2eeAccountPairingRequestState | null = null;
const meta = {
  title: 'Components/E2eeBrowserUnlock',
  component: E2eeAccountPairingRequest,
  args: {
    autoStart: false,
    onJoined: () => {},
    runtime: {
      openBrowserUnlock: () => {},
      accountPairingRequest: async () => state,
      requestAccountPairing: async () =>
        (state = {
          direction: 'requester-shows',
          pairingString: '50M6-HA79-55MT-KTHA-DANE-PAVB-NF38',
          expiresAt: 1800000600000,
          status: 'waiting',
          workspaces: [{ workspaceId: 'synthetic', name: 'Example workspace', state: 'pending' }],
        }),
      cancelAccountPairing: async () => {
        state = null;
      },
    },
  },
  parameters: { layout: 'padded' },
} satisfies Meta<typeof E2eeAccountPairingRequest>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Consent: Story = {
  beforeEach: () => {
    state = null;
  },
};
