import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Effect, Result } from 'effect';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { Bytes, signGenesisRecord } from '@lody/e2ee-core/protocol';
import { importBrowserDevice } from '@lody/e2ee-core/adapters/browser-crypto';
import type { PersonalPairingOffer } from '@lody/e2ee-client';
import { personalEntryPins } from '../src/entry-pins';

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});
afterEach(() => {
  vi.unstubAllGlobals();
});
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
/** A verifiable synthetic personal offer for one workspace. */
const offerFor = (workspaceId: string, seed: number) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const device = yield* importBrowserDevice({
          signingPrivate: new Uint8Array(32).fill(seed),
          encryptionPrivate: new Uint8Array(32).fill(seed + 1),
        });
        const signed = yield* signGenesisRecord({
          signer: device,
          encryptionPublicKey: device.enc,
          initialKey: Result.getOrThrow(Bytes.epochKey(new Uint8Array(32).fill(seed + 2))),
          membershipId: Result.getOrThrow(Bytes.membershipId(new Uint8Array(16).fill(seed))),
          userId: Result.getOrThrow(Bytes.userId(new Uint8Array(32).fill(8))),
        });
        return {
          version: 1,
          workspaceId,
          genesisHash: hex(signed.genesis.toBytes()),
          genesisRecordHex: hex(signed.record),
          endorser: hex(device.publicKey.toBytes()),
          membershipId: hex(new Uint8Array(16).fill(seed)),
          pairingSessionId: hex(new Uint8Array(16).fill(seed + 3)),
        } satisfies PersonalPairingOffer;
      })
    )
  );

it('an approving device finds every workspace it is ready in for the signed-in account, and only those', async () => {
  const pins = personalEntryPins('lody-e2ee:web:v1:entry-pins');
  const run = <A>(work: Effect.Effect<A, unknown>) => Effect.runPromise(work);
  const [w1, w2, pending, cancelled, other] = await Promise.all([
    offerFor('workspace-1', 10),
    offerFor('workspace-2', 20),
    offerFor('workspace-3', 30),
    offerFor('workspace-4', 40),
    offerFor('workspace-5', 50),
  ]);
  for (const offer of [w1, w2, pending, cancelled]) await run(pins.prepare('account-A', offer));
  await run(pins.finish('account-A', w1, 'ready'));
  await run(pins.finish('account-A', w2, 'ready'));
  await run(pins.finish('account-A', cancelled, 'cancelled'));
  await run(pins.prepare('account-B', other));
  await run(pins.finish('account-B', other, 'ready'));

  const ready = await run(pins.listReady('account-A'));
  expect(ready.map((pin) => pin.offer.workspaceId).sort()).toEqual(['workspace-1', 'workspace-2']);
  expect(ready.find((pin) => pin.offer.workspaceId === 'workspace-2')?.offer).toEqual(w2);
  await expect(run(pins.listReady('account-C'))).resolves.toEqual([]);
});
