import { Effect, Result } from 'effect';
import { commitEpochKey } from '@lody/e2ee-core/protocol';
import { decodeRecord } from '@lody/e2ee-core/protocol';
import { makeSqliteProtectedEpochKeys } from '@lody/e2ee-core/internal';
import { labSyntheticProtector } from '../src/platform/synthetic-protection';
import { Bytes } from '@lody/e2ee-core';
import { makeLabWorkspaceCreation } from '../src/platform/workspace-creation';
import { makeLabWorkspaceRegistry } from '../src/platform/workspace-registry';
const [path, registryPath, baseUrl, original, head, length, keysPath] = process.argv.slice(2);
const output = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* makeLabWorkspaceRegistry({ path: registryPath!, mode: 'open' });
      const owner = yield* makeLabWorkspaceCreation({
        path: path!,
        mode: 'open',
        genesisRecord: new Uint8Array(Buffer.from(original!, 'hex')),
        baseUrl: baseUrl!,
        registry,
        minimum: {
          head: Result.getOrThrow(Bytes.recordHash(new Uint8Array(Buffer.from(head!, 'hex')))),
          length: Number(length),
        },
        budget: { maxRecords: 100, maxBytes: 1024 * 1024 },
      });
      const current = yield* owner.refresh();
      let keyCommitment: boolean | undefined;
      if (keysPath) {
        const body = Result.getOrThrow(decodeRecord(owner.record())).body;
        if (body.type !== 'genesis') throw new Error('genesis required');
        const keys = yield* makeSqliteProtectedEpochKeys({
          path: keysPath,
          mode: 'open',
          genesis: owner.genesis,
          recipient: body.signer,
          ledger: () => Effect.succeed(current.view),
          protector: labSyntheticProtector,
        });
        const key = yield* keys.read(0);
        keyCommitment = Result.getOrThrow(commitEpochKey(owner.genesis, 0, key)).equals(
          body.epochCommitment
        );
      }
      return {
        ...(keysPath ? { keyCommitment } : {}),
        count: current.view.length,
        head: Buffer.from(current.view.head.toBytes()).toString('hex'),
        original: Buffer.from(owner.record()).toString('hex'),
      };
    })
  )
);
console.log(JSON.stringify(output));
