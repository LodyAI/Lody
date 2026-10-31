import { describe, expect, it } from 'vitest';
import { remoteAutomationIntentSchema, remoteAutomationProofSchema } from '../src/automations';

const intent = {
  workspaceId: 'workspace',
  machineId: 'machine',
  sessionId: 'session',
  requesterUserId: 'user',
  runtimeNonce: '01366fe3-c42d-4a27-bd46-2dac49e43366',
  requestId: '61637f44-fac3-4822-8703-0ad804812234',
  responseKey: {
    type: 'rpc-secret-public-key-v1',
    algorithm: 'ECDH-P256-AES-256-GCM',
    keyId: 'key',
    publicKey: { kty: 'EC', crv: 'P-256', x: 'AA', y: 'AA' },
  },
};

describe('remote Session automation intent', () => {
  it('binds the complete configured operation to the signed scope', () => {
    const operation = { type: 'configure', settings: { recoverCapacity: true } };
    expect(remoteAutomationIntentSchema.parse({ ...intent, operation })).toEqual({
      ...intent,
      operation,
    });
  });

  it.each([
    { type: 'register', program: '() => ({ resumeText: "run" })' },
    { type: 'list', sessionId: 'another-session' },
    { type: 'cancel', id: 'wait', sessionId: 'another-session' },
    { type: 'configure', settings: { recoverCapacity: true }, extra: true },
  ])('rejects operations outside the scoped control surface', (operation) => {
    expect(remoteAutomationIntentSchema.safeParse({ ...intent, operation }).success).toBe(false);
  });

  it('requires a bounded token and a valid runtime and request identity', () => {
    expect(
      remoteAutomationProofSchema.safeParse({
        runtimeNonce: intent.runtimeNonce,
        requestId: intent.requestId,
        requestToken: 'signed-proof',
      }).success
    ).toBe(true);
    expect(
      remoteAutomationProofSchema.safeParse({
        runtimeNonce: intent.runtimeNonce,
        requestId: 'invalid',
        requestToken: 'signed-proof',
      }).success
    ).toBe(false);
    expect(
      remoteAutomationProofSchema.safeParse({
        runtimeNonce: intent.runtimeNonce,
        requestId: intent.requestId,
        requestToken: 'x'.repeat(8193),
      }).success
    ).toBe(false);
  });
});
