import { createHmac } from 'node:crypto';
import { Effect, Result } from 'effect';
import { describe, expect, it } from 'vitest';
import { vaultIdFromPasskeyUserHandle } from '@lody/e2ee-core/protocol';
import {
  createVaultWithPasskey,
  unlockVaultWithPasskey,
  type E2eePasskeyPort,
} from '../src/passkey-unlock';

const fakePasskeyPort = (options?: { readonly prfEnabled?: boolean }): E2eePasskeyPort => {
  let savedHandle: Uint8Array | null = null;
  let savedCredentialId = 'AQIDBAUGBwgJCgsMDQ4PEA';
  const prfEnabled = options?.prfEnabled ?? true;
  return {
    available: async () => true,
    register: async (request) => {
      savedHandle = new Uint8Array(request.userHandle);
      return {
        credentialId: savedCredentialId,
        prfEnabled,
      };
    },
    authenticate: async (request) => {
      const prfFirst = prfEnabled
        ? new Uint8Array(
            createHmac('sha256', Buffer.alloc(32, 9)).update(request.prfInput).digest()
          )
        : null;
      return {
        credentialId: savedCredentialId,
        userHandle: savedHandle ? new Uint8Array(savedHandle) : null,
        userVerified: true,
        prfFirst,
      };
    },
  };
};

describe('createVaultWithPasskey', () => {
  it('registers with a fresh vault userHandle, verifies PRF, invokes create, and unlocks the same vaultId', async () => {
    const port = fakePasskeyPort({ prfEnabled: true });
    let createdVaultId = '';
    const result = await Effect.runPromise(
      createVaultWithPasskey({
        port,
        label: 'MacBook Touch ID',
        create: ({ vaultId, registration, assertion, label }) =>
          Effect.sync(() => {
            createdVaultId = vaultId;
            expect(registration.credentialId).toBe(assertion.credentialId);
            expect(label).toBe('MacBook Touch ID');
            return { vaultId };
          }),
      })
    );
    expect(result.vaultId).toMatch(/^[0-9a-f]{64}$/);
    expect(result.vaultId).toBe(createdVaultId);

    const unlockedVaultId = await Effect.runPromise(
      unlockVaultWithPasskey({
        port,
        open: ({ vaultId }) => Effect.succeed(vaultId),
      })
    );
    expect(unlockedVaultId).toBe(createdVaultId);
    const decodedHandle = await Effect.runPromise(
      vaultIdFromPasskeyUserHandle(Buffer.from(createdVaultId, 'hex'))
    );
    expect(decodedHandle).toBe(createdVaultId);
  });

  it('aborts with prf-unavailable before calling create when the authenticator lacks PRF', async () => {
    const port = fakePasskeyPort({ prfEnabled: false });
    let createCalled = false;
    const outcome = await Effect.runPromise(
      Effect.result(
        createVaultWithPasskey({
          port,
          label: 'Legacy Key',
          create: () =>
            Effect.sync(() => {
              createCalled = true;
              return null;
            }),
        })
      )
    );
    expect(createCalled).toBe(false);
    expect(Result.isFailure(outcome) ? outcome.failure : null).toMatchObject({
      code: 'prf-unavailable',
    });
  });
});
