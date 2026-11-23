import type { RemoteMachineOffer, RemoteMachineStatus } from '@lody/shared/e2ee-remote-pairing';
import type { E2eeDeviceAccess } from './e2ee-device';
export type E2eeMachineBootstrapAuthorizedReply = {
  status: 'authorized';
  userId: string;
  workspaces: Array<{
    id: string;
    name: string;
    slug: string | null;
    role: string;
    contentMode: 'e2ee';
    genesisHash: string;
  }>;
};
export type E2eeMachineBootstrapReply =
  | E2eeMachineBootstrapAuthorizedReply
  | { status: 'unauthorized'; reason: string };
export type E2eeMachinePairingRequests = {
  begin: E2eeDeviceAccess & { offer: RemoteMachineOffer };
  inspect: E2eeDeviceAccess & { pairingSessionId: string };
  cancel: E2eeDeviceAccess & { pairingSessionId: string };
  complete: E2eeDeviceAccess & { pairingSessionId: string; includeBootstrap?: true };
};
export type E2eeMachinePairingStatus = RemoteMachineStatus;
export type E2eeMachinePairingCompleteReply = E2eeMachinePairingStatus & {
  bootstrap?: E2eeMachineBootstrapReply;
};
