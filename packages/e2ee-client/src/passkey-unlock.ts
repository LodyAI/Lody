/** Enroll and use a recovery-vault passkey through the platform port. This holds the
 * Spec's ceremony contract, so every platform judges a result the same way. */
import { Effect } from 'effect';
import { E2EE_PASSKEY_RP_ID, type E2eePasskeyPort } from '@lody/platform/e2ee-passkey';
import type { RecoveryVault } from '@lody/e2ee-core';
import {
  disposePrf,
  passkeyUserHandle,
  vaultIdFromPasskeyUserHandle,
  vaultPrfInput,
  verifiedPasskeyPrf,
  verifiedPasskeyRegistration,
  type VerifiedPasskeyPrf,
} from '@lody/e2ee-core/protocol';

export { E2eePasskeyCancelled, type E2eePasskeyPort } from '@lody/platform/e2ee-passkey';

const PASSKEY_USER_NAME = 'Lody recovery vault';

const ceremony = <A>(work: () => Promise<A>) => Effect.tryPromise({ try: work, catch: (e) => e });

/** Copy into a fresh ArrayBuffer for core, and wipe the host's copy either way. */
const verifiedAssertion = (assertion: {
  readonly credentialId: string;
  readonly userVerified: boolean;
  readonly prfFirst: Uint8Array | null;
}) => {
  const first = assertion.prfFirst;
  const copied = first ? first.slice().buffer : new ArrayBuffer(0);
  first?.fill(0);
  return verifiedPasskeyPrf({
    credentialId: assertion.credentialId,
    userVerified: assertion.userVerified,
    extension: { results: { first: copied } },
  }).pipe(Effect.ensuring(Effect.sync(() => new Uint8Array(copied).fill(0))));
};

/**
 * Enroll a passkey on an open vault. Registration must report PRF, and a real assertion
 * of that same credential must then produce the wrap, proving the path a later unlock
 * uses. A passkey without PRF stops with `prf-unavailable`, and nothing is written.
 */
export const enrollVaultPasskey = Effect.fnUntraced(function* (input: {
  readonly port: E2eePasskeyPort;
  readonly vault: RecoveryVault;
  readonly label: string;
}) {
  const known = yield* input.vault.listPasskeys();
  const prfInput = vaultPrfInput();
  const created = yield* ceremony(() =>
    input.port.register({
      rpId: E2EE_PASSKEY_RP_ID,
      userHandle: passkeyUserHandle(input.vault.vaultId),
      userName: PASSKEY_USER_NAME,
      prfInput,
      excludeCredentialIds: known.map((row) => row.credentialId),
    })
  );
  const registration = yield* verifiedPasskeyRegistration({
    credentialId: created.credentialId,
    extension: { enabled: created.prfEnabled },
  });
  const assertion = yield* ceremony(() =>
    input.port.authenticate({
      rpId: E2EE_PASSKEY_RP_ID,
      prfInput,
      allowCredentialIds: [created.credentialId],
    })
  );
  return yield* Effect.acquireUseRelease(
    verifiedAssertion(assertion),
    (prf) => input.vault.addPasskey({ registration, assertion: prf, label: input.label }),
    (prf) => Effect.sync(() => disposePrf(prf))
  );
});

/**
 * Run a discoverable ceremony and open the vault it names. The user handle is only a
 * hint: `open` must decrypt, which is what proves the vault.
 */
export const unlockVaultWithPasskey = Effect.fnUntraced(function* <A, E, R>(input: {
  readonly port: E2eePasskeyPort;
  readonly open: (request: {
    readonly vaultId: string;
    readonly credential: VerifiedPasskeyPrf;
  }) => Effect.Effect<A, E, R>;
}) {
  const assertion = yield* ceremony(() =>
    input.port.authenticate({
      rpId: E2EE_PASSKEY_RP_ID,
      prfInput: vaultPrfInput(),
      allowCredentialIds: [],
    })
  );
  const vaultId = yield* vaultIdFromPasskeyUserHandle(assertion.userHandle ?? new Uint8Array());
  return yield* Effect.acquireUseRelease(
    verifiedAssertion(assertion),
    (credential) => input.open({ vaultId, credential }),
    (credential) => Effect.sync(() => disposePrf(credential))
  );
});
