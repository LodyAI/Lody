import { Effect, Result } from 'effect';
import { makeSqliteProtectedEpochKeys } from './harness';
import { commitEpochKey } from '../../src/internal/keys/history';
import { envelopeFixture } from './fixture';
import { synthetic } from './protection-fixture';
const f = envelopeFixture();
// Fixed public fixture transition, not an envelope reopen or production trust source.
if (process.argv[3] === 'sender-revoked') f.append([5, f.owner.raw]);
else if (process.argv[3] !== undefined) throw new Error('unknown synthetic transition');
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* makeSqliteProtectedEpochKeys({
        path: process.argv[2]!,
        mode: 'open',
        genesis: f.context.genesis,
        recipient: f.phone.publicKey,
        ledger: f.ledger,
        protector: synthetic().protector,
      });
      const key = yield* store.read(0);
      console.log(
        Buffer.from(
          Result.getOrThrow(commitEpochKey(f.context.genesis, 0, key)).toBytes()
        ).toString('hex')
      );
    })
  )
);
