/** Synthetic fixture process. Parent kills only on an explicit durable checkpoint. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Layer, Result } from 'effect';
import {
  Bytes,
  LedgerClient,
  JournalStore,
  EpochKeyring,
  DistributionStore,
  KeyMailboxRemote,
} from '../src/effect';
import {
  MemoryJournalStore,
  deviceSignerLayer,
  ledgerTransportLayer,
  hpkeRecipientLayer,
  signatureVerifierLayer,
} from '../src/platform';
import { nodeDistributionStoreLayer, nodeEpochFilesLayer } from '../src/platform/node-journal';
import { MemoryLedgerStream } from '../src/ledger/submit';
import { fromHex } from '../src/pure/key-mailbox';
const value = <A, E>(r: Result.Result<A, E>) => Result.getOrThrowWith(r, (e) => e);
const dir = process.argv[2]!,
  mode = process.argv[3]!;
const f = JSON.parse(readFileSync(join(dir, 'fixture.json'), 'utf8')) as {
  anchor: string;
  records: string[];
  recipient: string;
  sender: string;
  privateJwk: JsonWebKey;
  dhJwk: JsonWebKey;
  enc: string;
  frame: string;
};
const genesis = value(Bytes.genesisHash(fromHex(f.anchor)));
const signing = await crypto.subtle.importKey('jwk', f.privateJwk, 'Ed25519', false, ['sign']);
const dhPrivate = await crypto.subtle.importKey('jwk', f.dhJwk, 'X25519', false, ['deriveBits']);
const dhPublic = await crypto.subtle.importKey('raw', fromHex(f.enc), 'X25519', true, []);
const stream = new MemoryLedgerStream();
stream.records = f.records.map(fromHex);
const ledger = await Effect.runPromise(
  LedgerClient.importGenesis({ anchor: genesis, genesisRecord: fromHex(f.records[0]!) }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(JournalStore, new MemoryJournalStore()),
        ledgerTransportLayer(stream),
        signatureVerifierLayer,
        deviceSignerLayer(
          value(Bytes.signingPublicKey(fromHex(f.recipient))),
          async (b) =>
            new Uint8Array(await crypto.subtle.sign('Ed25519', signing, new Uint8Array(b)))
        )
      )
    )
  )
);
const pause = (stage: string) =>
  Effect.sync(() => process.send?.({ stage })).pipe(Effect.andThen(Effect.never));
const distribution = nodeDistributionStoreLayer({
  path: join(dir, 'distribution.sqlite'),
  mode: mode === 'resume' ? 'open' : 'create',
});
const crashStore = Layer.effect(
  DistributionStore,
  Effect.gen(function* () {
    const actual = yield* DistributionStore;
    return DistributionStore.of({
      exclusive: (work) =>
        actual.exclusive((tx) =>
          work({
            ...tx,
            save: (d) =>
              tx
                .save(d)
                .pipe(
                  Effect.andThen(
                    mode === 'report' && d.receives.some((t) => t.phase === 'report')
                      ? pause('report')
                      : mode === 'terminal' && d.results.length
                        ? pause('terminal')
                        : Effect.void
                  )
                ),
          })
        ),
    });
  })
).pipe(Layer.provide(distribution));
const keyring = nodeEpochFilesLayer({
  genesis,
  candidatePath: join(dir, 'candidate.json'),
  keyringPath: join(dir, 'epochs.json'),
});
const crashKeyring = Layer.effect(
  EpochKeyring,
  Effect.gen(function* () {
    const actual = yield* EpochKeyring;
    return EpochKeyring.of({
      ...actual,
      put: (g, e, k) =>
        actual
          .put(g, e, k)
          .pipe(Effect.andThen(mode === 'install' ? pause('install') : Effect.void)),
    });
  })
).pipe(Layer.provide(keyring));
const remote = Layer.succeed(KeyMailboxRemote, {
  status: (slot) => Effect.succeed({ ...slot, status: 'EnvelopeStored', revision: 0 }),
  fetch: () =>
    Effect.succeed({ items: [{ sender: f.sender, frame: fromHex(f.frame) }], next: null }),
  list: () => Effect.succeed({ items: [], next: null }),
  report: (bytes) =>
    Effect.sync(() => {
      process.send?.({ report: Array.from(bytes) });
    }),
  repair: () => Effect.void,
});
await Effect.runPromise(
  Effect.gen(function* () {
    const client = yield* ledger.keyDistribution();
    if (mode === 'resume') yield* client.resumeReceives();
    else yield* client.fetchAndInstall();
    yield* client.flushInstallationReports();
    const results = yield* client.readUnacknowledgedResults();
    process.send?.({ results: results.items });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        crashStore,
        crashKeyring,
        remote,
        hpkeRecipientLayer({ publicKey: dhPublic, privateKey: dhPrivate }),
        signatureVerifierLayer
      )
    )
  )
);
process.disconnect?.();
