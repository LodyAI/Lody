import { Effect, Result } from 'effect';
import { importBrowserDevice } from '@lody/e2ee-core/adapters/browser-crypto';
import { Bytes, signGenesisRecord } from '@lody/e2ee-core/protocol';
export const hex = (b: Uint8Array) =>
  Array.from(b, (n) => n.toString(16).padStart(2, '0')).join('');
export async function desktopOffer(seed = 10) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const desktop = yield* importBrowserDevice({
          signingPrivate: new Uint8Array(32).fill(seed),
          encryptionPrivate: new Uint8Array(32).fill(9),
        });
        const signed = yield* signGenesisRecord({
          signer: desktop,
          encryptionPublicKey: desktop.enc,
          initialKey: Result.getOrThrow(Bytes.epochKey(new Uint8Array(32).fill(42))),
          membershipId: Result.getOrThrow(Bytes.membershipId(new Uint8Array(16).fill(10))),
          userId: Result.getOrThrow(Bytes.userId(new Uint8Array(32).fill(8))),
        });
        return {
          version: 1 as const,
          workspaceId: 'workspace-A',
          genesisHash: hex(signed.genesis.toBytes()),
          genesisRecordHex: hex(signed.record),
          endorser: hex(desktop.publicKey.toBytes()),
          membershipId: '0a'.repeat(16),
          pairingSessionId: '11'.repeat(16),
        };
      })
    )
  );
}
