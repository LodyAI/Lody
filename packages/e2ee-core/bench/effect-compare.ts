/** Compare native Effect paths against a same-wire-format package checkout.
 * Usage: tsx bench/effect-compare.ts /absolute/baseline/packages/e2ee-core
 * One shared real-signed fixture; fresh verifier per client/run; SQLite journals.
 * This measures cold clients in a warmed process, not cold process startup.
 */
import { Effect, Either, Layer } from 'effect';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildChain } from './chain';
import { Ledger } from '../src/ledger/ledger';
import { decodeRecord } from '../src/ledger/schema';

const baseline = process.argv[2];
if (!baseline) throw new Error('Supply a baseline package root with the same wire format');
const current = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const load = (root: string, path: string) => import(pathToFileURL(join(root, path)).href);
async function version(label: string, root: string) {
  const api = (await load(root, 'src/effect.ts')) as typeof import('../src/effect');
  const platform = (await load(root, 'src/platform/index.ts')) as typeof import('../src/platform');
  const sqlite = (await load(
    root,
    'src/platform/node-journal.ts'
  )) as typeof import('../src/platform/node-journal');
  const legacy = (await load(
    root,
    'src/ledger/submit.ts'
  )) as typeof import('../src/ledger/submit');
  const disk = (await load(
    root,
    'src/ledger/node-store.ts'
  )) as typeof import('../src/ledger/node-store');
  return { label, api, platform, sqlite, legacy, disk };
}
const versions = await Promise.all([
  version('before', resolve(baseline)),
  version('after', current),
]);
const fixture = await buildChain(1000);
const proposal = fixture.ledger.prepareSnapshot(fixture.owner.publicKey);
const snapshot = await Ledger.finalizeSnapshot(
  proposal,
  await fixture.owner.sign(proposal.signingBytes)
);
const headSignature = await fixture.owner.sign(proposal.headAttestationSigningBytes);
const last = decodeRecord(fixture.records.at(-1)!);
if (last.body.type !== 'ordinary' || last.body.fields.operation.type !== 'admitDevice')
  throw new Error('Expected the fixture to end with a device admission');
const admission = last.body.fields.operation;
const dir = mkdtempSync(join(tmpdir(), 'e2ee-native-compare-'));
const results: Record<string, Record<string, number[]>> = {};
const value = <A, E>(result: Either.Either<A, E>) =>
  Either.getOrThrowWith(result, (error) => error);
const equal = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
for (const metric of ['replay', 'submit', 'snapshot', 'recovery', 'snapshot-promise']) {
  results[metric] = { before: [], after: [] };
  for (let round = 0; round < 13; round++) {
    for (const v of round % 2 === 0 ? versions : [...versions].reverse()) {
      const { api, platform } = v;
      const anchor = value(api.Bytes.genesisHash(fixture.created.anchor));
      const signer = platform.deviceSignerLayer(
        value(api.Bytes.signingPublicKey(fixture.owner.publicKey)),
        fixture.owner.sign
      );
      let work: () => Promise<{ length: number; head: Uint8Array }>;
      const stream = new v.legacy.MemoryLedgerStream();
      const path = join(dir, `${v.label}-${metric}-${round}.sqlite`);
      const shape = (view: import('../src/pure/records').LedgerView) => ({
        length: view.length,
        head: view.head.toBytes(),
      });
      if (metric === 'replay') {
        work = () =>
          Effect.runPromise(
            api
              .verifyLedger({ anchor, records: fixture.records })
              .pipe(Effect.map(shape), Effect.provide(platform.signatureVerifierLayer))
          );
      } else {
        const store = new v.disk.SqliteLedgerStore(path, {
          createFile: true,
          initializeSchema: true,
        });
        // Legacy SQLite opens lazily. Materialize the empty store outside timing
        // before the native layer deliberately opens (never creates) it.
        await store.exclusive((tx) => tx.load());
        const records = metric === 'submit' ? fixture.records.slice(0, -1) : fixture.records;
        stream.records = records.slice(1);
        if (metric === 'submit' || metric === 'recovery') {
          await store.exclusive((tx) =>
            tx.save({
              genesis: fixture.created.anchor,
              records,
              pending: null,
              offset: stream.tail,
            })
          );
        }
        const layer = Layer.mergeAll(
          signer,
          platform.signatureVerifierLayer,
          platform.ledgerTransportLayer(stream),
          v.sqlite.nodeJournalStoreLayer({ path, mode: 'open' })
        );
        if (metric === 'snapshot-promise') {
          work = async () => {
            const client = await v.legacy.LedgerClient.openFromSnapshot({
              trust: {
                genesis: fixture.created.anchor,
                endorser: fixture.owner.publicKey,
                head: proposal.head,
                headSignature,
              },
              snapshot,
              store,
              stream,
            });
            const view = await client.read();
            return { length: view.length, head: view.head };
          };
        } else if (metric === 'snapshot') {
          const input = {
            genesis: anchor,
            endorser: value(api.Bytes.signingPublicKey(fixture.owner.publicKey)),
            head: value(api.Bytes.recordHash(proposal.head)),
            headSignature: value(api.Bytes.signature(headSignature)),
            snapshot,
          };
          work = () =>
            Effect.runPromise(
              Effect.gen(function* () {
                const client = yield* api.LedgerClient.createFromSnapshot(input);
                return shape(yield* client.refresh());
              }).pipe(Effect.provide(layer))
            );
        } else if (metric === 'recovery') {
          work = () =>
            Effect.runPromise(
              Effect.gen(function* () {
                const client = yield* api.LedgerClient.restore(anchor);
                return shape(yield* client.refresh());
              }).pipe(Effect.provide(layer))
            );
        } else {
          const client = await Effect.runPromise(
            api.LedgerClient.restore(anchor).pipe(Effect.provide(layer))
          );
          const command: import('../src/pure/commands').LedgerCommand = {
            _tag: 'AdmitDevice',
            kind: admission.kind,
            signingPublicKey: value(api.Bytes.signingPublicKey(admission.signingPublicKey)),
            encryptionPublicKey: value(
              api.Bytes.encryptionPublicKey(admission.encryptionPublicKey)
            ),
            possessionSignature: value(api.Bytes.signature(admission.possessionSignature)),
          };
          work = () =>
            Effect.runPromise(
              client.execute(command).pipe(
                Effect.map((result) => {
                  if (result._tag !== 'Committed')
                    throw new Error(`submit returned ${result._tag}`);
                  return shape(result.ledger);
                })
              )
            );
        }
      }
      const start = performance.now();
      const view = await work();
      const elapsed = performance.now() - start;
      if (view.length !== 1000 || !equal(view.head, fixture.ledger.head))
        throw new Error(`${metric}: wrong verified state`);
      if (round >= 3) results[metric]![v.label]!.push(elapsed);
      process.stderr.write(`${metric} ${round} ${v.label} ${elapsed.toFixed(2)}ms\n`);
    }
  }
  writeFileSync(join(dir, 'samples.json'), JSON.stringify(results, null, 2));
}
const median = (samples: number[]) => {
  const xs = [...samples].sort((a, b) => a - b);
  return (xs[4]! + xs[5]!) / 2;
};
const report = {
  node: process.version,
  records: 1000,
  warmup: 3,
  runs: 10,
  baseline: resolve(baseline),
  current,
  summary: Object.fromEntries(
    Object.entries(results).map(([metric, samples]) => {
      const before = median(samples.before!),
        after = median(samples.after!);
      return [metric, { before, after, changePercent: 100 * (after / before - 1) }];
    })
  ),
  results,
};
writeFileSync(join(dir, 'results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, artifacts: dir }, null, 2));
