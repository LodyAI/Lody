import { Effect, Result } from 'effect';
import * as Bytes from './bytes';
import { ValidationError } from './errors';
import { verifySignature } from './signature';
import { signVerified, type DeviceSigner } from './signing';

const domain = new TextEncoder().encode('lody-e2ee/device-credential-binding/v1\0');

/** Trusted pairing context. The approver supplies the exact active session and pinned genesis; this proof grants no ledger permission. */
export interface DeviceCredentialBinding {
  readonly genesis: Bytes.GenesisHash;
  readonly pairingSessionId: Uint8Array;
  readonly signingPublicKey: Bytes.SigningPublicKey;
  readonly credentialHash: Uint8Array;
}

/** Encode the fixed-length v1 credential binding, copying every field. Invalid lengths return canonical; no key or credential is exported. */
export function deviceCredentialBindingBytes(input: DeviceCredentialBinding) {
  return Result.gen(function* () {
    const genesis = yield* Bytes.genesisHash(input.genesis.toBytes());
    const key = yield* Bytes.signingPublicKey(input.signingPublicKey.toBytes());
    if (
      !(input.pairingSessionId instanceof Uint8Array) ||
      input.pairingSessionId.length !== 16 ||
      !(input.credentialHash instanceof Uint8Array) ||
      input.credentialHash.length !== 32
    )
      return yield* Result.fail(new ValidationError({ code: 'canonical' }));
    const output = new Uint8Array(domain.length + 112);
    let offset = 0;
    for (const field of [
      domain,
      genesis.toBytes(),
      input.pairingSessionId,
      key.toBytes(),
      input.credentialHash,
    ]) {
      output.set(field, offset);
      offset += field.length;
    }
    return output;
  });
}

/** Sign only this pairing context with its matching new-device key. The fixed verifier checks signer output; retrying admission must retain its original ledger record separately. */
export const signDeviceCredentialBinding = Effect.fnUntraced(function* (
  input: DeviceCredentialBinding & { readonly signer: DeviceSigner }
) {
  const message = yield* Effect.fromResult(deviceCredentialBindingBytes(input));
  if (!input.signingPublicKey.equals(input.signer.publicKey))
    return yield* new ValidationError({ code: 'bad-signature' });
  return yield* signVerified(input.signer, message);
});

/** Strict Ed25519 verification over the approver's independently trusted context; changing session, genesis, key or hash invalidates the proof. */
export function verifyDeviceCredentialBinding(
  input: DeviceCredentialBinding,
  signature: Uint8Array
) {
  return Result.flatMap(deviceCredentialBindingBytes(input), (message) =>
    verifySignature(input.signingPublicKey.toBytes(), message, signature)
  );
}
