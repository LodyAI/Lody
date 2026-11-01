// Synthetic acceptance fixture: the same public entries a browser host consumes.
import { Effect, Result } from 'effect';
import { importBrowserDevice } from '@lody/e2ee-core/adapters/browser-crypto';
import * as Public from '@lody/e2ee-core/protocol';
import { copyEpochKeyBytes } from '../../src/internal/foundation/epoch-key';
import vector from '../hpke-vector.json';

const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!, (byte) => parseInt(byte, 16));
const hex = (value: Uint8Array) =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
const ok = <A, E>(value: Result.Result<A, E>) => Result.getOrThrow(value);

export async function runBrowserCrypto() {
  const v = vector.epoch;
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const d = yield* importBrowserDevice({
          signingPrivate: bytes('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'),
          encryptionPrivate: bytes(v.skR),
        });
        const context: Public.EpochHpkeContext = {
          genesis: ok(Public.Bytes.genesisHash(bytes(v.genesis))),
          epoch: ok(Public.Bytes.epochNumber(v.epoch)),
          sender: ok(Public.Bytes.signingPublicKey(bytes(v.sender))),
          recipient: ok(Public.Bytes.signingPublicKey(bytes(v.recipient))),
        };
        const message = Uint8Array.of(83, 77, 21);
        const signature = yield* Public.signVerified(d, message);
        const opened = yield* Public.openEpochKeyHpke(d.encryption, d.enc, context, {
          enc: bytes(v.enc),
          ct: bytes(v.ct),
        });
        const sealed = yield* Public.sealEpochKeyHpke(d.enc, opened, context);
        const roundtrip = yield* Public.openEpochKeyHpke(d.encryption, d.enc, context, sealed);
        const wrong = yield* Effect.result(
          Public.openEpochKeyHpke(
            d.encryption,
            d.enc,
            { ...context, sender: context.recipient },
            sealed
          )
        );
        return {
          wasm: Public.ed25519WasmActive(),
          signatureValid: Result.isSuccess(
            Public.verifySignature(d.publicKey.toBytes(), message, signature.toBytes())
          ),
          original: hex(copyEpochKeyBytes(opened)),
          roundtrip: hex(copyEpochKeyBytes(roundtrip)),
          wrongAadRejected: Result.isFailure(wrong),
        };
      })
    )
  );
}
