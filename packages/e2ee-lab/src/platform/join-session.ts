import { openSqliteStore } from '@lody/e2ee-core/internal';
import { isAbsolute } from 'node:path';
import { Data, Effect, Result } from 'effect';
import { Bytes } from '@lody/e2ee-core';
import { verifySignature } from '@lody/e2ee-core/protocol';
import { prepareJoinRequest } from '@lody/e2ee-core/protocol';
import { joinRequestSigningBytes } from '@lody/e2ee-core/protocol';
import { labJoinWire, parseLabJoin } from './join-mailbox';
import { makeLabHttpIdentity } from './http-identity';
import { makeLabOperations } from './operation-scope';
export class LabJoinSessionError extends Data.TaggedError('LabJoinSessionError')<{
  readonly code: 'storage' | 'context' | 'closed';
}> {}
/** Original signed join intent is public consent, never authority. Persist before
 * POST; reopen verifies exact caller Org/device/user/request/enc/expiry context and
 * fixed signature. Receipt is delivery only. No new identity/vault/control layout. */
export const openLabJoinSession = Effect.fn('Lab.openJoinSession')(function* (
  input: Parameters<typeof prepareJoinRequest>[0] & {
    readonly path: string;
    readonly mode: 'create' | 'open';
    readonly baseUrl: string;
    readonly fetch?: typeof fetch;
  }
) {
  const config = {
    ...input,
    signer: {
      publicKey: Result.getOrThrow(Bytes.signingPublicKey(input.signer.publicKey.toBytes())),
      sign: input.signer.sign.bind(input.signer),
    },
  };
  const org = Buffer.from(config.genesis.toBytes()).toString('hex'),
    device = Buffer.from(config.signer.publicKey.toBytes()).toString('hex');
  if (!isAbsolute(config.path) || !['create', 'open'].includes(config.mode))
    return yield* new LabJoinSessionError({ code: 'context' });
  const sql = <A>(work: () => A) =>
    Effect.try({ try: work, catch: () => new LabJoinSessionError({ code: 'storage' }) });
  const db = yield* openSqliteStore({
    path: config.path,
    mode: config.mode,
    applicationId: 1279609418,
    version: 1,
    error: () => new LabJoinSessionError({ code: 'storage' }),
    initialize: (connection) =>
      connection.exec(
        'CREATE TABLE pending_join(id INTEGER PRIMARY KEY CHECK(id=1),org TEXT NOT NULL,device TEXT NOT NULL,original TEXT NOT NULL CHECK(length(original)<=8192));'
      ),
  });
  const original =
    config.mode === 'create'
      ? JSON.stringify(labJoinWire(yield* prepareJoinRequest(config)))
      : yield* sql(() => {
          const row = db
            .prepare('SELECT org,device,original FROM pending_join WHERE id=1')
            .get() as { org: unknown; device: unknown; original: unknown } | undefined;
          if (
            !row ||
            row.org !== org ||
            row.device !== device ||
            typeof row.original !== 'string' ||
            row.original.length > 8192
          )
            throw new Error('context');
          return row.original;
        });
  const request = yield* Effect.fromResult(
    parseLabJoin(yield* sql(() => JSON.parse(original) as unknown))
  );
  if (
    !request.signingPublicKey.equals(config.signer.publicKey) ||
    !request.requestId.equals(config.requestId) ||
    !request.userId.equals(config.userId) ||
    !request.encryptionPublicKey.equals(config.encryptionPublicKey) ||
    request.expiresAt !== config.expiresAt
  )
    return yield* new LabJoinSessionError({ code: 'context' });
  yield* Effect.fromResult(
    verifySignature(
      request.signingPublicKey.toBytes(),
      yield* Effect.fromResult(joinRequestSigningBytes(config.genesis, request)),
      request.signature.toBytes()
    )
  );
  if (config.mode === 'create')
    yield* sql(() =>
      db
        .transaction(() => {
          if (
            db.prepare('INSERT INTO pending_join VALUES(1,?,?,?)').run(org, device, original)
              .changes !== 1
          )
            throw new Error('not-written');
          const saved = db
            .prepare('SELECT org,device,original FROM pending_join WHERE id=1')
            .get() as { org: string; device: string; original: string };
          if (saved.org !== org || saved.device !== device || saved.original !== original)
            throw new Error('readback');
        })
        .immediate()
    );
  const identity = yield* makeLabHttpIdentity({
    baseUrl: config.baseUrl,
    genesis: config.genesis,
    fetch: config.fetch,
  });
  const discovery = yield* identity.authenticate(config.signer, 'unbound');
  yield* discovery.discoverGenesis(); // verifies original/hash only; no current permission view
  const operations = yield* makeLabOperations();
  yield* Effect.addFinalizer(() => identity.stop());
  return Object.freeze({
    /** Retry saved original; never re-sign or remove intent on a lost receipt. */
    submit: () => operations.run(discovery.submitJoin(request)),
    original: () => Object.freeze(labJoinWire(request)),
    discovery,
  });
});
