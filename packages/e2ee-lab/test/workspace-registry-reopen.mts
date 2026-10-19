import { Effect, Result } from 'effect';
import { Bytes } from '@lody/e2ee-core';
import { makeLabWorkspaceRegistry } from '../src/platform/workspace-registry';
const path = process.argv[2]!,
  expectedHex = process.argv[3]!;
const anchor = Result.getOrThrow(
  Bytes.genesisHash(new Uint8Array(Buffer.from(expectedHex, 'hex')))
);
const summary = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* makeLabWorkspaceRegistry({ path, mode: 'open' });
      const saved = yield* registry.get(anchor);
      if (!saved || !saved.anchor.equals(anchor))
        throw new Error('missing verified genesis after OS reopen');
      return {
        genesisHex: Buffer.from(saved.anchor.toBytes()).toString('hex'),
        recordHex: Buffer.from(saved.record).toString('hex'),
      };
    })
  )
);
process.stdout.write(JSON.stringify(summary));
