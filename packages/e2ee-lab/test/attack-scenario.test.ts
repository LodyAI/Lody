import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Deferred, Effect, Exit, Fiber, Result, Scope } from 'effect';
import { StreamsClient } from '@loro-dev/streams-client';
import { Bytes } from '@lody/e2ee-core';
import { inspectContentFrame, type ContentScope } from '@lody/e2ee-core/protocol';
import { scopedDocumentKey, sealDocument, openDocument } from '@lody/e2ee-core/protocol';
import { prepareJoinRequest, prepareLedgerCommand } from '@lody/e2ee-core/protocol';
import { signLedgerRecord } from '@lody/e2ee-core/protocol';
import { hashRecordBytes } from '@lody/e2ee-core/protocol';
import { frameLedgerRecord } from '@lody/e2ee-core/protocol';
import { compareNotes, confirmIndependentComparison } from '@lody/e2ee-core/protocol';
import { expect, it } from 'vitest';
import {
  makeLabAttackTransport,
  runLabAttackPlan,
  type LabAttackPlanAction,
} from '../src/platform/attack-transport';
import { makeLabAttackObserver } from '../src/platform/attack-observer';
import { makeLabContentTrace } from '../src/platform/content-trace';
import { makeLabScenarioFixture } from '../src/platform/scenario-fixture';
import { generateDevice } from '../src/platform/device';
import { openLabWorkspaceSession } from '../src/platform/full-session';
import { labSyntheticProtector } from '../src/platform/synthetic-protection';
import { replayLabCapturedReads } from '../src/platform/repro-pack';
import { minimizeCounterexample } from '../src/pure/minimize';
import { makeLabLedgerClient } from '../src/platform/ledger-client';
import { applyLabStorageMutation } from '../src/platform/storage-attack';
import type { FailureFingerprint } from '../src/pure/fingerprint';
const ok = Result.getOrThrow;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

