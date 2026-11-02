import type { Meta, StoryObj } from '@storybook/react';
import { userEvent, within } from 'storybook/test';
import { E2eeRemoteMachinePairing } from '@/components/pages/e2ee-remote-machine-pairing';
import type { E2eeWorkspaceRuntime } from '@lody/platform';
import type { RemoteMachineStatus } from '@lody/shared/e2ee-remote-pairing';
const session = '11'.repeat(16);
const summary = Array(8).fill('12345678').join(' ');
function runtime(
  protection: 'file' | 'os-keystore',
  location: RemoteMachineStatus['location']
): Pick<
  E2eeWorkspaceRuntime,
  | 'beginRemoteMachinePairing'
  | 'inspectRemoteMachinePairing'
  | 'approveRemoteMachinePairing'
  | 'cancelRemoteMachinePairing'
> {
  let status: RemoteMachineStatus['status'] = 'claimed';
  const current = (): RemoteMachineStatus & { summary: string } => ({
    pairingSessionId: session,
    expiresAt: 1793131200000,
    status,
    summary,
    location,
    material: {
      ok: true,
      type: 'prepare',
      machineId: 'synthetic-build-server',
      pairingSessionId: session,
      signingPublicKey: '22'.repeat(32),
      encryptionPublicKey: '33'.repeat(32),
      possessionSignature: '44'.repeat(64),
      credentialHash: '55'.repeat(32),
      bindingSignature: '66'.repeat(64),
      protection,
    },
  });
  return {
    beginRemoteMachinePairing: async () => ({
      ...current(),
      command: 'lody machine pair --offer synthetic-example',
    }),
    inspectRemoteMachinePairing: async () => current(),
    approveRemoteMachinePairing: async (_workspace, requested, displayed) => {
      if (requested !== session || displayed !== summary) throw new Error('conflict');
      status = 'admitted';
      return { admitted: true, ready: false };
    },
    cancelRemoteMachinePairing: async () => {
      status = 'cancelled';
      return current();
    },
  };
}
const meta = {
  title: 'Components/E2eeRemoteMachinePairing',
  component: E2eeRemoteMachinePairing,
  args: {
    workspaceId: 'synthetic-workspace',
    runtime: runtime('file', { country: 'CN', city: 'Shanghai' }),
  },
} satisfies Meta<typeof E2eeRemoteMachinePairing>;
export default meta;
type Story = StoryObj<typeof meta>;
const connect = async (canvasElement: HTMLElement) => {
  await userEvent.click(within(canvasElement).getByRole('button'));
};
export const ConnectionCommand: Story = {
  play: async ({ canvasElement }) => connect(canvasElement),
};
export const CompareFileProtectedMachine: Story = {
  play: async ({ canvasElement }) => {
    await connect(canvasElement);
    await userEvent.click(within(canvasElement).getAllByRole('button')[0]!);
  },
};
export const UnknownLocation: Story = {
  args: { runtime: runtime('os-keystore', null) },
  play: CompareFileProtectedMachine.play,
};
