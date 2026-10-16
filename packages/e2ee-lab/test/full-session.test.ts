import Database from 'better-sqlite3';
import { makeLabProcessActor } from '../src/platform/process-actor';
import { exportDevice } from '../src/platform/device';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Deferred, Effect, Exit, Fiber, Result } from 'effect';
import { Bytes } from '@lody/e2ee-core';
import { issueWorkspaceInvitation } from '@lody/e2ee-core';
import { makeLabHostSession } from '../src/platform/host-session';
import { generateDevice } from '../src/platform/device';
import { makeSqliteProtectedEpochKeys } from '@lody/e2ee-core/internal';
import { signGenesisRecord } from '@lody/e2ee-core/protocol';
import { hashRecordBytes, verifyLedger } from '@lody/e2ee-core/protocol';
import { prepareJoinRequest } from '@lody/e2ee-core/protocol';
import { makeLabHttpIdentity } from '../src/platform/http-identity';
import { decodeRecord } from '@lody/e2ee-core/protocol';
import {
  signLedgerSnapshot,
  compareNotes,
  confirmIndependentComparison,
  type SnapshotTrust,
} from '@lody/e2ee-core/protocol';
import { labSyntheticProtector } from '../src/platform/synthetic-protection';
import { openLabExistingWorkspace } from '../src/platform/workspace-session';
import { expect, it } from 'vitest';
import { makeLabScenarioFixture } from '../src/platform/scenario-fixture';
import {
  openLabWorkspaceSession,
  reauthenticateLabWorkspaceSession,
} from '../src/platform/full-session';
it('closes native admission and joins an abort-ignoring control read before closing the actual workspace SQLite owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-facade-active-close-'));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* makeLabScenarioFixture(join(root, 'fixture')),
            entered = yield* Deferred.make<void>(),
            release = yield* Deferred.make<void>(),
            stopped = yield* Deferred.make<void>();
          let armed = false,
            feedClosed = false,
            closeDone = false;
          const config = { ...f.input('owner', 'create'), documents: [] };
          const actualClose = Database.prototype.close;
          Database.prototype.close = function () {
            if (this.name === config.path) feedClosed = true;
            return actualClose.call(this);
          };
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              Database.prototype.close = actualClose;
            })
          );
          const transport: typeof fetch = async (value, init) => {
            const outgoing = new Request(value, init),
              response = await fetch(outgoing);
            if (
              armed &&
              outgoing.method === 'GET' &&
              new URL(outgoing.url).pathname.endsWith('/control')
            ) {
              const bytes = await response.arrayBuffer();
              outgoing.signal.addEventListener(
                'abort',
                () => Deferred.doneUnsafe(stopped, Exit.void),
                { once: true }
              );
              Deferred.doneUnsafe(entered, Exit.void);
              await Effect.runPromise(Deferred.await(release));
              return new Response(bytes, { status: response.status, headers: response.headers });
            }
            return response;
          };
          const workspace = yield* openLabWorkspaceSession({ ...config, fetch: transport });
          yield* Effect.gen(function* () {
            armed = true;
            const reading = yield* Effect.result(workspace.refresh()).pipe(Effect.forkChild);
            yield* Deferred.await(entered);
            const closing = yield* workspace.close().pipe(Effect.forkChild);
            yield* Deferred.await(stopped);
            expect(feedClosed).toBe(false);
            expect(closeDone).toBe(false);
            const cancelled = yield* Fiber.interrupt(closing).pipe(Effect.forkChild),
              secondStarted = yield* Deferred.make<void>();
            const second = yield* Deferred.succeed(secondStarted, undefined).pipe(
              Effect.andThen(workspace.close()),
              Effect.tap(() =>
                Effect.sync(() => {
                  closeDone = true;
                })
              ),
              Effect.forkChild
            );
            yield* Deferred.await(secondStarted);
            expect(feedClosed).toBe(false);
            expect(closeDone).toBe(false);
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(second);
            yield* Fiber.join(cancelled);
            const result = yield* Fiber.await(reading);
            if (Exit.isSuccess(result)) expect(Result.isFailure(result.value)).toBe(true);
            expect(feedClosed).toBe(true);
            expect(closeDone).toBe(true);
          }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
        })
      )
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('creates through the public facade only after protected initial-key readback, publishes one original genesis and reopens the retained create intent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-facade-create-'));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const device = yield* generateDevice(),
            key = Result.getOrThrow(Bytes.epochKey(crypto.getRandomValues(new Uint8Array(32))));
          const generated = yield* signGenesisRecord({
            signer: device,
            encryptionPublicKey: device.enc,
            initialKey: key,
            membershipId: Result.getOrThrow(Bytes.membershipId(new Uint8Array(16).fill(215))),
            userId: Result.getOrThrow(Bytes.userId(new Uint8Array(32).fill(216))),
          });
          const point = { head: hashRecordBytes(generated.record), length: 1 },
            view = Result.getOrThrow(
              verifyLedger({
                anchor: generated.genesis,
                records: [generated.record],
                checkpoint: point,
              })
            );
          const host = yield* makeLabHostSession({
            directory: join(root, 'host'),
            mode: 'create',
            genesisRecord: generated.record,
            now: () => 0,
            resources: { loro: 'document-A', flock: 'document-B' },
            budget: { maxRecords: 100, maxBytes: 1024 * 1024 },
          });
          const file = (name: string) => join(root, `${name}.sqlite`),
            keysPath = file('protected');
          const keys = {
            path: file('receive'),
            mode: 'create' as const,
            pair: device.encryption,
            keyStore: { path: keysPath, mode: 'open' as const, protector: labSyntheticProtector },
            repairStore: { path: file('repair'), mode: 'create' as const },
            sendStore: { path: file('send'), mode: 'create' as const },
            outboxStore: { path: file('outbox'), mode: 'create' as const },
            currentPublication: () => Effect.succeed(new Uint8Array(generated.record)),
          };
          const config = {
            baseUrl: host.baseUrl,
            genesis: generated.genesis,
            signer: device,
            path: file('feed'),
            journalPath: file('journal'),
            mode: 'create' as const,
            checkpoint: () => Effect.succeed(point),
            budget: { maxRecords: 100, maxBytes: 1024 * 1024 },
            documents: [],
            keys,
            creation: {
              path: file('creation-request'),
              mode: 'create' as const,
              genesisRecord: generated.record,
            },
          };
          expect(Result.isFailure(yield* Effect.result(openLabWorkspaceSession(config)))).toBe(
            true
          );
          const absent = yield* Effect.promise(() =>
            fetch(
              `${host.nativeBaseUrl}/ds/${Buffer.from(generated.genesis.toBytes()).toString('hex')}/control`,
              { method: 'HEAD' }
            )
          );
          expect(absent.status).toBe(404);
          yield* Effect.promise(() => absent.body?.cancel() ?? Promise.resolve());
          yield* Effect.scoped(
            Effect.gen(function* () {
              const protectedKeys = yield* makeSqliteProtectedEpochKeys({
                path: keysPath,
                mode: 'create',
                genesis: generated.genesis,
                recipient: device.publicKey,
                ledger: () => Effect.succeed(view),
                protector: labSyntheticProtector,
              });
              yield* protectedKeys.saveAndReload(0, key);
            })
          );
          const workspace = yield* openLabWorkspaceSession(config);
          expect((yield* workspace.current()).view.head.equals(point.head)).toBe(true);
          yield* workspace.close();
          const reopened = yield* openLabWorkspaceSession({
            ...config,
            mode: 'open',
            expected: point,
            creation: { ...config.creation, mode: 'open' },
            keys: {
              ...keys,
              mode: 'open',
              repairStore: { ...keys.repairStore, mode: 'open' },
              sendStore: { ...keys.sendStore, mode: 'open' },
              outboxStore: { ...keys.outboxStore, mode: 'open' },
            },
          });
          expect((yield* reopened.current()).view.length).toBe(1);
          const stored = new Database(config.creation.path, { readonly: true });
          try {
            expect(stored.prepare('SELECT original,consumed FROM creation_request').get()).toEqual({
              original: Buffer.from(generated.record),
              consumed: 1,
            });
          } finally {
            stored.close();
          }
        })
      )
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('receives an inviter-pinned snapshot through the join mailbox, reopens its local origin and sees its own revocation without old-prefix replay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-invitation-first-'));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* makeLabScenarioFixture(join(root, 'fixture'), [
            { id: 'owner', role: 'owner' },
            { id: 'peer', role: 'owner', memberOf: 'owner' },
          ]);
          const ownerIdentity = yield* makeLabHttpIdentity({
            baseUrl: f.host.baseUrl,
            genesis: f.genesis,
          });
          const owner = yield* ownerIdentity.authenticate(f.owner);
          const peerIdentity = yield* makeLabHttpIdentity({
            baseUrl: f.host.baseUrl,
            genesis: f.genesis,
          });
          const peer = yield* peerIdentity.authenticate(f.peer, 'unbound');
          const request = yield* prepareJoinRequest({
            genesis: f.genesis,
            signer: f.peer,
            encryptionPublicKey: f.peer.enc,
            userId: Result.getOrThrow(Bytes.userId(new Uint8Array(32).fill(211))),
            requestId: Result.getOrThrow(Bytes.requestId(new Uint8Array(16).fill(212))),
            expiresAt: null,
          });
          yield* peer.submitJoin(request);
          const selected = yield* Effect.promise(() =>
            owner.fetch(
              `${f.host.baseUrl}/ds/${Buffer.from(f.genesis.toBytes()).toString('hex')}/control`,
              { method: 'HEAD' }
            )
          );
          const offset = selected.headers.get('stream-next-offset');
          yield* Effect.promise(() => selected.body?.cancel() ?? Promise.resolve());
          if (!selected.ok || !offset) throw new Error('native-origin');
          const issued = yield* issueWorkspaceInvitation({
            workspaceId: 'workspace-fixture',
            signer: f.owner,
            ledger: f.ledger,
            offset: () => Effect.succeed(offset),
            requestId: request.requestId,
            mailbox: owner.invitationMailbox,
          });
          const reads: string[] = [];
          const transport: typeof fetch = (value, init) => {
            const url = new URL(value instanceof Request ? value.url : String(value));
            if (url.pathname.endsWith('/control') && (init?.method ?? 'GET') === 'GET') {
              reads.push(url.searchParams.get('offset') ?? '');
              if (url.searchParams.get('offset') === '-1')
                return Promise.reject(new Error('old-prefix-not-used'));
            }
            return fetch(value, init);
          };
          const config = {
            ...f.input('peer', 'create'),
            fetch: transport,
            documents: [],
            invitation: {
              pin: issued.pin,
              requestId: request.requestId,
              path: join(root, 'invitation.sqlite'),
              mode: 'create' as const,
            },
          };
          const joined = yield* openLabWorkspaceSession(config);
          expect((yield* joined.current()).view.verification).toBe('endorsed-snapshot');
          yield* joined.close();
          const reopened = yield* openLabWorkspaceSession({
            ...config,
            mode: 'open',
            expected: f.point(),
            invitation: { ...config.invitation, mode: 'open' },
            keys: {
              ...config.keys,
              mode: 'open',
              keyStore: { ...config.keys.keyStore, mode: 'open' },
              repairStore: { ...config.keys.repairStore, mode: 'open' },
              sendStore: { ...config.keys.sendStore, mode: 'open' },
              outboxStore: { ...config.keys.outboxStore, mode: 'open' },
            },
          });
          expect((yield* reopened.current()).view.head.equals(f.point().head)).toBe(true);
          expect(reads).toEqual([offset, offset]);
          const honest = yield* openLabWorkspaceSession({
            ...f.input('owner', 'create'),
            documents: [],
          });
          const revoked = yield* honest.submit({ _tag: 'RevokeDevice', target: f.peer.publicKey });
          if (revoked.outcome !== 'Committed') throw new Error('revocation');
          yield* honest.acknowledge(revoked);
          const observed = yield* reopened.refresh();
          expect(
            observed.view
              .inspectState()
              .devices.has(Buffer.from(f.peer.publicKey.toBytes()).toString('hex'))
          ).toBe(false);
          expect(Result.isFailure(yield* Effect.result(reopened.keyRound()))).toBe(true);
          const disk = new Database(config.path, { readonly: true });
          try {
            expect(disk.prepare('SELECT COUNT(*) AS n FROM feed_records').get()).toEqual({
              n: 1,
            });
          } finally {
            disk.close();
          }
        })
      )
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('starts and reopens an authenticated workspace from an independently qualified snapshot without reading its old control prefix', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-workspace-snapshot-origin-'));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* makeLabScenarioFixture(join(root, 'fixture'));
          const signed = yield* signLedgerSnapshot({ signer: f.owner, ledger: f.ledger });
          const original = Result.getOrThrow(decodeRecord(f.records[0]!));
          if (original.body.type !== 'genesis') throw new Error('genuine genesis required');
          const trust: SnapshotTrust = {
            source: 'external-confirmation',
            genesis: f.genesis,
            head: f.point().head,
            length: f.point().length,
            endorser: f.owner.publicKey,
            membershipId: original.body.membershipId,
            role: 'owner',
            kind: 'personal',
            headSignature: signed.headSignature,
          };
          const selected = yield* Effect.tryPromise({
            try: () =>
              fetch(
                `${f.server.baseUrl}/ds/${Buffer.from(f.genesis.toBytes()).toString('hex')}/control`,
                { method: 'HEAD' }
              ),
            catch: (cause) => cause,
          });
          const offset = selected.headers.get('stream-next-offset');
          yield* Effect.promise(() => selected.body?.cancel() ?? Promise.resolve());
          if (!selected.ok || !offset) throw new Error('actual transport origin required');
          const requested: string[] = [];
          const transport: typeof fetch = (value, init) => {
            const url = new URL(value instanceof Request ? value.url : String(value));
            if (url.pathname.endsWith('/control') && (init?.method ?? 'GET') === 'GET') {
              requested.push(url.searchParams.get('offset') ?? '');
              if (url.searchParams.get('offset') === '-1')
                return Promise.reject(new Error('snapshot startup must not replay the old prefix'));
            }
            return fetch(value, init);
          };
          const config = {
            ...f.input('owner', 'create'),
            fetch: transport,
            snapshot: { bytes: signed.snapshot, trust, offset },
          };
          const first = yield* openLabExistingWorkspace(config);
          expect((yield* first.control.current()).view.head.equals(trust.head)).toBe(true);
          expect(requested).toEqual([offset]);
          yield* first.close();
          const reopened = yield* openLabExistingWorkspace({
            ...config,
            mode: 'open',
            expected: f.point(),
          });
          expect((yield* reopened.control.current()).offset).toBe(offset);
          expect(requested).toEqual([offset, offset]);
          const disk = new Database(config.path, { readonly: true });
          try {
            expect(disk.prepare('SELECT COUNT(*) AS n FROM feed_records').get()).toEqual({
              n: 0,
            });
          } finally {
            disk.close();
          }
        })
      )
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('exposes verified rotation state and drives a permitted required rotation through the facade', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-rotation-status-'));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* makeLabScenarioFixture(join(root, 'fixture'), [
            { id: 'owner', role: 'owner' },
            { id: 'admin', role: 'admin' },
            { id: 'member', role: 'member' },
            { id: 'machine', role: 'owner', memberOf: 'owner', kind: 'machine' },
            { id: 'recovery', role: 'owner', memberOf: 'owner', kind: 'recovery' },
            { id: 'retired', role: 'owner', memberOf: 'owner' },
          ]);
          const owner = yield* openLabWorkspaceSession({
            ...f.input('owner', 'create'),
            documents: [],
            epochRotation: {
              path: join(root, 'owner-candidates.sqlite'),
              mode: 'create',
              protector: labSyntheticProtector,
            },
          });
          expect(typeof owner.rotationStatus).toBe('function');
          const others = yield* Effect.forEach(['admin', 'member', 'machine', 'recovery'], (id) =>
            openLabWorkspaceSession({ ...f.input(id, 'create'), documents: [] })
          );
          const mayRotate = [true, false, false, false];
          expect(yield* owner.rotationStatus()).toEqual({
            rotationRequired: false,
            epoch: 0,
            mayRotate: true,
          });
          expect(yield* owner.rotateIfRequired()).toBeNull();
          const revoked = yield* owner.submit({
            _tag: 'RevokeDevice',
            target: f.devices.get('retired')!.publicKey,
          });
          yield* owner.acknowledge(revoked);
          expect(yield* owner.rotationStatus()).toEqual({
            rotationRequired: true,
            epoch: 0,
            mayRotate: true,
          });
          for (const [index, client] of others.entries()) {
            yield* client.refresh();
            expect(yield* client.rotationStatus()).toEqual({
              rotationRequired: true,
              epoch: 0,
              mayRotate: mayRotate[index],
            });
          }
          const before = f.records.length;
          expect(yield* others[1]!.rotateIfRequired()).toBeNull();
          expect(f.records.length).toBe(before);
          const rotated = yield* owner.rotateIfRequired();
          expect(rotated).toMatchObject({ outcome: 'Committed', epoch: 1 });
          expect(yield* owner.rotationStatus()).toEqual({
            rotationRequired: false,
            epoch: 1,
            mayRotate: true,
          });
          for (const [index, client] of others.entries()) {
            yield* client.refresh();
            expect(yield* client.rotationStatus()).toEqual({
              rotationRequired: false,
              epoch: 1,
              mayRotate: mayRotate[index],
            });
          }
          yield* owner.close();
          expect(yield* Effect.result(owner.rotationStatus())).toMatchObject({
            _tag: 'Failure',
            failure: { reason: 'closed' },
          });
        })
      )
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('publishes and installs real new epochs, distributes them, resumes current-epoch document writes and reopens retained candidates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-real-epoch-publisher-'));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* makeLabScenarioFixture(join(root, 'fixture'), [
            { id: 'owner', role: 'owner' },
            { id: 'peer', role: 'owner', memberOf: 'owner' },
            { id: 'retired', role: 'owner', memberOf: 'owner' },
          ]);
          const original = f.input('owner', 'create');
          const input = {
            ...original,
            epochRotation: {
              path: join(root, 'owner-candidates.sqlite'),
              mode: 'create' as const,
              protector: labSyntheticProtector,
            },
          };
          const owner = yield* openLabWorkspaceSession(input);
          const peer = yield* openLabWorkspaceSession(f.input('peer', 'create'));
          yield* owner.keyRound();
          yield* peer.keyRound();
          yield* owner.createDocument('loro');
          yield* owner.append('loro', 'epoch zero');
          yield* peer.pull('loro');

          const unused = yield* owner.submit({
            _tag: 'RevokeDevice',
            target: f.devices.get('retired')!.publicKey,
          });
          yield* owner.acknowledge(unused);
          const first = yield* owner.rotateEpoch();
          expect(first.outcome).toBe('Committed');
          expect(first.epoch).toBe(1);
          expect(first.binding).toBe('current');
          const publication = Result.getOrThrow(decodeRecord(first.record));
          expect(publication.body.type).toBe('ordinary');
          if (publication.body.type !== 'ordinary') throw new Error('ordinary publication');
          expect(publication.body.operation.type).toBe('publishEpoch');
          expect((yield* owner.resumeEpochRotation())?.record).toEqual(first.record);
          yield* owner.acknowledgeEpochRotation(first);
          yield* owner.keyRound();
          yield* peer.keyRound();
          yield* owner.append('loro', ' / epoch one');
          yield* peer.pull('loro');
          expect(yield* peer.text('loro')).toBe('epoch zero / epoch one');

          // A real device revocation requires a further publication before new
          // writes. The publisher clears that state through the existing E7.
          const revoked = yield* owner.submit({ _tag: 'RevokeDevice', target: f.peer.publicKey });
          yield* owner.acknowledge(revoked);
          expect((yield* owner.current()).view.inspectState().epoch.rotationRequired).toBe(true);
          const second = yield* owner.rotateEpoch();
          expect(second.epoch).toBe(2);
          expect(second.outcome).toBe('Committed');
          expect((yield* owner.current()).view.inspectState().epoch.rotationRequired).toBe(false);
          yield* owner.acknowledgeEpochRotation(second);
          yield* owner.append('loro', ' / epoch two');
          yield* owner.pull('loro');

          const reopened = yield* reauthenticateLabWorkspaceSession(owner, input, f.point());
          expect(yield* reopened.resumeEpochRotation()).toBeNull();
          expect(yield* reopened.text('loro')).toBe('epoch zero / epoch one / epoch two');
          expect(yield* reopened.cursor('loro')).not.toBeNull();
          const disk = new Database(input.epochRotation.path, { readonly: true });
          try {
            const rows = disk
              .prepare(
                'SELECT epoch,record,outcome,consumed FROM epoch_rotation_candidates ORDER BY epoch'
              )
              .all() as { epoch: number; record: Uint8Array; outcome: string; consumed: number }[];
            expect(rows.map((row) => [row.epoch, row.outcome, row.consumed])).toEqual([
              [1, 'Committed', 1],
              [2, 'Committed', 1],
            ]);
            expect(new Uint8Array(rows[0]!.record)).toEqual(first.record);
            expect(new Uint8Array(rows[1]!.record)).toEqual(second.record);
          } finally {
            disk.close();
          }
        })
      )
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('starts real admitted peers, installs HPKE keys/reports, syncs both SDK models and reauthenticates one common owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-full-session-'));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeLabScenarioFixture(join(root, 'fixture'));
          const originalInput = fixture.input('owner', 'create');
          const input = {
            ...originalInput,
            documents: originalInput.documents.map((doc) => ({ ...doc, snapshotUpload: true })),
          };
          const owner = yield* openLabWorkspaceSession(input);
          const peer = yield* openLabWorkspaceSession(fixture.input('peer', 'create'));
          yield* owner.keyRound();
          yield* peer.keyRound();
          yield* owner.createDocument('loro');
          yield* owner.createDocument('flock');
          yield* owner.append('loro', 'original loro');
          yield* owner.append('flock', 'original flock');
          yield* owner.uploadSnapshot('loro');
          yield* owner.uploadSnapshot('flock');
          yield* peer.pull('loro');
          yield* peer.pull('flock');
          expect(yield* peer.text('loro')).toBe('original loro');
          expect(yield* peer.text('flock')).toBe('original flock');
          const localNote = yield* owner.comparisonNote();
          const remoteNote = yield* peer.comparisonNote();
          expect(Result.getOrThrow(compareNotes(localNote, remoteNote))).toMatchObject({
            kind: 'agree',
            independent: false,
          });
          expect(
            Result.getOrThrow(
              confirmIndependentComparison(localNote, remoteNote, fixture.owner.publicKey, {
                source: 'authenticated-channel',
                expected: remoteNote,
              })
            )
          ).toMatchObject({ kind: 'agree', independent: true });
          expect(
            Result.isFailure(
              confirmIndependentComparison(localNote, remoteNote, fixture.owner.publicKey, {
                source: 'manual',
                expected: { ...remoteNote, length: remoteNote.length + 1 },
              })
            )
          ).toBe(true);
          expect(yield* peer.cursor('loro')).not.toBeNull();
          expect(yield* peer.cursor('flock')).not.toBeNull();
          yield* owner.persist('loro');
          const reopened = yield* reauthenticateLabWorkspaceSession(owner, input, fixture.point());
          expect(Result.isFailure(yield* Effect.result(owner.text('loro')))).toBe(true);
          expect(yield* reopened.text('loro')).toBe('original loro');
          expect(yield* reopened.text('flock')).toBe('original flock');
          yield* reopened.append('loro', ' after reauth');
          yield* peer.pull('loro');
          expect(yield* peer.text('loro')).toBe('original loro after reauth');
          yield* reopened.close();
          yield* reopened.close();
          expect(Result.isFailure(yield* Effect.result(reopened.keyRound()))).toBe(true);
          // One actor closes without EOF publication or closing another peer's stores.
          expect(yield* peer.text('flock')).toBe('original flock');
        })
      )
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('closes the two original Lab2 behaviors through the complete session: genuine records at wrong offsets cannot duplicate history or rewind the durable feed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lab2-full-consumer-'));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* makeLabScenarioFixture(join(root, 'fixture'));
          let attack: 'duplicate' | 'rollback' | undefined;
          const original = f.input('owner', 'create');
          const transport: typeof fetch = async (input, init) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            const response = await fetch(input, init);
            if (
              !attack ||
              url.pathname !== `/ds/${Buffer.from(f.genesis.toBytes()).toString('hex')}/control` ||
              (init?.method ?? 'GET') !== 'GET'
            )
              return response;
            const framing = await import('@lody/e2ee-core/protocol');
            const values = attack === 'duplicate' ? [f.records[1]!] : f.records;
            const bytes = Buffer.concat(
              values.map((record) =>
                Buffer.from(Result.getOrThrow(framing.frameLedgerRecord(record)))
              )
            );
            await response.body?.cancel();
            const headers = new Headers(response.headers);
            headers.set('content-type', 'application/octet-stream');
            const at = url.searchParams.get('offset') ?? '0';
            headers.set(
              'stream-next-offset',
              String(Number(at) + bytes.length).padStart(at.length, '0')
            );
            headers.set('stream-up-to-date', 'true');
            return new Response(bytes, { status: 200, headers });
          };
          const owner = yield* openLabWorkspaceSession({ ...original, fetch: transport });
          const peer = yield* openLabWorkspaceSession(f.input('peer', 'create'));
          const before = yield* owner.current();
          const persisted = () => {
            const db = new Database(original.path, { readonly: true, fileMustExist: true });
            try {
              return db.transaction(() => ({
                meta: db
                  .prepare(
                    'SELECT hex(genesis) AS genesis,hex(head) AS head,count,offset,bootstrap,bytes FROM feed_meta'
                  )
                  .all(),
                records: db
                  .prepare(
                    'SELECT position,hex(record) AS record FROM feed_records ORDER BY position'
                  )
                  .all(),
              }))();
            } finally {
              db.close();
            }
          };
          const originalDisk = persisted(),
            device = yield* exportDevice(f.owner);
          for (const kind of ['duplicate', 'rollback'] as const) {
            attack = kind;
            const failed = yield* Effect.result(owner.refresh());
            expect(Result.isFailure(failed)).toBe(true);
            const after = yield* owner.current();
            expect(after.offset).toBe(before.offset);
            expect(after.view.head.equals(before.view.head)).toBe(true);
            expect(after.view.length).toBe(before.view.length);
            expect((yield* peer.refresh()).view.head.equals(before.view.head)).toBe(true);
            expect(persisted()).toEqual(originalDisk);
            const os = yield* makeLabProcessActor((mode) =>
              Effect.succeed({
                syntheticOnly: true,
                device,
                targets: Object.fromEntries(
                  [...f.devices].map(([id, native]) => [
                    id,
                    {
                      signingKey: Buffer.from(native.publicKey.toBytes()).toString('hex'),
                      membership: Buffer.from(f.memberships.get(id)!.toBytes()).toString('hex'),
                    },
                  ])
                ),
                initialKeyOwner: true,
                baseUrl: f.host.baseUrl,
                directory: f.directory,
                actor: 'owner',
                mode,
                genesis: Buffer.from(f.genesis.toBytes()).toString('hex'),
                records: f.records.map((record) => Buffer.from(record).toString('hex')),
                point: {
                  head: Buffer.from(f.point().head.toBytes()).toString('hex'),
                  length: f.point().length,
                },
              })
            );
            expect((yield* os.start('open')).ok).toBe(true);
            expect((yield* os.call('refresh')).value).toEqual({
              head: Buffer.from(before.view.head.toBytes()).toString('hex'),
              length: before.view.length,
            });
            yield* os.shutdown();
            expect(persisted()).toEqual(originalDisk);
          }
          attack = undefined;
          expect((yield* owner.refresh()).offset).toBe(before.offset);
        })
      )
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('durably retries an unadmitted join original after a lost receipt, then starts key/content only after genuine admission', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-join-complete-'));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { openLabJoinSession } = yield* Effect.promise(
            () => import('../src/platform/join-session')
          );
          const f = yield* makeLabScenarioFixture(join(root, 'fixture')),
            device = yield* generateDevice();
          let drop = true;
          const transport: typeof fetch = async (input, init) => {
            const request = new Request(input, init);
            const response = await fetch(request);
            if (
              drop &&
              request.method === 'POST' &&
              request.url.endsWith('/joins') &&
              response.ok
            ) {
              drop = false;
              await response.body?.cancel();
              throw new Error('lost-join-receipt');
            }
            return response;
          };
          const joinInput = {
            path: join(f.directory, 'pending-join.sqlite'),
            baseUrl: f.host.baseUrl,
            genesis: f.genesis,
            signer: device,
            encryptionPublicKey: device.enc,
            requestId: Result.getOrThrow(Bytes.requestId(new Uint8Array(16).fill(123))),
            userId: Result.getOrThrow(Bytes.userId(new Uint8Array(32).fill(124))),
            expiresAt: null,
            fetch: transport,
          };
          const joining = yield* openLabJoinSession({ ...joinInput, mode: 'create' });
          const original = joining.original();
          expect(Result.isFailure(yield* Effect.result(joining.submit()))).toBe(true);
          const keyRequest = yield* Effect.promise(() =>
            joining.discovery.fetch(joining.discovery.url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ op: 'fetch', epoch: 0, cursor: null, limit: 100 }),
            })
          );
          expect(keyRequest.status).toBe(403);
          yield* Effect.promise(() => keyRequest.body?.cancel() ?? Promise.resolve());
          const reopened = yield* openLabJoinSession({ ...joinInput, mode: 'open' });
          expect(reopened.original()).toEqual(original);
          const submitted = yield* reopened.submit();
          const owner = yield* openLabWorkspaceSession({
            ...f.input('owner', 'create'),
            epochRotation: {
              path: join(f.directory, 'removal-candidates.sqlite'),
              mode: 'create',
              protector: labSyntheticProtector,
            },
          });
          const requests = yield* owner.listJoins();
          expect(requests).toHaveLength(1);
          expect(requests[0]!.requestId.equals(submitted.requestId)).toBe(true);
          const result = yield* owner.approveJoin(
            submitted,
            Result.getOrThrow(Bytes.membershipId(new Uint8Array(16).fill(125)))
          );
          expect(result.outcome).toBe('Committed');
          yield* owner.acknowledge(result);
          yield* owner.keyRound();
          yield* owner.createDocument('loro');
          yield* owner.append('loro', 'only admitted readers');
          const base = f.input('peer', 'create'),
            file = (name: string) => join(f.directory, `joiner-${name}.sqlite`);
          const session = yield* openLabWorkspaceSession({
            ...base,
            signer: device,
            path: file('feed'),
            journalPath: file('journal'),
            keys: {
              ...base.keys,
              pair: device.encryption,
              path: file('receive'),
              keyStore: { ...base.keys.keyStore, path: file('keys') },
              repairStore: { ...base.keys.repairStore, path: file('repair') },
              sendStore: { ...base.keys.sendStore, path: file('send') },
              outboxStore: { ...base.keys.outboxStore, path: file('outbox') },
            },
            documents: base.documents.map((doc) => ({ ...doc, path: file(doc.id) })),
          });
          yield* session.keyRound();
          yield* session.pull('loro');
          expect(yield* session.text('loro')).toBe('only admitted readers');
          const before = f.records.length;
          const removal = yield* owner.removeMemberAndRotate(
            Result.getOrThrow(Bytes.membershipId(new Uint8Array(16).fill(125)))
          );
          expect(removal.outcome).toBe('Committed');
          expect(removal.epoch).toBe(1);
          expect(f.records).toHaveLength(before + 1);
          const removedRecord = Result.getOrThrow(decodeRecord(removal.record));
          expect(removedRecord.body.type === 'ordinary' && removedRecord.body.operation.type).toBe(
            'removeMemberAndPublishEpoch'
          );
          expect(
            f
              .view()
              .inspectState()
              .devices.has(Buffer.from(device.publicKey.toBytes()).toString('hex'))
          ).toBe(false);
          expect(f.view().inspectState().epoch.rotationRequired).toBe(false);
          yield* owner.acknowledgeEpochRotation(removal);
          yield* owner.keyRound();
          yield* owner.append('loro', ' / after removal');
          const removedView = yield* session.refresh();
          expect(
            removedView.view
              .inspectState()
              .devices.has(Buffer.from(device.publicKey.toBytes()).toString('hex'))
          ).toBe(false);
          expect(yield* session.text('loro')).toBe('only admitted readers');
          expect(Result.isFailure(yield* Effect.result(session.pull('loro')))).toBe(true);
          expect(yield* session.documentStatus('loro')).toBe('active');
          expect(Result.isFailure(yield* Effect.result(session.keyRound()))).toBe(true);
          const stored = new Database(file('keys'), { readonly: true });
          try {
            expect(
              stored.prepare('SELECT epoch FROM installed_epoch_keys ORDER BY epoch').all()
            ).toEqual([{ epoch: 0 }]);
          } finally {
            stored.close();
          }
        })
      )
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('revalidates changed signed fixture originals before reusing synthetic authority', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-fixture-originals-'));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeLabScenarioFixture(join(root, 'fixture'));
          const before = fixture.view();
          const record = fixture.records[0]!;
          const original = new Uint8Array(record);
          record[record.length - 1] = record[record.length - 1]! ^ 1;
          expect(() => fixture.view()).toThrow();
          record.set(original);
          expect(fixture.view().inspectState()).toEqual(before.inspectState());
        })
      )
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('continues blocked repair pages, retries a lost HTTP ACK after reopen and explicitly frees sender capacity without deleting originals', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-key-results-'));
  const rows = (file: string, table: string) => {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[];
    } finally {
      db.close();
    }
  };
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* makeLabScenarioFixture(join(root, 'fixture'));
          const ownerInput = f.input('owner', 'create');
          const owner = yield* openLabWorkspaceSession({
            ...ownerInput,
            documents: [],
            keys: {
              ...ownerInput.keys,
              sendStore: { ...ownerInput.keys.sendStore, maxTasks: 1 },
            },
          });
          let drop = true;
          const repairTransport: typeof fetch = async (input, init) => {
            const request = new Request(input, init);
            const body =
              request.method === 'POST' && request.url.endsWith('/key-mailbox')
                ? ((await request.clone().json()) as { op: string })
                : undefined;
            const response = await fetch(request);
            if (drop && body?.op === 'repair' && response.ok) {
              drop = false;
              await response.body?.cancel();
              throw new Error('lost-committed-repair-ack');
            }
            return response;
          };
          const peerInput = { ...f.input('peer', 'create'), documents: [], fetch: repairTransport };
          const peer = yield* openLabWorkspaceSession(peerInput);
          const sent = yield* owner.keyRound(1);
          expect(sent.deliveryResults.items).toHaveLength(1);
          const firstDelivery = sent.deliveryResults.items[0]!;
          expect(firstDelivery.outcome).toBe('Observed');
          yield* peer.keyRound(1);
          const originalOutbox = rows(ownerInput.keys.outboxStore.path, 'epoch_delivery');
          const installed = rows(peerInput.keys.keyStore.path, 'installed_epoch_keys');
          expect(installed).toHaveLength(1);
          yield* peer.enqueueRepair('000-blocked', 'ff'.repeat(32));
          yield* peer.enqueueRepair('001-lost');
          yield* peer.enqueueRepair('002-next');
          const first = yield* peer.keyRound(1);
          expect(first.repairs).toEqual({
            processed: 1,
            blocked: ['000-blocked'],
            next: '000-blocked',
          });
          const lost = yield* peer.keyRound(1, { repairs: first.repairs.next });
          expect(lost.repairs).toEqual({ processed: 1, blocked: ['001-lost'], next: '001-lost' });
          expect(rows(join(f.directory, 'mailbox.sqlite'), 'mailbox_repairs')).toHaveLength(1);
          const pending = rows(peerInput.keys.repairStore.path, 'repair_tasks');
          expect(pending.find((row) => row.id === '001-lost')?.phase).toBe('Pending');
          const reopened = yield* reauthenticateLabWorkspaceSession(peer, peerInput, f.point());
          const retried = yield* reopened.keyRound(1, { repairs: first.repairs.next });
          expect(retried.repairs).toEqual({ processed: 1, blocked: [], next: '001-lost' });
          expect(rows(join(f.directory, 'mailbox.sqlite'), 'mailbox_repairs')).toHaveLength(1);
          const next = yield* reopened.keyRound(1, { repairs: retried.repairs.next });
          expect(next.repairs).toEqual({ processed: 1, blocked: [], next: null });
          const remoteRepairs = rows(join(f.directory, 'mailbox.sqlite'), 'mailbox_repairs');
          expect(remoteRepairs.map((row) => row.id)).toEqual(['001-lost', '002-next']);
          const results = yield* reopened.repairResults(1);
          expect(results.items).toEqual([{ id: '001-lost', outcome: 'Repaired' }]);
          expect(results.next).toBe('001-lost');
          expect((yield* reopened.repairResults(1, results.next)).items).toEqual([
            { id: '002-next', outcome: 'Repaired' },
          ]);
          const blocked = yield* owner.keyRound(1);
          expect(blocked.reconciliation.scheduled).toBe(0);
          expect(blocked.reconciliation.blocked).toEqual([
            Buffer.from(f.peer.publicKey.toBytes()).toString('hex'),
          ]);
          expect((yield* owner.deliveryResults()).items).toEqual([firstDelivery]);
          yield* owner.acknowledgeDelivery(firstDelivery.id);
          expect((yield* owner.deliveryResults()).items).toEqual([]);
          const resent = yield* owner.keyRound(1);
          expect(resent.reconciliation.scheduled).toBe(1);
          expect(resent.deliveryResults.items[0]!.revision).toBe(2);
          expect(rows(ownerInput.keys.sendStore.path, 'distribution_tasks')).toHaveLength(2);
          expect(rows(ownerInput.keys.outboxStore.path, 'epoch_delivery')).toEqual(originalOutbox);
          const received = yield* reopened.keyRound(1);
          expect(received.results.length).toBeGreaterThan(0);
          for (const result of yield* reopened.receiveResults())
            yield* reopened.acknowledgeReceive(result.id);
          yield* reopened.acknowledgeRepair('001-lost');
          yield* reopened.acknowledgeRepair('002-next');
          expect((yield* reopened.repairResults()).items).toEqual([]);
          expect(yield* reopened.receiveResults()).toEqual([]);
          expect(rows(peerInput.keys.repairStore.path, 'repair_tasks')).toEqual([
            pending[0],
            { ...pending[1], phase: 'Repaired', consumed: 1 },
            { ...pending[2], phase: 'Repaired', consumed: 1 },
          ]);
          expect(rows(peerInput.keys.keyStore.path, 'installed_epoch_keys')).toEqual(installed);
          expect(rows(join(f.directory, 'mailbox.sqlite'), 'mailbox_repairs')).toEqual(
            remoteRepairs
          );
          const receiveHistory = rows(peerInput.keys.path, 'receive_tasks');
          expect(receiveHistory.every((row) => row.frame !== null && row.report !== null)).toBe(
            true
          );
          yield* reopened.close();
          expect(Result.isFailure(yield* Effect.result(reopened.enqueueRepair('closed')))).toBe(
            true
          );
          expect(
            Result.isFailure(yield* Effect.result(reopened.acknowledgeRepair('001-lost')))
          ).toBe(true);
        })
      )
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
