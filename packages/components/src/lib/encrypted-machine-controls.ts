import {
  MACHINE_PROTOCOL_CAPABILITIES,
  machineSupportsProtocolCapability,
  type MachineProtocolCapabilities,
} from '@lody/shared';

/**
 * Encrypted workspaces close ordinary Machine RPC to every machine but this computer's.
 * Edit and resend still reaches a remote machine through the signed feature channel, but
 * only from that machine's owner (the machine signs the replacement turn itself) and only
 * once the machine advertises support; an older machine drops the request unanswered.
 */
export function encryptedRemoteEditAndResendAvailable(input: {
  contentMode: string | undefined;
  accountId: string | null | undefined;
  machine:
    | { ownerUserId?: string; protocolCapabilities?: MachineProtocolCapabilities }
    | null
    | undefined;
}): boolean {
  return (
    input.contentMode === 'e2ee' &&
    !!input.accountId &&
    input.machine?.ownerUserId === input.accountId &&
    machineSupportsProtocolCapability(
      input.machine,
      MACHINE_PROTOCOL_CAPABILITIES.e2eeSessionEditAndResend
    )
  );
}
