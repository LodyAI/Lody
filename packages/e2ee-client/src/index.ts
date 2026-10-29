/** Platform-neutral personal-device product composition. No app activation or authenticated backend is supplied by default. */
export { makePersonalDeviceHost } from './host';
export {
  PersonalHostPlatform,
  PersonalHostRemote,
  type PersonalApproval,
  type PersonalControlPorts,
  type PersonalKeyPorts,
  type PersonalExchange,
  type PersonalExchangeResponse,
} from './platform';
export { PersonalHostError, PersonalRuntimeFailure } from './errors';
export {
  PersonalPairingOfferSchema,
  decodePersonalRequest,
  encodePersonalInvitation,
  decodePersonalInvitation,
  verifyPersonalOffer,
  verifyPersonalRequest,
  verifyPersonalApproval,
  type PersonalPairingOffer,
  type PersonalPairingRequest,
} from './pairing';
export { verifyPersonalHistory } from './admission';
export { personalLedgerControl, type PersonalLedgerOrigin } from './ledger';

export {
  makeOwnedPersonalDeviceHost,
  PersonalCloseIncomplete,
  PERSONAL_CLOSE_BUDGET_MS,
  type PersonalCloseOwner,
  type PersonalHostPorts,
} from './owned-host';

export { makePersonalWorkspaceRuntime, type PersonalRuntimeOptions } from './runtime';
export { PersonalMachineSharing } from './platform';
