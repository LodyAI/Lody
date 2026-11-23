import { openSqliteStore } from '@lody/e2ee-core/internal';
import { isAbsolute } from 'node:path';
import { Effect, Result } from 'effect';
import { Bytes } from '@lody/e2ee-core';
import { LedgerFeedError } from '@lody/e2ee-core';
import {
  verifyWorkspaceInvitationSnapshot,
  type WorkspaceInvitation,
  type WorkspaceInvitationMailbox,
} from '@lody/e2ee-core';
import { invitationSnapshotWire, parseInvitationSnapshot } from './invitation-wire';
/** Native persistence of an independently imported invitation and its exact signed
 * receipt. Caller still supplies the imported pin; SQL can never switch endorsers.
 * Reopen requalifies the stored snapshot and verifies only its retained suffix. */
export const makeLabInvitationOrigin = Effect.fnUntraced(function* (input: {
  path: string;
  mode: 'create' | 'open';
  pin: WorkspaceInvitation;
  requestId: Bytes.RequestId;
  mailbox: WorkspaceInvitationMailbox;
}) {
  const pin = {
    workspaceId: input.pin.workspaceId,
    genesis: Result.getOrThrow(Bytes.genesisHash(input.pin.genesis.toBytes())),
    endorser: Result.getOrThrow(Bytes.signingPublicKey(input.pin.endorser.toBytes())),
  };
  const encodedPin = JSON.stringify({
    workspaceId: pin.workspaceId,
    genesis: Buffer.from(pin.genesis.toBytes()).toString('hex'),
    endorser: Buffer.from(pin.endorser.toBytes()).toString('hex'),
  });
  const sql = <A>(work: () => A) =>
    Effect.try({ try: work, catch: () => new LedgerFeedError({ code: 'corrupt' }) });
  if (!isAbsolute(input.path) || !['create', 'open'].includes(input.mode))
    return yield* new LedgerFeedError({ code: 'invalid-frame' });
  const db = yield* openSqliteStore({
    path: input.path,
    mode: input.mode,
    applicationId: 1279609417,
    version: 1,
    error: () => new LedgerFeedError({ code: 'corrupt' }),
    initialize: (connection) =>
      connection.exec(
        'CREATE TABLE invitation(id INTEGER PRIMARY KEY CHECK(id=1),pin TEXT NOT NULL,body TEXT NOT NULL) STRICT;'
      ),
  });
  if (input.mode === 'create') {
    const receipt = yield* input.mailbox.read(input.requestId);
    if (!receipt) return yield* new LedgerFeedError({ code: 'invalid-frame' });
    yield* Effect.fromResult(verifyWorkspaceInvitationSnapshot(pin, receipt));
    const body = JSON.stringify(invitationSnapshotWire(receipt));
    yield* sql(() =>
      db
        .transaction(() => {
          db.prepare('INSERT INTO invitation(id,pin,body) VALUES(1,?,?)').run(encodedPin, body);
          const saved = db.prepare('SELECT pin,body FROM invitation WHERE id=1').get() as
            | { pin: string; body: string }
            | undefined;
          if (saved?.pin !== encodedPin || saved.body !== body) throw new Error('readback');
        })
        .immediate()
    );
  }
  const saved = yield* sql(() => {
    return db.prepare('SELECT pin,body FROM invitation WHERE id=1').get() as
      | { pin: string; body: string }
      | undefined;
  });
  if (!saved || saved.pin !== encodedPin)
    return yield* new LedgerFeedError({ code: 'wrong-parent' });
  const receipt = yield* Effect.fromResult(
    parseInvitationSnapshot(yield* sql(() => JSON.parse(saved.body)))
  );
  return yield* Effect.fromResult(verifyWorkspaceInvitationSnapshot(pin, receipt));
});
