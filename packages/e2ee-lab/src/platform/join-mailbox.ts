import { openSqliteStore } from '@lody/e2ee-core/internal';
import { isAbsolute } from 'node:path';
import { Data, Effect, Result } from 'effect';
import { Bytes } from '@lody/e2ee-core';
import { verifySignature } from '@lody/e2ee-core/protocol';
import { type LedgerView } from '@lody/e2ee-core';
import {
  joinRequestSigningBytes,
  requireLedgerContinuation,
  type JoinRequest,
} from '@lody/e2ee-core/protocol';
import type { LabCredential } from './credentials';
import { makeLabOperations } from './operation-scope';
import {
  verifyWorkspaceInvitationSnapshot,
  type WorkspaceInvitationSnapshot,
} from '@lody/e2ee-core';
import { invitationSnapshotWire, parseInvitationSnapshot } from './invitation-wire';
import { authorizeLabStream } from './gateway';
const APP = 0x4c454a31;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
export class LabJoinError extends Data.TaggedError('LabJoinError')<{
  readonly code: 'invalid-input' | 'unauthorized' | 'conflict' | 'storage' | 'corrupt' | 'closed';
}> {}
const fail = (code: LabJoinError['code']) => new LabJoinError({ code });
/** Existing Lab JSON DTO, not a new protocol/vault format. */
export function labJoinWire(request: JoinRequest) {
  return {
    requestId: hex(request.requestId.toBytes()),
    userId: hex(request.userId.toBytes()),
    signingPublicKey: hex(request.signingPublicKey.toBytes()),
    encryptionPublicKey: hex(request.encryptionPublicKey.toBytes()),
    expiresAt: request.expiresAt,
    signature: hex(request.signature.toBytes()),
  };
}
export function parseLabJoin(value: unknown) {
  return Result.try({
    try: () => {
      const wire = value as ReturnType<typeof labJoinWire>;
      const bytes = (encoded: unknown, size: number) => {
        if (
          typeof encoded !== 'string' ||
          encoded.length !== size * 2 ||
          !/^[0-9a-f]+$/.test(encoded)
        )
          throw fail('invalid-input');
        return new Uint8Array(Buffer.from(encoded, 'hex'));
      };
      if (
        !wire ||
        (wire.expiresAt !== null && (!Number.isSafeInteger(wire.expiresAt) || wire.expiresAt < 0))
      )
        throw fail('invalid-input');
      return {
        requestId: Result.getOrThrow(Bytes.requestId(bytes(wire.requestId, 16))),
        userId: Result.getOrThrow(Bytes.userId(bytes(wire.userId, 32))),
        signingPublicKey: Result.getOrThrow(
          Bytes.signingPublicKey(bytes(wire.signingPublicKey, 32))
        ),
        encryptionPublicKey: Result.getOrThrow(
          Bytes.encryptionPublicKey(bytes(wire.encryptionPublicKey, 32))
        ),
        expiresAt: wire.expiresAt,
        signature: Result.getOrThrow(Bytes.signature(bytes(wire.signature, 64))),
      } satisfies JoinRequest;
    },
    catch: () => fail('invalid-input'),
  });
}
/** Reference Lab join mailbox only. Account is a synthetic credential label, not
 * verified product identity. It stores public signed requests, never secret keys.
 * Receipt is inert: ledger admission independently verifies proof and ordinary
 * join expiry at CAS; no new deadline B or automatic membership is introduced.
 * Same request ID may be replaced only by its original signing key, preserving
 * the original Lab contract. First user/account association is never reassigned. */
