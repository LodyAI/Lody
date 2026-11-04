import { readFileSync } from 'node:fs';
import { Effect, Result } from 'effect';
import { Bytes } from '@lody/e2ee-core/protocol';
import { makeSqliteSnapshotPublication } from '@lody/e2ee-core/adapters/node-sqlite';

const input = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const report = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* makeSqliteSnapshotPublication({
        path: input.path,
        mode: 'open',
        resource: input.resource,
        model: input.model,
        genesis: Result.getOrThrow(
          Bytes.genesisHash(new Uint8Array(Buffer.from(input.genesis, 'hex')))
        ),
      });
      const current = yield* store.current(),
        pending = yield* store.pending();
      const archived =
        typeof input.lookupOffset === 'string'
          ? yield* store.lookup(input.lookupOffset)
          : undefined;
      return {
        ...(archived
          ? {
              archived: {
                offset: archived.offset,
                digest: archived.digest,
                body: archived.body,
                phase: archived.phase,
              },
            }
          : {}),
        pid: process.pid,
        current: current?.offset,
        pending: pending?.offset,
        body: pending && Buffer.from(pending.body).toString('hex'),
        oldPhase: current?.phase,
        newPhase: pending?.phase,
        currentLease: current && [current.issuedAt, current.expiresAt],
        pendingLease: pending && [pending.issuedAt, pending.expiresAt],
      };
    })
  )
);
process.stdout.write(JSON.stringify(report));
