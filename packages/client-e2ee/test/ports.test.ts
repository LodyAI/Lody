import { expect, it } from 'vitest';
import { Effect, Layer, Result } from 'effect';
import { Bytes, signGenesisRecord } from '@lody/e2ee-core/protocol';
import { importBrowserDevice } from '@lody/e2ee-core/adapters/browser-crypto';
import { ClientCustodyError } from '@lody/e2ee-core/services';
import {
  personalCloudDatabases,
  personalCloudHostPorts,
  type PersonalCloudCustodyAdapter,
  type PersonalCloudHostOptions,
} from '../src';

async function options(): Promise<PersonalCloudHostOptions> {
  const offer = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const desktop = yield* importBrowserDevice({
          signingPrivate: new Uint8Array(32).fill(10),
          encryptionPrivate: new Uint8Array(32).fill(9),
        });
        const signed = yield* signGenesisRecord({
          signer: desktop,
          encryptionPublicKey: desktop.enc,
          initialKey: Result.getOrThrow(Bytes.epochKey(new Uint8Array(32).fill(42))),
          membershipId: Result.getOrThrow(Bytes.membershipId(new Uint8Array(16).fill(10))),
          userId: Result.getOrThrow(Bytes.userId(new Uint8Array(32).fill(8))),
        });
        const hex = (b: Uint8Array) =>
          Array.from(b, (n) => n.toString(16).padStart(2, '0')).join('');
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
  const noNetwork = async () => {
    throw new Error('unexpected cloud call');
  };
  return {
    platformNamespace: 'mobile',
    accountId: 'account-A',
    offer,
    mode: 'open-existing',
    client: { query: noNetwork, mutation: noNetwork, action: noNetwork },
    currentAccount: () => Effect.succeed('account-A'),
    drainOld: () => Effect.void,
  };
}
const custody: PersonalCloudCustodyAdapter = {
  protection: 'os-keystore',
  custody: () => {
    throw new Error('unexpected custody construction before admission');
  },
};

it('preserves the existing Web namespace and keeps explicit mobile storage disjoint', () => {
  const scope = {
    accountId: 'account-A',
    workspaceId: 'workspace-A',
    genesis: Result.getOrThrow(Bytes.genesisHash(new Uint8Array(32).fill(17))),
  };
  const web = personalCloudDatabases(scope, 'web');
  const legacy = 'lody-e2ee:web:v1:["account-A","workspace-A","' + '11'.repeat(32) + '"]';
  expect(web.ledger).toBe(legacy + ':ledger');
  expect(web.custody).toBe(legacy + ':custody');
  const mobile = personalCloudDatabases(scope, 'mobile');
  expect(mobile.custody).not.toBe(web.custody);
  expect(() => personalCloudDatabases(scope, 'fresh-profile' as 'mobile')).toThrow(
    ClientCustodyError
  );
});
it('refuses an invalid namespace before storage or custody can initialize a fresh identity', async () => {
  const input = await options();
  const layer = personalCloudHostPorts(
    { ...input, platformNamespace: 'fresh-profile' as 'mobile' },
    custody
  );
  const result = await Effect.runPromise(Effect.result(Effect.scoped(Layer.build(layer))));
  expect(Result.isFailure(result) && result.failure).toMatchObject({ reason: 'corrupt' });
});