export function makeLabJoinMailbox(input: {
  readonly path: string;
  readonly mode: 'create' | 'open';
  readonly genesis: Bytes.GenesisHash;
  readonly ledger: (signal: AbortSignal) => Effect.Effect<LedgerView, unknown>;
}) {
  return Effect.gen(function* () {
    const { path, mode, ledger } = input;
    const anchor = yield* Effect.fromResult(Bytes.genesisHash(input.genesis.toBytes()));
    const org = hex(anchor.toBytes());
    const sql = <A>(work: () => A) =>
      Effect.try({
        try: work,
        catch: (error) => (error instanceof LabJoinError ? error : fail('storage')),
      });
    if (typeof path !== 'string' || !isAbsolute(path) || (mode !== 'create' && mode !== 'open'))
      return yield* fail('invalid-input');
    const db = yield* openSqliteStore({
      path,
      mode,
      applicationId: APP,
      version: 1,
      error: fail,
      validate: (connection) => {
        if (
          (
            connection.prepare('SELECT genesis FROM join_meta WHERE id=1').get() as
              | { genesis: string }
              | undefined
          )?.genesis !== org
        )
          throw fail('corrupt');
      },
      initialize: (connection) => {
        connection
          .transaction(() => {
            connection.exec(`CREATE TABLE join_meta(id INTEGER PRIMARY KEY CHECK(id=1),genesis TEXT NOT NULL) STRICT;
          CREATE TABLE join_users(user_id TEXT PRIMARY KEY,account TEXT NOT NULL) STRICT;
          CREATE TABLE join_snapshots(request_id TEXT PRIMARY KEY,endorser TEXT NOT NULL,body TEXT NOT NULL) STRICT;
          CREATE TABLE join_requests(request_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,account TEXT NOT NULL,signer TEXT NOT NULL,body TEXT NOT NULL CHECK(length(body)<=2048)) STRICT;`);
            connection.prepare('INSERT INTO join_meta(id,genesis) VALUES(1,?)').run(org);
          })
          .immediate();
      },
    });
    const operations = yield* makeLabOperations();
    const guard = () => {
      if (operations.signal.aborted) throw fail('closed');
    };

    const capture = (credential: Pick<LabCredential, 'account' | 'device' | 'genesis'>) =>
      sql(() => {
        guard();
        if (
          typeof credential.account !== 'string' ||
          credential.account.length < 1 ||
          credential.account.length > 256 ||
          credential.account.includes('\0')
        )
          throw fail('invalid-input');
        const device = Result.getOrThrow(Bytes.signingPublicKey(credential.device.toBytes()));
        const bound =
          credential.genesis === null
            ? null
            : Result.getOrThrow(Bytes.genesisHash(credential.genesis.toBytes()));
        if (bound !== null && !bound.equals(anchor)) throw fail('unauthorized');
        return { account: credential.account, device, genesis: bound };
      });
    const current = () =>
      Effect.gen(function* () {
        const view = yield* Effect.uninterruptible(ledger(operations.signal));
        yield* Effect.fromResult(requireLedgerContinuation(view, view));
        if (!view.genesis.equals(anchor)) return yield* fail('unauthorized');
        return view;
      });
    const decodeStored = (row: {
      request_id: string;
      user_id: string;
      account: string;
      signer: string;
      body: string;
    }) => {
      try {
        if (typeof row.body !== 'string' || row.body.length > 2048) throw fail('corrupt');
        const request = Result.getOrThrow(parseLabJoin(JSON.parse(row.body)));
        const binding = db
          .prepare('SELECT account FROM join_users WHERE user_id=?')
          .get(row.user_id) as { account: string } | undefined;
        if (
          hex(request.requestId.toBytes()) !== row.request_id ||
          hex(request.signingPublicKey.toBytes()) !== row.signer ||
          hex(request.userId.toBytes()) !== row.user_id ||
          typeof row.account !== 'string' ||
          row.account.length < 1 ||
          row.account.length > 256 ||
          row.account.includes('\0') ||
          binding?.account !== row.account ||
          JSON.stringify(labJoinWire(request)) !== row.body
        )
          throw fail('corrupt');
        const message = Result.getOrThrow(joinRequestSigningBytes(anchor, request));
        if (
          Result.isFailure(
            verifySignature(
              request.signingPublicKey.toBytes(),
              message,
              request.signature.toBytes()
            )
          )
        )
          throw fail('corrupt');
        return labJoinWire(request);
      } catch {
        throw fail('corrupt');
      }
    };
    return Object.freeze({
      putSnapshot: (
        credential: Pick<LabCredential, 'account' | 'device' | 'genesis'>,
        requestId: Bytes.RequestId,
        source: WorkspaceInvitationSnapshot
      ) =>
        operations.run(
          Effect.gen(function* () {
            const identity = yield* capture(credential),
              view = yield* current();
            const state = view.inspectState(),
              device = state.devices.get(hex(identity.device.toBytes())),
              member = device && state.members.get(hex(device.membershipId.toBytes()));
            if (
              !identity.genesis ||
              device?.kind !== 'personal' ||
              (member?.role !== 'owner' && member?.role !== 'admin')
            )
              return yield* fail('unauthorized');
            const receipt = yield* Effect.fromResult(
              parseInvitationSnapshot(invitationSnapshotWire(source))
            );
            yield* Effect.fromResult(
              verifyWorkspaceInvitationSnapshot(
                { workspaceId: receipt.workspaceId, genesis: anchor, endorser: identity.device },
                receipt
              )
            );
            const body = JSON.stringify(invitationSnapshotWire(receipt)),
              request = hex(requestId.toBytes()),
              endorser = hex(identity.device.toBytes());
            yield* sql(() => {
              guard();
              db.transaction(() => {
                if (
                  !db
                    .prepare('SELECT request_id FROM join_requests WHERE request_id=?')
                    .get(request)
                )
                  throw fail('invalid-input');
                const old = db
                  .prepare('SELECT endorser,body FROM join_snapshots WHERE request_id=?')
                  .get(request) as { endorser: string; body: string } | undefined;
                if (old && (old.endorser !== endorser || old.body !== body)) throw fail('conflict');
                db.prepare(
                  'INSERT INTO join_snapshots(request_id,endorser,body) VALUES(?,?,?) ON CONFLICT(request_id) DO NOTHING'
                ).run(request, endorser, body);
                const saved = db
                  .prepare('SELECT endorser,body FROM join_snapshots WHERE request_id=?')
                  .get(request) as { endorser: string; body: string } | undefined;
                if (saved?.endorser !== endorser || saved.body !== body) throw fail('storage');
              }).immediate();
              return undefined;
            });
            return undefined;
          })
        ),
      readSnapshot: (
        credential: Pick<LabCredential, 'account' | 'device' | 'genesis'>,
        requestId: Bytes.RequestId
      ) =>
        operations.run(
          Effect.gen(function* () {
            const identity = yield* capture(credential),
              view = yield* current();
            return yield* sql(() => {
              guard();
              return db
                .transaction(() => {
                  const request = hex(requestId.toBytes()),
                    pending = db
                      .prepare('SELECT signer,account FROM join_requests WHERE request_id=?')
                      .get(request) as { signer: string; account: string } | undefined;
                  if (!pending) throw fail('invalid-input');
                  const device = view.inspectState().devices.get(hex(identity.device.toBytes()));
                  if (
                    !(
                      pending.signer === hex(identity.device.toBytes()) &&
                      pending.account === identity.account
                    ) &&
                    !device
                  )
                    throw fail('unauthorized');
                  const saved = db
                    .prepare('SELECT body FROM join_snapshots WHERE request_id=?')
                    .get(request) as { body: string } | undefined;
                  return saved
                    ? Result.getOrThrow(parseInvitationSnapshot(JSON.parse(saved.body)))
                    : null;
                })
                .deferred();
            });
          })
        ),
      put: (
        credential: Pick<LabCredential, 'account' | 'device' | 'genesis'>,
        borrowed: JoinRequest
      ) =>
        operations.run(
          Effect.gen(function* () {
            const identity = yield* capture(credential);
            const request = yield* sql(() =>
              Result.getOrThrow(parseLabJoin(labJoinWire(borrowed)))
            );
            if (!request.signingPublicKey.equals(identity.device))
              return yield* fail('unauthorized');
            const message = yield* Effect.fromResult(joinRequestSigningBytes(anchor, request));
            yield* Effect.fromResult(
              verifySignature(
                request.signingPublicKey.toBytes(),
                message,
                request.signature.toBytes()
              )
            ).pipe(Effect.mapError(() => fail('invalid-input')));
            const view = yield* current();
            if (
              view.inspectState().devices.get(hex(identity.device.toBytes()))?.kind === 'recovery'
            )
              return yield* fail('unauthorized');
            const wire = labJoinWire(request),
              body = JSON.stringify(wire);
            yield* sql(() => {
              guard();
              db.transaction(() => {
                const previous = db
                  .prepare(
                    'SELECT request_id,user_id,account,signer,body FROM join_requests WHERE request_id=?'
                  )
                  .get(wire.requestId) as
                  | {
                      request_id: string;
                      user_id: string;
                      account: string;
                      signer: string;
                      body: string;
                    }
                  | undefined;
                if (previous) decodeStored(previous);
                if (previous && previous.signer !== wire.signingPublicKey) throw fail('conflict');
                const binding = db
                  .prepare('SELECT account FROM join_users WHERE user_id=?')
                  .get(wire.userId) as { account: string } | undefined;
                if (binding && binding.account !== identity.account) throw fail('conflict');
                const existingUser = db
                  .prepare('SELECT account FROM join_requests WHERE user_id=? LIMIT 1')
                  .get(wire.userId) as { account: string } | undefined;
                if (existingUser && (!binding || existingUser.account !== binding.account))
                  throw fail('corrupt');

                db.prepare(
                  'INSERT INTO join_users(user_id,account) VALUES(?,?) ON CONFLICT(user_id) DO NOTHING'
                ).run(wire.userId, identity.account);
                db.prepare(
                  'INSERT INTO join_requests(request_id,user_id,account,signer,body) VALUES(?,?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET user_id=excluded.user_id,account=excluded.account,signer=excluded.signer,body=excluded.body'
                ).run(wire.requestId, wire.userId, identity.account, wire.signingPublicKey, body);
                const savedBinding = db
                  .prepare('SELECT account FROM join_users WHERE user_id=?')
                  .get(wire.userId) as { account: string } | undefined;
                const saved = db
                  .prepare(
                    'SELECT request_id,user_id,account,signer,body FROM join_requests WHERE request_id=?'
                  )
                  .get(wire.requestId) as
                  | {
                      request_id: string;
                      user_id: string;
                      account: string;
                      signer: string;
                      body: string;
                    }
                  | undefined;
                if (
                  savedBinding?.account !== identity.account ||
                  saved?.signer !== wire.signingPublicKey ||
                  saved.user_id !== wire.userId ||
                  saved.account !== identity.account ||
                  saved.body !== body
                )
                  throw fail('storage');
              }).immediate();
            });
            return undefined;
          })
        ),
      list: (credential: Pick<LabCredential, 'account' | 'device' | 'genesis'>) =>
        operations.run(
          Effect.gen(function* () {
            const identity = yield* capture(credential),
              view = yield* current();
            yield* Effect.fromResult(
              authorizeLabStream({
                view,
                authenticatedCredential: identity,
                requestGenesis: anchor,
                stream: 'control',
                method: 'GET',
              })
            );
            return yield* sql(() => {
              guard();
              const count = db.prepare('SELECT count(*) AS n FROM join_requests').get() as {
                n: number;
              };
              if (!Number.isSafeInteger(count.n) || count.n > 10000) throw fail('corrupt');
              return (
                db
                  .prepare(
                    'SELECT request_id,user_id,account,signer,body FROM join_requests ORDER BY request_id'
                  )
                  .all() as {
                  request_id: string;
                  user_id: string;
                  account: string;
                  signer: string;
                  body: string;
                }[]
              ).map(decodeStored);
            });
          })
        ),
    });
  });
}
