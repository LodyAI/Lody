import type { RemoteMachineOffer, RemoteMachineStatus } from '@lody/shared/e2ee-remote-pairing';
import type { E2eeDeviceAccess } from './e2ee-device';
export type E2eeMachinePairingRequests = {
  begin: E2eeDeviceAccess & { offer: RemoteMachineOffer };
  inspect: E2eeDeviceAccess & { pairingSessionId: string };
  cancel: E2eeDeviceAccess & { pairingSessionId: string };
};
export type E2eeMachinePairingStatus = RemoteMachineStatus;
