import { Context, Effect, Exit, Layer, Result, Scope } from 'effect';
import { importBrowserDevice } from '@lody/e2ee-core/adapters/browser-crypto';
import {
  indexedDbClientRpcOriginals,
  indexedDbClientApprovalEvidence,
} from '@lody/e2ee-core/adapters/indexeddb';
import { Bytes } from '@lody/e2ee-core/protocol';
import {
  ClientRpcOriginalStore,
  ClientApprovalEvidenceStore,
  DeviceIdentity,
  WorkspaceScope,
} from '@lody/e2ee-core/services';
let scope: Scope.Closeable,
  store: ClientRpcOriginalStore['Service'],
  evidence: ClientApprovalEvidenceStore['Service'];
export async function boot(mode: 'create-or-open' | 'open-existing' = 'create-or-open') {
  await Effect.runPromise(
    Effect.gen(function* () {
      scope = yield* Scope.make();
      const device = yield* importBrowserDevice({
        signingPrivate: new Uint8Array(32).fill(1),
        encryptionPrivate: new Uint8Array(32).fill(2),
      }).pipe(Effect.provideService(Scope.Scope, scope));
      const genesis = Result.getOrThrow(Bytes.genesisHash(new Uint8Array(32).fill(3)));
      const options = {
        databaseName: 'client-rpc',
        mode,
        binding: {
          accountId: 'account',
          workspaceId: 'workspace',
          genesis,
          device: device.publicKey,
          installationId: '11'.repeat(32),
        },
      };
      const layer = Layer.mergeAll(
        indexedDbClientRpcOriginals(options),
        indexedDbClientApprovalEvidence(options)
      ).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(WorkspaceScope, { genesis }),
            Layer.succeed(DeviceIdentity, { signer: device, encryptionKeyPair: device.encryption })
          )
        )
      );
      const context = yield* Layer.buildWithScope(layer, scope);
      store = Context.get(context, ClientRpcOriginalStore);
      evidence = Context.get(context, ClientApprovalEvidenceStore);
    })
  );
}
export async function invoke(action: string) {
  const value = await Effect.runPromise(
    Effect.result(
      Effect.gen(function* () {
        const original = { target: 'machine', signer: '22'.repeat(32), frame: Uint8Array.of(1, 2) };
        switch (action) {
          case 'corruptProof':
            return yield* Effect.tryPromise({
              try: () =>
                new Promise<number>((resolve, reject) => {
                  const open = indexedDB.open('client-rpc');
                  open.onerror = () => reject(open.error);
                  open.onsuccess = () => {
                    const db = open.result,
                      tx = db.transaction('data', 'readwrite'),
                      rows = tx.objectStore('data'),
                      cursor = rows.openCursor();
                    cursor.onsuccess = () => {
                      const item = cursor.result;
                      if (!item) return;
                      const k = item.primaryKey;
                      if (
                        Array.isArray(k) &&
                        k[1] === 'approval-evidence-page' &&
                        k[2] === 'aa'.repeat(16) &&
                        k[3] === 0
                      ) {
                        rows.put({ ...item.value, index: 0 }, [k[0], k[1], k[2], 0.5]);
                        return;
                      }
                      item.continue();
                    };
                    tx.oncomplete = () => {
                      db.close();
                      resolve(3);
                    };
                    tx.onabort = () => {
                      db.close();
                      reject(tx.error);
                    };
                  };
                }),
              catch: (cause) => cause,
            });
          case 'proof':
            return (yield* evidence.retain('aa'.repeat(16), [
              Uint8Array.of(1, 2),
              Uint8Array.of(3),
            ])).map((page) => Array.from(page));
          case 'proofChanged':
            return yield* evidence.retain('aa'.repeat(16), [Uint8Array.of(8), Uint8Array.of(3)]);
          case 'proofQuota':
            return yield* evidence.retain('bb'.repeat(16), [Uint8Array.of(4), Uint8Array.of(5)]);
          case 'proofRows':
            return {
              first: (yield* evidence.load('aa'.repeat(16)))?.map((page) => Array.from(page)),
              quota:
                (yield* evidence.load('bb'.repeat(16)))?.map((page) => Array.from(page)) ?? null,
            };
          case 'large':
            return (yield* store.retain('sent', 'large', {
              ...original,
              frame: new Uint8Array(2 * 1024 * 1024).fill(0x45),
            })).frame.length;
          case 'largeRead':
            return (yield* store.read('sent', 'large'))?.frame.length;
          case 'first':
            return Array.from((yield* store.retain('sent', 'request', original)).frame);
          case 'changed':
            return Array.from(
              (yield* store.retain('sent', 'request', { ...original, frame: Uint8Array.of(9) }))
                .frame
            );
          case 'incoming':
            return yield* store.retain('received', 'request', original);
          case 'incomingChanged':
            return yield* store.retain('received', 'request', {
              ...original,
              frame: Uint8Array.of(9),
            });
          case 'seedConflict':
            return yield* store.retainResponse('conflict', 1, Uint8Array.of(7));
          case 'batchConflict':
            return yield* store.retainResponsePages('conflict', [
              Uint8Array.of(4),
              Uint8Array.of(5),
            ]);
          case 'batchQuota':
            return yield* store.retainResponsePages('quota', [Uint8Array.of(4), Uint8Array.of(5)]);
          case 'rows':
            return {
              conflict: [
                (yield* store.readResponse('conflict', 0)) ?? null,
                (yield* store.readResponse('conflict', 1)) ?? null,
              ].map((x) => x && Array.from(x)),
              quota: [
                (yield* store.readResponse('quota', 0)) ?? null,
                (yield* store.readResponse('quota', 1)) ?? null,
              ].map((x) => x && Array.from(x)),
            };
          case 'close':
            return yield* store.close();
          default:
            throw new Error('fixture action');
        }
      })
    )
  );
  return Result.isSuccess(value)
    ? { ok: true, value: value.success }
    : {
        ok: false,
        reason:
          typeof value.failure === 'object' && value.failure !== null && 'reason' in value.failure
            ? value.failure.reason
            : 'fixture-error',
      };
}
export async function stop() {
  await Effect.runPromise(Scope.close(scope, Exit.void));
}
