import {
  E2EE_ROOST_HISTORY_PROTOCOL_VERSION,
  MACHINE_PROTOCOL_CAPABILITIES,
  machineSupportsProtocolCapability,
} from '@lody/shared';
import { SessionInputNotSentError } from './session-accepted-inputs';
import i18next from 'i18next';

export function requireEncryptedRoostOwner(
  machine: Parameters<typeof machineSupportsProtocolCapability>[0]
) {
  if (
    !machineSupportsProtocolCapability(
      machine,
      MACHINE_PROTOCOL_CAPABILITIES.e2eeRoostHistory,
      E2EE_ROOST_HISTORY_PROTOCOL_VERSION
    )
  ) {
    const message = 'Update Lody on the conversation machine to use encrypted Roost history.';
    throw new SessionInputNotSentError(
      i18next.t('sessions.encryptedRoostNeedsUpdate', message) || message
    );
  }
}
