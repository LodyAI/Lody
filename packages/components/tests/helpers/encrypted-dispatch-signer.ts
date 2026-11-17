import {
  E2EE_INTENT_KIND,
  encodeE2eeIntentRecord,
  isMemberSignableInput,
  type ScheduleDocument,
} from '@lody/shared';
import type { E2eeDispatchInput } from '@lody/shared/e2ee-rpc';
import type { PreparedEncryptedDispatch } from '../../src/lib/encrypted-dispatch-outcome';

/**
 * A member host's dispatch signing for tests: it applies the real member signing rule
 * and refuses exactly what the native host refuses, so a composer input that passes
 * here is one a real encrypted send signs. It never accelerates through RPC.
 */
export function encryptedDispatchSigner() {
  const signed: E2eeDispatchInput[] = [];
  const prepareEncryptedDispatch = async (
    machineId: string,
    input: E2eeDispatchInput
  ): Promise<PreparedEncryptedDispatch> => {
    if (!isMemberSignableInput(input.inputConfig)) throw new Error('e2ee_rpc_invalid');
    signed.push(input);
    return {
      original: {
        requestId: `synthetic-${input.userTurnId}`,
        targetMachineId: machineId,
        frameHex: '02'.repeat(32),
        requesterDevice: '03'.repeat(32),
        expiresAt: 0,
        e2eeIntent: encodeE2eeIntentRecord({
          kind: 1,
          signer: new Uint8Array(32).fill(3),
          signature: new Uint8Array(64).fill(3),
        }),
      },
      send: async () => null,
    };
  };
  return { prepareEncryptedDispatch, signed };
}

/** A host's schedule declaration signing for tests; it records what each save signed. */
export function scheduleDeclarationSigner() {
  const signed: Pick<ScheduleDocument, 'definition' | 'prompt' | 'message'>[] = [];
  const signScheduleDeclaration = async (
    document: Pick<ScheduleDocument, 'definition' | 'prompt' | 'message'>
  ) => {
    signed.push(document);
    return encodeE2eeIntentRecord({
      kind: E2EE_INTENT_KIND.scheduleDeclaration,
      signer: new Uint8Array(32).fill(4),
      signature: new Uint8Array(64).fill(4),
    });
  };
  return { signScheduleDeclaration, signed };
}