it('runs JSON native storage attacks with exact Org/stream scope, rejects changed signed control and restores original reads', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-attack-native-storage-'));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* makeLabScenarioFixture(join(root, 'fixture'), [
              { id: 'owner', role: 'owner' },
              { id: 'peer', role: 'member' },
            ]),
            org = hex(f.genesis.toBytes()),
            foreign = 'ed'.repeat(32);
          const transport = yield* makeLabAttackTransport({
            origin: f.server.baseUrl,
            genesis: f.genesis,
          });
          const controlSdk = new StreamsClient({
            url: `${f.server.baseUrl}/ds/${org}/control`,
            retry: { maxAttempts: 1 },
          });
          const client = yield* makeLabLedgerClient({
            path: join(root, 'verified-control.sqlite'),
            mode: 'create',
            genesis: f.genesis,
            genesisRecord: f.records[0]!,
            expected: { head: hashRecordBytes(f.records[0]!), length: 1 },
            budget: { maxRecords: 100, maxBytes: 1024 * 1024 },
            stream: controlSdk,
          });
          const accepted = yield* client.read(f.point());
          const original = yield* signLedgerRecord(
            ok(
              prepareLedgerCommand(f.view(), f.owner.publicKey, {
                _tag: 'SetRole',
                membershipId: f.memberships.get('peer')!,
                role: 'guest',
              })
            ),
            f.owner
          );
          expect(
            (yield* Effect.promise(() =>
              controlSdk.append({
                part: {
                  contentType: 'application/octet-stream',
                  body: ok(frameLedgerRecord(original)),
                },
              })
            )).ok
          ).toBe(true);
          f.records.push(new Uint8Array(original)); // The independent fixture witnessed this signed append.
          const content: {
            org: string;
            model: 'loro' | 'flock';
            sdk: StreamsClient;
            offset: string;
            tail: Uint8Array;
            snapshot: Uint8Array;
          }[] = [];
          const foreignBucket = yield* Effect.promise(() =>
            fetch(`${f.server.baseUrl}/ds/${foreign}`, { method: 'PUT' })
          );
          expect(foreignBucket.status).toBe(201);
          yield* Effect.promise(() => foreignBucket.body?.cancel() ?? Promise.resolve());
          for (const [bucket, model] of [
            [org, 'loro'],
            [org, 'flock'],
            [foreign, 'loro'],
          ] as const) {
            const url = `${f.server.baseUrl}/ds/${bucket}/${model}`,
              sdk = new StreamsClient({ url, retry: { maxAttempts: 1 } });
            expect(
              (yield* Effect.promise(() => sdk.create({ contentType: 'application/octet-stream' })))
                .ok
            ).toBe(true);
            const first = yield* Effect.promise(() =>
              sdk.append({
                part: {
                  contentType: 'application/octet-stream',
                  body: new TextEncoder().encode(`${bucket}-${model}-before`),
                },
              })
            );
            if (!first.ok) throw new Error('native content append');
            const offset = first.result.nextOffset,
              snapshot = new TextEncoder().encode(`${bucket}-${model}-snapshot`),
              tail = new TextEncoder().encode(`${bucket}-${model}-after`);
            const published = yield* Effect.promise(() =>
              fetch(`${url}/snapshot/${offset}`, {
                method: 'PUT',
                headers: { 'content-type': 'application/octet-stream' },
                body: snapshot,
              })
            );
            expect(published.status).toBe(204);
            yield* Effect.promise(() => published.body?.cancel() ?? Promise.resolve());
            expect(
              (yield* Effect.promise(() =>
                sdk.append({ part: { contentType: 'application/octet-stream', body: tail } })
              )).ok
            ).toBe(true);
            content.push({ org: bucket, model, sdk, offset, tail, snapshot });
          }
          const db = yield* Effect.acquireRelease(
            Effect.sync(() => new Database(f.server.dbPath, { fileMustExist: true })),
            (value) => Effect.sync(() => value.close())
          );
          const inventory = (table: 'entries' | 'snapshots') =>
            db
              .prepare(
                `SELECT p.* FROM "${table}" p JOIN streams s ON p.stream_id_fk=s.id ORDER BY p.id`
              )
              .all() as Record<string, unknown>[];
          const entries = inventory('entries'),
            snapshots = inventory('snapshots');
          const target = (
            db
              .prepare('SELECT id FROM streams WHERE bucket_id=? AND stream_id=?')
              .get(org, 'loro') as { id: number }
          ).id;
          const controlTarget = (
            db
              .prepare('SELECT id FROM streams WHERE bucket_id=? AND stream_id=?')
              .get(org, 'control') as { id: number }
          ).id;
          const restore = (table: 'entries' | 'snapshots', rows: Record<string, unknown>[]) =>
            db
              .transaction(() => {
                for (const row of rows.filter((entry) => entry.stream_id_fk === target)) {
                  const columns = Object.keys(row);
                  db.prepare(
                    `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`
                  ).run(...columns.map((column) => row[column]));
                }
              })
              .immediate();
          // The action plan is ordinary finite JSON. Each step invokes the same
          // native mutation capability used by storage actions, then real readers.
          const actions = JSON.parse(
            JSON.stringify([
              { kind: 'step', name: 'flip-control' },
              { kind: 'step', name: 'reject-control' },
              { kind: 'step', name: 'restore-control' },
              { kind: 'step', name: 'accept-control' },
              { kind: 'step', name: 'delete-content-entries' },
              { kind: 'step', name: 'delete-content-snapshots' },
              { kind: 'step', name: 'assert-content-scope' },
              { kind: 'step', name: 'restore-content' },
              { kind: 'step', name: 'read-original-content' },
            ])
          ) as LabAttackPlanAction[];
          const mutate = (
            kind: 'flip-blob' | 'delete-rows',
            table: 'entries' | 'snapshots',
            stream: 'control' | 'loro'
          ) =>
            applyLabStorageMutation(
              f.server.dbPath,
              { kind, table, column: 'body', stream },
              f.genesis
            ).pipe(Effect.asVoid);
          yield* runLabAttackPlan<unknown, never>({
            transport,
            actions,
            steps: {
              'flip-control': mutate('flip-blob', 'entries', 'control'),
              'reject-control': Effect.gen(function* () {
                expect(inventory('entries')).toEqual(
                  entries.map((row) => {
                    if (row.stream_id_fk !== controlTarget) return row;
                    const body = Buffer.from(row.body as Uint8Array);
                    body[body.length - 1] = body[body.length - 1]! ^ 1;
                    return { ...row, body };
                  })
                );
                const refused = yield* Effect.result(client.read(f.point()));
                expect(Result.isFailure(refused)).toBe(true);
                if (Result.isFailure(refused))
                  expect(refused.failure).toMatchObject({
                    _tag: 'LedgerFeedError',
                    code: 'wrong-parent',
                  });
                const retained = yield* client.current();
                expect(retained.offset).toBe(accepted.offset);
                expect(retained.view.head.equals(accepted.view.head)).toBe(true);
                expect(inventory('snapshots')).toEqual(snapshots);
                expect(inventory('entries').filter((row) => row.stream_id_fk === target)).toEqual(
                  entries.filter((row) => row.stream_id_fk === target)
                );
              }),
              'restore-control': mutate('flip-blob', 'entries', 'control'),
              'accept-control': Effect.gen(function* () {
                expect(
                  (yield* client.read(f.point())).view.head.equals(hashRecordBytes(original))
                ).toBe(true);
                expect(inventory('entries')).toEqual(entries);
              }),
              'delete-content-entries': mutate('delete-rows', 'entries', 'loro'),
              'delete-content-snapshots': mutate('delete-rows', 'snapshots', 'loro'),
              'assert-content-scope': Effect.sync(() => {
                expect(inventory('entries')).toEqual(
                  entries.filter((row) => row.stream_id_fk !== target)
                );
                expect(inventory('snapshots')).toEqual(
                  snapshots.filter((row) => row.stream_id_fk !== target)
                );
              }),
              'restore-content': Effect.sync(() => {
                restore('entries', entries);
                restore('snapshots', snapshots);
              }),
              'read-original-content': Effect.gen(function* () {
                expect(inventory('entries')).toEqual(entries);
                expect(inventory('snapshots')).toEqual(snapshots);
                for (const row of content) {
                  const read = yield* Effect.promise(() => row.sdk.read({ offset: row.offset }));
                  expect(read.ok).toBe(true);
                  if (!read.ok) throw new Error('restored native content read');
                  expect(new Uint8Array(read.result.payload.body)).toEqual(row.tail);
                  const snapshot = yield* Effect.promise(async () => {
                    const response = await fetch(
                      `${f.server.baseUrl}/ds/${row.org}/${row.model}/snapshot/${row.offset}`
                    );
                    return {
                      status: response.status,
                      body: new Uint8Array(await response.arrayBuffer()),
                    };
                  });
                  expect(snapshot).toEqual({ status: 200, body: row.snapshot });
                }
              }),
            },
          });
        })
      )
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('limits native deny/restore triggers to the selected stream and fails typed without partial or ignored mutations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-attack-storage-scope-'));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* makeLabScenarioFixture(join(root, 'fixture')),
            org = hex(f.genesis.toBytes()),
            foreign = 'ec'.repeat(32);
          const db = yield* Effect.acquireRelease(
            Effect.sync(() => new Database(f.server.dbPath)),
            (value) => Effect.sync(() => value.close())
          );
          const create = (bucket: string, model: string) =>
            Effect.promise(async () => {
              const response = await fetch(`${f.server.baseUrl}/ds/${bucket}`, { method: 'PUT' });
              await response.body?.cancel();
              const sdk = new StreamsClient({
                url: `${f.server.baseUrl}/ds/${bucket}/${model}`,
                retry: { maxAttempts: 1 },
              });
              expect((await sdk.create({ contentType: 'application/octet-stream' })).ok).toBe(true);
              const appended = await sdk.append({
                part: { contentType: 'application/octet-stream', body: new Uint8Array([1, 2, 3]) },
              });
              if (!appended.ok) throw new Error('native trigger fixture append');
              const snapshot = await fetch(
                `${f.server.baseUrl}/ds/${bucket}/${model}/snapshot/${appended.result.nextOffset}`,
                {
                  method: 'PUT',
                  headers: { 'content-type': 'application/octet-stream' },
                  body: new Uint8Array([4, 5, 6]),
                }
              );
              expect(snapshot.status).toBe(204);
              await snapshot.body?.cancel();
            });
          yield* create(org, 'loro');
          yield* create(org, 'flock');
          yield* create(foreign, 'loro');
          const target = (
            db
              .prepare('SELECT id FROM streams WHERE bucket_id=? AND stream_id=?')
              .get(org, 'loro') as { id: number }
          ).id;
          const other = (
            db
              .prepare('SELECT id FROM streams WHERE bucket_id=? AND stream_id=?')
              .get(foreign, 'loro') as { id: number }
          ).id;
          for (const table of ['entries', 'snapshots'] as const) {
            const before = db.prepare(`SELECT * FROM "${table}" ORDER BY id`).all() as Record<
              string,
              unknown
            >[];
            yield* applyLabStorageMutation(
              f.server.dbPath,
              { kind: 'flip-blob', table, column: 'body', stream: 'loro' },
              f.genesis
            );
            expect(db.prepare(`SELECT * FROM "${table}" ORDER BY id`).all()).toEqual(
              before.map((row) => {
                if (row.stream_id_fk !== target) return row;
                const body = Buffer.from(row.body as Uint8Array);
                body[body.length - 1] = body[body.length - 1]! ^ 1;
                return { ...row, body };
              })
            );
            yield* applyLabStorageMutation(
              f.server.dbPath,
              { kind: 'flip-blob', table, column: 'body', stream: 'loro' },
              f.genesis
            );
            expect(db.prepare(`SELECT * FROM "${table}" ORDER BY id`).all()).toEqual(before);
            yield* applyLabStorageMutation(
              f.server.dbPath,
              { kind: 'deny-writes', table, stream: 'loro' },
              f.genesis
            );
            expect(() =>
              db.prepare(`UPDATE "${table}" SET body=body WHERE stream_id_fk=?`).run(target)
            ).toThrow('Lab storage attack');
            expect(() =>
              db.prepare(`DELETE FROM "${table}" WHERE stream_id_fk=?`).run(target)
            ).toThrow('Lab storage attack');
            expect(() =>
              db
                .prepare(`UPDATE "${table}" SET stream_id_fk=? WHERE stream_id_fk=?`)
                .run(target, other)
            ).toThrow('Lab storage attack');
            const row = db
              .prepare(`SELECT * FROM "${table}" WHERE stream_id_fk=? LIMIT 1`)
              .get(target) as Record<string, unknown>;
            const columns = Object.keys(row).filter((column) => column !== 'id');
            expect(() =>
              db
                .prepare(
                  `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`
                )
                .run(...columns.map((column) => row[column]))
            ).toThrow('Lab storage attack');
            expect(
              db.prepare(`UPDATE "${table}" SET body=body WHERE stream_id_fk<>?`).run(target)
                .changes
            ).toBeGreaterThan(0);
            // Restoring a different stream cannot remove the target's denial.
            yield* applyLabStorageMutation(
              f.server.dbPath,
              { kind: 'restore-writes', table, stream: 'flock' },
              f.genesis
            );
            expect(() =>
              db.prepare(`UPDATE "${table}" SET body=body WHERE stream_id_fk=?`).run(target)
            ).toThrow('Lab storage attack');
            yield* applyLabStorageMutation(
              f.server.dbPath,
              { kind: 'restore-writes', table, stream: 'loro' },
              f.genesis
            );
            expect(
              db.prepare(`UPDATE "${table}" SET body=body WHERE stream_id_fk=?`).run(target).changes
            ).toBeGreaterThan(0);
            expect(db.prepare(`SELECT * FROM "${table}" ORDER BY id`).all()).toEqual(before);
          }
          const refusal = (result: Result.Result<unknown, unknown>, code: string) => {
            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result))
              expect(result.failure).toMatchObject({ _tag: 'LabStorageAttackError', code });
          };
          refusal(
            yield* Effect.result(
              applyLabStorageMutation(
                f.server.dbPath,
                { kind: 'delete-rows', table: 'streams', stream: 'loro' },
                f.genesis
              )
            ),
            'unsupported-stream-table'
          );
          refusal(
            yield* Effect.result(
              applyLabStorageMutation(f.server.dbPath, {
                kind: 'delete-rows',
                table: 'entries',
                stream: 'loro',
              })
            ),
            'invalid-input'
          );
          refusal(
            yield* Effect.result(
              applyLabStorageMutation(
                f.server.dbPath,
                { kind: 'delete-rows', table: 'entries', stream: 'loro' },
                ok(Bytes.genesisHash(new Uint8Array(32).fill(229)))
              )
            ),
            'unknown-stream'
          );
          // A failure after the first trigger creation rolls that creation back.
          const trigger = `lab_attack_entries_stream_${target}_UPDATE`;
          db.exec(`CREATE TRIGGER "${trigger}" BEFORE UPDATE ON entries BEGIN SELECT 1; END`);
          refusal(
            yield* Effect.result(
              applyLabStorageMutation(
                f.server.dbPath,
                { kind: 'deny-writes', table: 'entries', stream: 'loro' },
                f.genesis
              )
            ),
            'storage'
          );
          expect(
            db
              .prepare(
                "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE ? ORDER BY name"
              )
              .all(`lab_attack_entries_stream_${target}_%`)
          ).toEqual([{ name: trigger }]);
          db.exec(`DROP TRIGGER "${trigger}"`);
          // Existing unscoped local-table behavior remains transactional as well.
          db.exec('CREATE TABLE local_fixture(value BLOB)');
          db.prepare('INSERT INTO local_fixture VALUES(?)').run(new Uint8Array([9]));
          db.prepare('INSERT INTO local_fixture VALUES(?)').run(new Uint8Array());
          refusal(
            yield* Effect.result(
              applyLabStorageMutation(f.server.dbPath, {
                kind: 'flip-blob',
                table: 'local_fixture',
                column: 'value',
              })
            ),
            'not-a-blob'
          );
          expect(db.prepare('SELECT value FROM local_fixture ORDER BY rowid').all()).toEqual([
            { value: Buffer.from([9]) },
            { value: Buffer.alloc(0) },
          ]);
          yield* applyLabStorageMutation(f.server.dbPath, {
            kind: 'delete-rows',
            table: 'local_fixture',
          });
          expect(db.prepare('SELECT count(*) n FROM local_fixture').get()).toEqual({ n: 0 });
        })
      )
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
// Optional author evidence output; default owning runs retain artifacts only
// inside independently owned temporary fixtures.
function saveEvidence(name: string, value: unknown) {
  const directory = process.env.E2EE_LAB_ATTACK_EVIDENCE_DIR;
  if (directory)
    writeFileSync(join(directory, `${name}.json`), JSON.stringify(value, null, 2), {
      mode: 0o600,
      flag: 'wx',
    });
}

