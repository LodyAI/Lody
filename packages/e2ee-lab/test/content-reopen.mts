import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Result } from 'effect';
import { LoroDoc } from 'loro-crdt';
import { Flock } from '@loro-dev/flock-wasm';
import { StreamsCrdt as FlockStreamsCrdt, createFlockAdapter } from '@loro-dev/streams-crdt/flock';
import { StreamsCrdt, createLoroDocAdapter } from '@loro-dev/streams-crdt/loro';
import { Bytes } from '@lody/e2ee-core';
import { hashRecordBytes, verifyLedger } from '@lody/e2ee-core/protocol';
import { makeSqliteProtectedEpochKeys } from '@lody/e2ee-core/internal';
import { makeLabSdkOwner } from '../src/platform/sdk-owner';
import { makeLabUpdateProvider } from '../src/platform/content-provider';
import { makeLabDocumentStore } from '../src/platform/document-sqlite';
import { labSyntheticProtector } from '../src/platform/synthetic-protection';
const [dir, url, genesisHex, publicKeyHex, requestedModel = 'loro'] = process.argv.slice(2);
if (requestedModel !== 'loro' && requestedModel !== 'flock')
  throw new Error('unsupported synthetic model');
const model = requestedModel;
const resource = model === 'flock' ? 'flock-A' : 'document-A';
const ok = Result.getOrThrow;
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const genesis = ok(Bytes.genesisHash(new Uint8Array(Buffer.from(genesisHex!, 'hex'))));
      const publicKey = ok(
        Bytes.signingPublicKey(new Uint8Array(Buffer.from(publicKeyHex!, 'hex')))
      );
      const record = new Uint8Array(readFileSync(join(dir!, 'content-genesis.cbor')));
      const view = ok(
        verifyLedger({
          anchor: genesis,
          records: [record],
          checkpoint: { head: hashRecordBytes(record), length: 1 },
        })
      );
      const keys = yield* makeSqliteProtectedEpochKeys({
        path: join(dir!, 'content-keys.sqlite'),
        mode: 'open',
        genesis,
        recipient: publicKey,
        ledger: () => Effect.succeed(view),
        protector: labSyntheticProtector,
      });
      const provider = yield* makeLabUpdateProvider({
        genesis,
        resource,
        model,
        writeEpoch: 0,
        signer: { publicKey, sign: () => Effect.die('reopened reader has no signer') },
        ledger: () => Effect.succeed(view),
        readEpochKey: keys.read,
      });
      let flock: Flock | undefined;
      const doc = yield* Effect.acquireRelease(
        Effect.sync(() => (model === 'loro' ? new LoroDoc() : undefined)),
        (value) => Effect.sync(() => value?.free())
      );
      const store = yield* makeLabDocumentStore({
        path: join(dir!, resource + '.sqlite'),
        mode: 'open',
        genesis: genesisHex!,
        resource,
        model,
        streamUrl: url!,
      });
      const state = yield* store.restore();
      if (!state) throw new Error('missing durable CRDT');
      if (doc) doc.import(state);
      else
        flock = yield* Effect.acquireRelease(
          Effect.sync(() => Flock.fromFile(state, 'synthetic-reopened-flock')),
          () =>
            Effect.sync(() => {
              flock = undefined;
            })
        ); // Public Flock0.4.3 has no free/dispose: stop SDK, then drop references only.
      const restoredCursor = yield* store.inspectCursor();
      const reader = yield* makeLabSdkOwner(({ assertOpen }) => {
        const common = {
          streamUrl: url!,
          remoteCursorStore: store.cursorStore,
          beforeRemoteCursorSave: async () => {
            assertOpen();
            ok(store.stage(doc ? doc.export({ mode: 'snapshot' }) : flock!.exportFile()));
          },
          payloadProtectionRequired: true,
          e2ee: {
            provider,
            readPolicy: 'encrypted-only' as const,
            writePolicy: 'encrypt' as const,
          },
        };
        return doc
          ? new StreamsCrdt({ ...common, adapter: createLoroDocAdapter(doc) })
          : new FlockStreamsCrdt({ ...common, adapter: createFlockAdapter(flock!) });
      });
      const pulled = yield* reader.invoke((sdk) => sdk.catchup());
      if (!pulled.ok)
        throw new Error(`real reopened SDK catchup failed: ${JSON.stringify(pulled)}`);
      const cursor = yield* store.inspectCursor();
      process.stdout.write(
        JSON.stringify({
          ...(doc
            ? { text: doc.getText('text').toString() }
            : {
                value: flock!.get(['private', 'note']),
                second: flock!.get(['private', 'second']),
                restoredCursor,
              }),
          cursor,
        }) + '\n'
      );
    })
  )
);
