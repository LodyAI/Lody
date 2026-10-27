import { describe, expect, it } from 'vitest';
import {
  LocalE2eePrepareRequestSchema,
  LocalE2eePrepareResponseSchema,
} from '../src/e2ee-local-pairing';

const request = {
  type: 'prepare',
  accountId: 'account',
  workspaceId: 'workspace',
  genesisHash: '11'.repeat(32),
  genesisRecordHex: '00',
  membershipId: '22'.repeat(16),
  frontendSigningPublicKey: '33'.repeat(32),
  pairingSessionId: '44'.repeat(16),
};
const response = {
  type: 'prepare',
  ok: true,
  pairingSessionId: request.pairingSessionId,
  signingPublicKey: '55'.repeat(32),
  encryptionPublicKey: '66'.repeat(32),
  possessionSignature: '77'.repeat(64),
  credentialHash: '88'.repeat(32),
  bindingSignature: '99'.repeat(64),
  protection: 'file',
};

describe('local machine pairing UTF-8 identity boundary', () => {
  it.each(['a'.repeat(256), 'é'.repeat(128), 'e\u0301', '\ufeffmachine'])(
    'preserves valid bytes without trimming or normalization',
    (machineId) => {
      expect(LocalE2eePrepareRequestSchema.parse({ ...request, machineId }).machineId).toBe(
        machineId
      );
      expect(LocalE2eePrepareResponseSchema.parse({ ...response, machineId }).machineId).toBe(
        machineId
      );
    }
  );
  it.each(['', 'x'.repeat(257), 'é'.repeat(129), '\ud800', '\udfff'])(
    'rejects invalid or oversized identity before local prepare/approval',
    (machineId) => {
      expect(LocalE2eePrepareRequestSchema.safeParse({ ...request, machineId }).success).toBe(
        false
      );
      expect(LocalE2eePrepareResponseSchema.safeParse({ ...response, machineId }).success).toBe(
        false
      );
    }
  );
  it('keeps the unrelated account/workspace identifier limits', () => {
    for (const field of ['accountId', 'workspaceId'] as const)
      expect(
        LocalE2eePrepareRequestSchema.safeParse({
          ...request,
          machineId: 'machine',
          [field]: 'x'.repeat(129),
        }).success
      ).toBe(false);
  });
});