/** Independent test projection of the released current update envelope. It owns
 * originals, never selects authority from metadata and does not decrypt here. */
function capturedUpdates(body: Uint8Array, genesis: string) {
  const result: { scope: ContentScope; frame: Uint8Array; additionalData: Uint8Array }[] = [];
  const domain = new TextEncoder().encode('loro-streams-crdt-payload-protection/v2\0');
  for (let at = 0; at < body.length;) {
    if (body.length - at < 4) throw new Error('truncated actual update envelope');
    const size = new DataView(body.buffer, body.byteOffset + at, 4).getUint32(0);
    at += 4;
    if (size < 12 || size > body.length - at) throw new Error('bad actual update size');
    const item = body.subarray(at, at + size);
    at += size;
    expect(Array.from(item.subarray(0, 11))).toEqual([76, 83, 67, 69, 2, 1, 0, 1, 0, 0, 3]);
    const frame = new Uint8Array(item.subarray(11)),
      metadata = ok(inspectContentFrame(frame));
    const additionalData = new Uint8Array(domain.length + 11);
    additionalData.set(domain);
    additionalData.set(item.subarray(0, 11), domain.length);
    result.push({
      scope: { genesis, resource: 'document-A', epoch: metadata.epoch, purpose: 'doc-update' },
      frame,
      additionalData,
    });
  }
  return result;
}

