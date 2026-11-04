import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Effect, Result } from 'effect';
import { StreamsClient } from '@loro-dev/streams-client';
import { Bytes } from '@lody/e2ee-core';
import { inspectContentFrame, type ContentScope } from '@lody/e2ee-core/protocol';
import { scopedDocumentKey, openDocument } from '@lody/e2ee-core/protocol';
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

import { makeLabLedgerClient } from '../src/platform/ledger-client';
import { applyLabStorageMutation } from '../src/platform/storage-attack';

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
