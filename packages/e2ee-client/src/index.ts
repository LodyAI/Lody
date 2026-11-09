/** Platform-neutral personal-device product composition. No app activation or authenticated backend is supplied by default. */
export { makePersonalDeviceHost, accountPairingOffer, ACCOUNT_PAIRING_ENDORSER } from './host';
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
/** Local custody payload construction only; the packet never crosses the UI. */
export { credentialPacket } from './identity';
export { personalLedgerControl, type PersonalLedgerOrigin } from './ledger';

export {
  makeOwnedPersonalDeviceHost,
  PersonalCloseIncomplete,
  PERSONAL_CLOSE_BUDGET_MS,
  type PersonalCloseOwner,
  type PersonalHostPorts,
} from './owned-host';

export {
  makePersonalWorkspaceRuntime,
  personalRuntimeAccountRequester,
  type PersonalRuntimeOptions,
} from './runtime';
export { PersonalMachineSharing } from './platform';