it('closes admission but retains actual HTTP body work and its SQLite owner until the explicit native body gate settles', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-attack-body-owner-'));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* makeLabScenarioFixture(join(root, 'fixture')),
            org = hex(f.genesis.toBytes());
          const sdk = new StreamsClient({
            url: `${f.server.baseUrl}/ds/${org}/loro`,
            retry: { maxAttempts: 1 },
          });
          expect(
            (yield* Effect.promise(() => sdk.create({ contentType: 'application/octet-stream' })))
              .ok
          ).toBe(true);
          expect(
            (yield* Effect.promise(() =>
              sdk.append({
                part: { contentType: 'application/octet-stream', body: new Uint8Array([1, 2, 3]) },
              })
            )).ok
          ).toBe(true);
          const scope = yield* Scope.make(),
            entered = yield* Deferred.make<void>(),
            release = yield* Deferred.make<void>();
          let bodySettled = false,
            ownerClosed = false,
            closedEarly = false;
          yield* Effect.addFinalizer(() =>
            Deferred.succeed(release, undefined).pipe(Effect.andThen(Scope.close(scope, Exit.void)))
          );
          const db = yield* Effect.acquireRelease(
            Effect.sync(() => new Database(join(root, 'owner.sqlite'))),
            (value) =>
              Effect.sync(() => {
                closedEarly = !bodySettled;
                value.close();
                ownerClosed = true;
              })
          ).pipe(Effect.provideService(Scope.Scope, scope));
          const transport = yield* makeLabAttackTransport({
            origin: f.server.baseUrl,
            genesis: f.genesis,
            fetch: async (value, init) => {
              const reply = await fetch(value, init);
              if (!reply.body) return reply;
              const body = reply.body.pipeThrough(
                new TransformStream<Uint8Array, Uint8Array>({
                  async transform(chunk, controller) {
                    Deferred.doneUnsafe(entered, Effect.void);
                    try {
                      await Effect.runPromise(Deferred.await(release));
                      expect(db.prepare('SELECT 1 AS n').get()).toEqual({ n: 1 });
                      controller.enqueue(chunk);
                    } finally {
                      bodySettled = true;
                    }
                  },
                })
              );
              return new Response(body, { status: reply.status, headers: reply.headers });
            },
          }).pipe(Effect.provideService(Scope.Scope, scope));
          const call = transport.fetchFor('probe');
          const pending = yield* Effect.tryPromise({
            try: () => call(`${f.server.baseUrl}/ds/${org}/loro?offset=-1`),
            catch: (cause) => cause,
          }).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          const closing = yield* Scope.close(scope, Exit.void).pipe(
            Effect.forkChild({ startImmediately: true })
          );
          yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
          expect(closing.pollUnsafe()).toBeUndefined();
          expect(ownerClosed).toBe(false);
          expect(db.open).toBe(true);
          const late = yield* Effect.result(
            Effect.tryPromise({
              try: () => call(`${f.server.baseUrl}/ds/${org}/loro?offset=-1`),
              catch: (cause) => cause,
            })
          );
          expect(Result.isFailure(late)).toBe(true);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(closing);
          expect(Exit.isFailure(yield* Fiber.await(pending))).toBe(true);
          expect(bodySettled).toBe(true);
          expect(ownerClosed).toBe(true);
          expect(closedEarly).toBe(false);
          expect(db.open).toBe(false);
        })
      )
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('replays bounded real response controls with exact hit identities, per-stream prefix release and no wall-clock gates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-attack-controls-'));
  try {
    const once = (name: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* makeLabScenarioFixture(join(root, name)),
            org = hex(f.genesis.toBytes());
          const sdk = new StreamsClient({
            url: `${f.server.baseUrl}/ds/${org}/loro`,
            retry: { maxAttempts: 1 },
          });
          expect(
            (yield* Effect.promise(() => sdk.create({ contentType: 'application/octet-stream' })))
              .ok
          ).toBe(true);
          expect(
            (yield* Effect.promise(() =>
              sdk.append({
                part: {
                  contentType: 'application/octet-stream',
                  body: new Uint8Array([1, 2, 3, 4]),
                },
              })
            )).ok
          ).toBe(true);
          const transport = yield* makeLabAttackTransport({
            origin: f.server.baseUrl,
            genesis: f.genesis,
          });
          const call = transport.fetchFor('probe'),
            url = `${f.server.baseUrl}/ds/${org}/loro?offset=-1`;
          const target = (occurrence: number) => ({
            actor: 'probe',
            stream: 'loro' as const,
            method: 'GET' as const,
            occurrence,
          });
          let pending: Fiber.Fiber<{ status: number; bytes: number[] }, unknown> | undefined;
          const read = () =>
            Effect.tryPromise({
              try: async () => {
                const response = await call(url);
                return {
                  status: response.status,
                  bytes: Array.from(new Uint8Array(await response.arrayBuffer())),
                };
              },
              catch: (cause) => cause,
            });
          const actions: LabAttackPlanAction[] = [
            { kind: 'intercept', target: target(0), mutation: { kind: 'duplicate' } },
            { kind: 'step', name: 'duplicate' },
            { kind: 'intercept', target: target(1), mutation: { kind: 'truncate', length: 2 } },
            { kind: 'step', name: 'truncate' },
            {
              kind: 'intercept',
              target: target(2),
              mutation: {
                kind: 'replace',
                status: 403,
                bodyHex: '00',
                headers: { 'content-type': 'application/octet-stream' },
              },
            },
            { kind: 'step', name: 'replace' },
            { kind: 'intercept', target: target(3), mutation: { kind: 'drop' } },
            { kind: 'step', name: 'drop' },
            { kind: 'intercept', target: target(4), mutation: { kind: 'delay' } },
            { kind: 'step', name: 'start-delay' },
            { kind: 'release-delay', target: target(4) },
            { kind: 'step', name: 'finish-delay' },
            { kind: 'step', name: 'baseline' },
            { kind: 'fork', eventId: JSON.stringify(['probe', 'loro', 'GET', 5]) },
            { kind: 'step', name: 'advance-native' },
            { kind: 'step', name: 'frozen' },
            { kind: 'step', name: 'other-actor' },
            { kind: 'step', name: 'unknown-offset' },
            { kind: 'release', actor: 'probe', stream: 'loro' },
            { kind: 'step', name: 'caught-up' },
          ];
          const result = yield* runLabAttackPlan({
            transport,
            actions,
            steps: {
              duplicate: read().pipe(
                Effect.tap((value) =>
                  Effect.sync(() => expect(value.bytes).toEqual([1, 2, 3, 4, 1, 2, 3, 4]))
                ),
                Effect.asVoid
              ),
              truncate: read().pipe(
                Effect.tap((value) => Effect.sync(() => expect(value.bytes).toEqual([1, 2]))),
                Effect.asVoid
              ),
              replace: read().pipe(
                Effect.tap((value) =>
                  Effect.sync(() => expect(value).toEqual({ status: 403, bytes: [0] }))
                ),
                Effect.asVoid
              ),
              drop: Effect.result(read()).pipe(
                Effect.tap((value) =>
                  Effect.sync(() => {
                    expect(Result.isFailure(value)).toBe(true);
                    if (Result.isFailure(value))
                      expect(value.failure).toMatchObject({
                        _tag: 'LabAttackTransportError',
                        code: 'dropped',
                      });
                  })
                ),
                Effect.asVoid
              ),
              'start-delay': Effect.gen(function* () {
                pending = yield* read().pipe(Effect.forkChild);
                yield* transport.waitForEvent(target(4));
                expect(pending.pollUnsafe()).toBeUndefined();
              }),
              'finish-delay': Effect.gen(function* () {
                expect((yield* Fiber.join(pending!)).bytes).toEqual([1, 2, 3, 4]);
              }),
              baseline: read().pipe(Effect.asVoid),
              'advance-native': Effect.gen(function* () {
                expect(
                  (yield* Effect.promise(() =>
                    sdk.append({
                      part: {
                        contentType: 'application/octet-stream',
                        body: new Uint8Array([5, 6]),
                      },
                    })
                  )).ok
                ).toBe(true);
              }),
              frozen: read().pipe(
                Effect.tap((value) => Effect.sync(() => expect(value.bytes).toEqual([1, 2, 3, 4]))),
                Effect.asVoid
              ),
              'other-actor': Effect.promise(async () => {
                const response = await transport.fetchFor('witness')(url);
                expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([
                  1, 2, 3, 4, 5, 6,
                ]);
              }),
              'unknown-offset': Effect.gen(function* () {
                const refused = yield* Effect.result(
                  Effect.tryPromise({
                    try: () => call(url.replace('offset=-1', 'offset=unknown-prefix')),
                    catch: (cause) => cause,
                  })
                );
                expect(Result.isFailure(refused)).toBe(true);
                if (Result.isFailure(refused))
                  expect(refused.failure).toMatchObject({ code: 'unrepresented-fork-offset' });
              }),
              'caught-up': read().pipe(
                Effect.tap((value) =>
                  Effect.sync(() => expect(value.bytes).toEqual([1, 2, 3, 4, 5, 6]))
                ),
                Effect.asVoid
              ),
            },
          });
          expect(result.hits.map((row) => row.kind)).toEqual([
            'duplicate',
            'truncate',
            'replace',
            'drop',
            'delay',
          ]);
          expect(
            result.events.find((row) => row.id === JSON.stringify(['probe', 'loro', 'GET', 6]))
              ?.source
          ).toBe('fork');
          expect(result.events.find((row) => row.actor === 'witness')?.source).toBe('native');
          expect(
            result.events.every(
              (row) => !Object.keys(row.headers).some((header) => /auth|cookie/i.test(header))
            )
          ).toBe(true);
          saveEvidence(`controls-${name}`, result);
          return { actions: result.actions, receipts: result.receipts, hits: result.hits };
        })
      );
    const original = await Effect.runPromise(once('first')),
      replay = await Effect.runPromise(once('replay'));
    expect(replay).toEqual(original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('measures three actual members, tag8 exclusion, independent comparison and retained-key rejection of real post-exclusion backend frames', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-attack-three-members-'));
  try {
    const once = (name: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* makeLabScenarioFixture(join(root, name)),
            org = hex(f.genesis.toBytes());
          const owner = yield* openLabWorkspaceSession({
            ...f.input('owner', 'create'),
            epochRotation: {
              path: join(f.directory, 'candidate.sqlite'),
              mode: 'create',
              protector: labSyntheticProtector,
            },
          });
          const bob = yield* generateDevice(),
            carol = yield* generateDevice();
          const memberships = [
            ok(Bytes.membershipId(new Uint8Array(16).fill(201))),
            ok(Bytes.membershipId(new Uint8Array(16).fill(202))),
          ];
          for (const [index, device] of [bob, carol].entries()) {
            const request = yield* prepareJoinRequest({
              genesis: f.genesis,
              requestId: ok(Bytes.requestId(new Uint8Array(16).fill(index + 203))),
              userId: ok(Bytes.userId(new Uint8Array(32).fill(index + 205))),
              encryptionPublicKey: device.enc,
              expiresAt: null,
              signer: device,
            });
            const admitted = yield* owner.approveJoin(request, memberships[index]!);
            yield* owner.acknowledge(admitted);
          }
          expect(f.view().inspectState().members.size).toBe(3);
          const stalePoint = f.point();
          let carolPoint = stalePoint;
          const transport = yield* makeLabAttackTransport({
            origin: f.host.baseUrl,
            genesis: f.genesis,
            maxEvents: 1024,
          });
          const memberInput = (label: 'bob' | 'carol', device: typeof bob) => {
            const base = f.input('peer', 'create'),
              file = (part: string) => join(f.directory, `${label}-${part}.sqlite`);
            return {
              ...base,
              signer: device,
              fetch: transport.fetchFor(label),
              checkpoint: () => Effect.sync(() => (label === 'carol' ? carolPoint : f.point())),
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
              documents: base.documents
                .filter((doc) => doc.id === 'loro')
                .map((doc) => ({ ...doc, path: file(doc.id) })),
            };
          };
          const bobInput = memberInput('bob', bob),
            carolInput = memberInput('carol', carol);
          const bobSession = yield* openLabWorkspaceSession(bobInput),
            carolSession = yield* openLabWorkspaceSession(carolInput);
          yield* owner.keyRound();
          yield* bobSession.keyRound();
          yield* carolSession.keyRound();
          yield* owner.createDocument('loro');
          yield* owner.append('loro', 'synthetic before exclusion');
          yield* bobSession.pull('loro');
          yield* carolSession.pull('loro');
          expect(yield* bobSession.text('loro')).toBe('synthetic before exclusion');
          const oldKey = ok(Bytes.epochKey(new Uint8Array(32).fill(117)));
          const privateTrace = yield* makeLabContentTrace({ maxFacts: 16, maxTextBytes: 4096 });
          let capturedReads: unknown;
          let split = '',
            confirmed = false,
            insider = '',
            capturedRead = '';
          const actions: LabAttackPlanAction[] = [
            { kind: 'fork', eventId: JSON.stringify(['carol', 'control', 'GET', 0]) },
            { kind: 'step', name: 'exclude-bob' },
            { kind: 'step', name: 'compare-independent' },
            { kind: 'step', name: 'measure-insider' },
            { kind: 'release', actor: 'carol', stream: 'control' },
            { kind: 'step', name: 'catch-up' },
          ];
          const result = yield* runLabAttackPlan({
            transport,
            actions,
            steps: {
              'exclude-bob': Effect.gen(function* () {
                const removal = yield* owner.removeMemberAndRotate(memberships[0]!);
                expect(removal.outcome).toBe('Committed');
                yield* owner.acknowledgeEpochRotation(removal);
                expect(f.view().inspectState().members.size).toBe(2);
                expect(f.view().inspectState().epoch.number).toBe(1);
                expect(f.view().inspectState().devices.has(hex(bob.publicKey.toBytes()))).toBe(
                  false
                );
                yield* owner.keyRound();
                yield* owner.append('loro', ' / synthetic after exclusion');
                const excluded = yield* bobSession.refresh();
                expect(excluded.view.inspectState().devices.has(hex(bob.publicKey.toBytes()))).toBe(
                  false
                );
                expect(Result.isFailure(yield* Effect.result(bobSession.keyRound()))).toBe(true);
                expect(Result.isFailure(yield* Effect.result(bobSession.pull('loro')))).toBe(true);
                const db = new Database(bobInput.keys.keyStore.path, { readonly: true });
                try {
                  expect(
                    db.prepare('SELECT epoch FROM installed_epoch_keys ORDER BY epoch').all()
                  ).toEqual([{ epoch: 0 }]);
                } finally {
                  db.close();
                }
              }),
              'compare-independent': Effect.gen(function* () {
                expect((yield* carolSession.refresh()).view.head.equals(stalePoint.head)).toBe(
                  true
                );
                const local = yield* carolSession.comparisonNote(),
                  remote = yield* owner.comparisonNote();
                const compared = ok(
                  confirmIndependentComparison(local, remote, f.owner.publicKey, {
                    source: 'authenticated-channel',
                    expected: remote,
                  })
                );
                split = compared.kind;
                expect(compared.kind).toBe('pending-sync');
                expect(ok(compareNotes(local, remote)).kind).toBe('pending-sync');
              }),
              'measure-insider': Effect.gen(function* () {
                const sdk = new StreamsClient({
                  url: `${f.server.baseUrl}/ds/${org}/loro`,
                  retry: { maxAttempts: 1 },
                });
                const read = yield* Effect.promise(() => sdk.read({ offset: '-1' }));
                expect(read.ok).toBe(true);
                if (!read.ok) throw new Error('actual native content read');
                expect(read.result.upToDate).toBe(true);
                const bytes = new Uint8Array(read.result.payload.body),
                  updates = capturedUpdates(bytes, org),
                  before = updates.find((row) => row.scope.epoch === 0)!,
                  after = updates
                    .slice()
                    .reverse()
                    .find((row) => row.scope.epoch === 1)!;
                expect(before).toBeDefined();
                expect(after).toBeDefined();
                const leaf = yield* scopedDocumentKey(before.scope, oldKey),
                  plain = ok(
                    openDocument(f.view(), before.scope, leaf, before.frame, before.additionalData)
                  ).plaintext;
                yield* privateTrace.recordContentWrite({
                  genesisHex: org,
                  stream: 'loro',
                  deviceHex: hex(f.owner.publicKey.toBytes()),
                  epoch: 0,
                  text: 'synthetic before exclusion',
                  writerMayWrite: true,
                });
                yield* privateTrace.recordContentWrite({
                  genesisHex: org,
                  stream: 'loro',
                  deviceHex: hex(f.owner.publicKey.toBytes()),
                  epoch: 1,
                  text: 'synthetic after exclusion',
                  writerMayWrite: true,
                });
                const observer = yield* makeLabAttackObserver({
                  genesis: f.genesis,
                  ledger: f.ledger,
                  backend: { read: () => Effect.succeed([bytes]) },
                  trace: privateTrace,
                });
                const measured = yield* observer.observe({
                  insider: {
                    key: oldKey,
                    keyEpoch: 0,
                    freshnessBypassed: false,
                    samples: [{ ...before, expectedPlaintext: plain }, after],
                  },
                });
                insider = measured.properties.at(-1)!.verdict;
                expect(insider).toBe('pass');
                expect(measured.observations.oldKeyOpened).toBe(1);
                expect(measured.observations.laterSamples).toBe(1);
                expect(measured.observations.laterOpened).toBe(0);
                const pack = {
                  format: 'lody-e2ee-captured-reads/v1',
                  syntheticOnly: true,
                  genesis: org,
                  records: f.records.map(hex),
                  reads: [
                    {
                      id: 'actual-retained-old-frame',
                      resource: 'document-A',
                      model: 'loro',
                      kind: 'update_batch',
                      header: '03',
                      sealed: hex(before.frame),
                      additionalData: hex(before.additionalData),
                      expected: {
                        ok: true,
                        plaintextSha256: createHash('sha256').update(plain).digest('hex'),
                      },
                    },
                  ],
                };
                const replay = yield* replayLabCapturedReads({
                  pack,
                  genesis: f.genesis,
                  checkpoint: f.point(),
                  signer: f.owner,
                  readEpochKey: () =>
                    Effect.sync(() => ok(Bytes.epochKey(new Uint8Array(32).fill(117)))),
                });
                capturedRead = replay.verdict;
                expect(replay.verdict).toBe('pass');
                capturedReads = {
                  pack,
                  replay,
                  independentlyWitnessed: {
                    genesis: org,
                    checkpoint: { head: hex(f.point().head.toBytes()), count: f.point().length },
                  },
                };
                plain.fill(0);
              }),
              'catch-up': Effect.gen(function* () {
                carolPoint = f.point();
                expect((yield* carolSession.refresh()).view.head.equals(carolPoint.head)).toBe(
                  true
                );
                yield* carolSession.keyRound();
                yield* carolSession.pull('loro');
                expect(yield* carolSession.text('loro')).toBe(
                  'synthetic before exclusion / synthetic after exclusion'
                );
                const local = yield* owner.comparisonNote(),
                  remote = yield* carolSession.comparisonNote();
                const comparison = ok(
                  confirmIndependentComparison(local, remote, f.owner.publicKey, {
                    source: 'authenticated-channel',
                    expected: remote,
                  })
                );
                confirmed = comparison.kind === 'agree' && comparison.independent;
                expect(confirmed).toBe(true);
              }),
            },
          });
          const artifact = {
            transportActions: result.transportActions,
            receipts: result.receipts,
            events: result.events,
            summary: {
              split,
              confirmed,
              insider,
              capturedRead,
              epoch: f.view().inspectState().epoch.number,
              members: f.view().inspectState().members.size,
            },
            capturedReads,
            limits: {
              signedForkProof: 'unavailable',
              resealEquality: 'unsupported',
              custody: 'synthetic',
            },
          };
          const artifactPath = join(f.directory, 'attack-evidence.json');
          writeFileSync(artifactPath, JSON.stringify(artifact), { mode: 0o600 });
          expect(JSON.parse(readFileSync(artifactPath, 'utf8')).summary).toEqual(artifact.summary);
          saveEvidence(`members-${name}`, artifact);
          return { transportActions: artifact.transportActions, summary: artifact.summary };
        })
      );
    expect(await Effect.runPromise(once('fresh-replay'))).toEqual(
      await Effect.runPromise(once('original'))
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('shrinks an actually reproduced native backend plaintext violation using the existing finite minimizer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-attack-confidentiality-shrink-'));
  try {
    let run = 0;
    const actions: LabAttackPlanAction[] = [
      { kind: 'step', name: 'noise' },
      { kind: 'step', name: 'protected-write' },
      { kind: 'step', name: 'leak' },
      { kind: 'step', name: 'measure' },
    ];
    const execute = (plan: readonly LabAttackPlanAction[]) =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* makeLabScenarioFixture(join(root, `trial-${++run}`)),
            org = hex(f.genesis.toBytes()),
            plaintext = new TextEncoder().encode('private synthetic backend marker');
          const sdk = new StreamsClient({
            url: `${f.server.baseUrl}/ds/${org}/loro`,
            retry: { maxAttempts: 1 },
          });
          expect(
            (yield* Effect.promise(() => sdk.create({ contentType: 'application/octet-stream' })))
              .ok
          ).toBe(true);
          const transport = yield* makeLabAttackTransport({
              origin: f.server.baseUrl,
              genesis: f.genesis,
            }),
            trace = yield* makeLabContentTrace({ maxFacts: 8, maxTextBytes: 4096 });
          yield* trace.recordContentWrite({
            genesisHex: org,
            stream: 'loro',
            deviceHex: hex(f.owner.publicKey.toBytes()),
            epoch: 0,
            text: new TextDecoder().decode(plaintext),
            writerMayWrite: true,
          });
          let fingerprint: FailureFingerprint | null = null;
          const observer = yield* makeLabAttackObserver({
            genesis: f.genesis,
            ledger: f.ledger,
            trace,
            backend: {
              read: () =>
                Effect.promise(async () => {
                  const result = await sdk.read({ offset: '-1' });
                  if (!result.ok || !result.result.upToDate)
                    throw new Error('actual complete native read required');
                  return [new Uint8Array(result.result.payload.body)];
                }),
            },
          });
          yield* runLabAttackPlan({
            transport,
            actions: plan,
            steps: {
              noise: Effect.promise(async () => {
                const response = await transport.fetchFor('probe')(
                  `${f.server.baseUrl}/ds/${org}/control`,
                  { method: 'HEAD' }
                );
                expect(response.status).toBe(200);
              }),
              'protected-write': Effect.gen(function* () {
                const scope: ContentScope = {
                  genesis: org,
                  resource: 'document-A',
                  epoch: 0,
                  purpose: 'doc-update',
                };
                const leaf = yield* scopedDocumentKey(
                  scope,
                  ok(Bytes.epochKey(new Uint8Array(32).fill(117)))
                );
                const frame = yield* sealDocument({
                  scope,
                  documentKey: leaf,
                  signer: f.owner,
                  ledger: f.ledger,
                  plaintext,
                });
                expect(
                  (yield* Effect.promise(() =>
                    sdk.append({ part: { contentType: 'application/octet-stream', body: frame } })
                  )).ok
                ).toBe(true);
              }),
              // Explicit synthetic defective backend control, not a claim that the
              // restricted attacker learned an honest unknown plaintext.
              leak: Effect.promise(async () => {
                expect(
                  (
                    await sdk.append({
                      part: { contentType: 'application/octet-stream', body: plaintext },
                    })
                  ).ok
                ).toBe(true);
              }),
              measure: Effect.gen(function* () {
                fingerprint = (yield* observer.observe()).fingerprint;
              }),
            },
          });
          saveEvidence(`shrink-run-${run}`, { actions: plan, fingerprint });
          return fingerprint as FailureFingerprint | null;
        })
      );
    const baseline = await Effect.runPromise(execute(actions));
    expect(baseline?.confidentiality).toBe('violation');
    const reduced = await Effect.runPromise(
      minimizeCounterexample({
        items: actions,
        fingerprint: baseline!,
        maxTrials: 2,
        run: (candidate) => execute(candidate).pipe(Effect.map((fingerprint) => ({ fingerprint }))),
      })
    );
    expect(reduced.finalSize).toBeLessThan(actions.length);
    expect(reduced.items.some((action) => action.kind === 'step' && action.name === 'leak')).toBe(
      true
    );
    expect(
      reduced.items.some((action) => action.kind === 'step' && action.name === 'measure')
    ).toBe(true);
    expect((await Effect.runPromise(execute(reduced.items)))?.confidentiality).toBe('violation');
    saveEvidence('shrink-result', reduced);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
