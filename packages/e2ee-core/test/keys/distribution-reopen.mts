import path from 'node:path';
import { Effect, Result } from 'effect';
import { ContentError } from '@lody/e2ee-core/protocol';
import { makeSqliteKeyDistribution } from './harness';
import { makeSqliteKeyMailbox } from '@lody/e2ee-core/adapters/node-sqlite';
import { envelopeFixture, recipientPair } from './fixture';
import { synthetic } from './protection-fixture';

// Synthetic process fixture; no production keys, transport or native-platform claim.
const f = envelopeFixture(),
  pair = await recipientPair();
const file = (name: string) => path.join(process.argv[2]!, `${name}.sqlite`);
const result = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const host = yield* makeSqliteKeyMailbox({
        path: file('host'),
        mode: 'open',
        genesis: f.context.genesis,
        ledger: f.ledger,
      });
      const remote = Result.getOrThrow(host.bind(f.owner.publicKey));
      const client = yield* makeSqliteKeyDistribution({
        path: file('receive'),
        mode: 'open',
        genesis: f.context.genesis,
        signer: {
          publicKey: f.owner.publicKey,
          sign: () => Effect.fail(new ContentError({ code: 'bad-signature' })),
        },
        pair,
        ledger: f.ledger,
        remote,
        keyStore: { path: file('keys'), mode: 'open', protector: synthetic().protector },
        repairStore: { path: file('repair'), mode: 'open' },
        sendStore: { path: file('send'), mode: 'open' },
        outboxStore: { path: file('outbox'), mode: 'open' },
        currentPublication: () => Effect.succeed(null),
      });
      const resumed = yield* client.resumePendingDeliveries();
      yield* client.flushReports();
      const results = yield* client.deliveryResults();
      const publication = yield* remote.status({
        genesis: Buffer.from(f.context.genesis.toBytes()).toString('hex'),
        epoch: 0,
        recipient: Buffer.from(f.owner.raw).toString('hex'),
      });
      return { ...resumed, outcome: results.items[0]?.outcome, publication: publication.status };
    })
  )
);
process.stdout.write(JSON.stringify(result));
