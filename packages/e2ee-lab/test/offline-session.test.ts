import Database from 'better-sqlite3';
import { LoroDoc } from 'loro-crdt';
import { Flock } from '@loro-dev/flock-wasm';
import {
  LabLocalEditReplay,
  makeLabLoroSession,
  type LabLocalEditReplayHooks,
} from '../src/platform/content-session';
import { makeLabFlockSession } from '../src/platform/flock-session';
import { history } from './ledger-fixture';
import { StreamsClient } from '@loro-dev/streams-client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Data, Effect, Exit, Result, Scope } from 'effect';
import { expect, it } from 'vitest';
import { Bytes } from '@lody/e2ee-core';
import { inspectContentFrame } from '@lody/e2ee-core/protocol';
import { prepareJoinRequest } from '@lody/e2ee-core/protocol';
import { generateDevice, type DemoDevice } from '../src/platform/device';
import { makeLabScenarioFixture } from '../src/platform/scenario-fixture';
import { labSyntheticProtector } from '../src/platform/synthetic-protection';
import {
  openLabWorkspaceSession,
  reauthenticateLabWorkspaceSession,
  type LabWorkspaceSessionInput,
} from '../src/platform/full-session';
const ok = Result.getOrThrow;

it('merges three independent members after durable offline edits/reopen, seals queued changes at the current epoch, and retains rejected edits after removal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-three-offline-'));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* makeLabScenarioFixture(join(root, 'fixture'));
          const ownerInput = {
            ...f.input('owner', 'create'),
            epochRotation: {
              path: join(f.directory, 'offline-rotation.sqlite'),
              mode: 'create' as const,
              protector: labSyntheticProtector,
            },
          };
          const owner = yield* openLabWorkspaceSession(ownerInput);
          const bobDevice = yield* generateDevice(),
            carolDevice = yield* generateDevice();
          const bobMembership = ok(Bytes.membershipId(new Uint8Array(16).fill(21)));
          const carolMembership = ok(Bytes.membershipId(new Uint8Array(16).fill(22)));
          for (const [device, membershipId, seed] of [
            [bobDevice, bobMembership, 23],
            [carolDevice, carolMembership, 24],
          ] as const) {
            const request = yield* prepareJoinRequest({
              genesis: f.genesis,
              signer: device,
              requestId: ok(Bytes.requestId(new Uint8Array(16).fill(seed))),
              userId: ok(Bytes.userId(new Uint8Array(32).fill(seed))),
              encryptionPublicKey: device.enc,
              expiresAt: null,
            });
            const result = yield* owner.approveJoin(request, membershipId);
            expect(result.outcome).toBe('Committed');
            yield* owner.acknowledge(result);
          }
          expect(f.view().inspectState().members.size).toBe(3);
          expect(bobDevice.publicKey.equals(carolDevice.publicKey)).toBe(false);
          let offline = false;
          const bobSentEpochs: number[] = [];
          const bobRefusals: { path: string; status: number }[] = [];
          const makeInput = (
            name: string,
            device: DemoDevice,
            mode: 'create' | 'open'
          ): LabWorkspaceSessionInput => {
            const base = f.input('peer', mode);
            const file = (part: string) => join(f.directory, `${name}-${part}.sqlite`);
            return {
              ...base,
              signer: device,
              path: file('feed'),
              journalPath: file('p09'),
              fetch: async (request, init) => {
                if (name === 'bob' && offline)
                  throw new Error('offline means zero transport capability');
                const outgoing = new Request(request, init);
                if (
                  name === 'bob' &&
                  outgoing.method === 'POST' &&
                  new URL(outgoing.url).pathname.endsWith('/loro')
                ) {
                  const body = new Uint8Array(await outgoing.clone().arrayBuffer());
                  let at = 0;
                  while (at < body.length) {
                    const size = new DataView(body.buffer, body.byteOffset + at, 4).getUint32(0);
                    at += 4;
                    const item = body.subarray(at, at + size);
                    at += size;
                    if (item[0] !== 76 || item[4] !== 2 || item[10] !== 3)
                      throw new Error('actual current update frame required');
                    bobSentEpochs.push(ok(inspectContentFrame(item.subarray(11))).epoch);
                  }
                }
                const response = await fetch(outgoing);
                if (name === 'bob' && !response.ok)
                  bobRefusals.push({
                    path: new URL(outgoing.url).pathname,
                    status: response.status,
                  });
                return response;
              },
              keys: {
                ...base.keys,
                pair: device.encryption,
                path: file('receive'),
                mode,
                keyStore: { ...base.keys.keyStore, path: file('keys'), mode },
                repairStore: { ...base.keys.repairStore, path: file('repair'), mode },
                sendStore: { ...base.keys.sendStore, path: file('send'), mode },
                outboxStore: { ...base.keys.outboxStore, path: file('outbox'), mode },
              },
              documents: base.documents.map((doc) => ({ ...doc, path: file(doc.id), mode })),
            };
          };
          let bob = yield* openLabWorkspaceSession(makeInput('bob', bobDevice, 'create'));
          const carol = yield* openLabWorkspaceSession(makeInput('carol', carolDevice, 'create'));
          yield* owner.keyRound();
          yield* bob.keyRound();
          yield* carol.keyRound();
          yield* owner.createDocument('loro');
          yield* owner.createDocument('flock');
          yield* owner.append('loro', 'shared base');
          yield* owner.append('flock', 'flock base');
          yield* bob.pull('loro');
          yield* carol.pull('loro');
          yield* bob.pull('flock');
          yield* carol.pull('flock');
          const beforeOffline = yield* bob.cursor('loro');
          offline = true;
          yield* bob.editOffline('loro', ' / bob offline');
          yield* bob.editOffline('flock', ' / bob offline flock');
          expect(yield* bob.text('loro')).toContain('bob offline');
          expect(yield* bob.cursor('loro')).toEqual(beforeOffline);
          offline = false;
          yield* carol.append('loro', ' / carol online');
          yield* owner.pull('loro');
          yield* owner.append('loro', ' / owner online');
          // No SDK subscription survives close; native durable version differences,
          // not a second outbox or clone/import workaround, must preserve this edit.
          bob = yield* reauthenticateLabWorkspaceSession(
            bob,
            makeInput('bob', bobDevice, 'open'),
            f.point()
          );
          expect(yield* bob.text('loro')).toContain('bob offline');
          yield* bob.flushOffline('loro');
          yield* bob.flushOffline('flock');
          yield* owner.pull('loro');
          yield* carol.pull('loro');
          yield* owner.pull('flock');
          yield* carol.pull('flock');
          const merged = yield* bob.text('loro');
          for (const marker of ['shared base', 'bob offline', 'carol online', 'owner online'])
            expect(merged).toContain(marker);
          expect(yield* owner.text('loro')).toBe(merged);
          expect(yield* carol.text('loro')).toBe(merged);
          expect(yield* owner.text('flock')).toBe('flock base / bob offline flock');
          expect(yield* carol.text('flock')).toBe(yield* bob.text('flock'));
          const syncedCursor = yield* bob.cursor('loro');
          offline = true;
          yield* bob.editOffline('loro', ' / queued across rotation');
          offline = false;
          expect(yield* bob.cursor('loro')).toEqual(syncedCursor);
          const retired = yield* owner.submit({ _tag: 'RevokeDevice', target: f.peer.publicKey });
          yield* owner.acknowledge(retired);
          const rotation = yield* owner.rotateEpoch();
          expect(rotation.epoch).toBe(1);
          yield* owner.acknowledgeEpochRotation(rotation);
          yield* owner.keyRound();
          yield* bob.keyRound();
          yield* carol.keyRound();
          const writesBeforeRotationFlush = bobSentEpochs.length;
          yield* bob.flushOffline('loro');
          expect(bobSentEpochs.length).toBeGreaterThan(writesBeforeRotationFlush);
          expect(bobSentEpochs.slice(writesBeforeRotationFlush)).toEqual([1]);
          yield* owner.pull('loro');
          yield* carol.pull('loro');
          expect(yield* owner.text('loro')).toContain('queued across rotation');
          expect(yield* carol.text('loro')).toBe(yield* bob.text('loro'));
          offline = true;
          yield* bob.editOffline('loro', ' / retained after SQLite failure');
          offline = false;
          const faultDb = new Database(join(f.directory, 'bob-loro.sqlite'));
          const beforeSqlFailure = faultDb
            .prepare('SELECT document,cursor FROM lab_document_state WHERE id=1')
            .get();
          try {
            faultDb.exec(
              "CREATE TRIGGER offline_write_fault BEFORE UPDATE ON lab_document_state BEGIN SELECT RAISE(ABORT,'offline durable pair fault');END;"
            );
            const failedFlush = yield* Effect.result(bob.flushOffline('loro'));
            expect(Result.isFailure(failedFlush)).toBe(true);
            expect(
              faultDb.prepare('SELECT document,cursor FROM lab_document_state WHERE id=1').get()
            ).toEqual(beforeSqlFailure);
            faultDb.exec('DROP TRIGGER offline_write_fault');
          } finally {
            faultDb.close();
          }
          yield* bob.recoverDocument('loro');
          expect(yield* bob.text('loro')).toContain('retained after SQLite failure');
          yield* bob.flushOffline('loro');
          yield* owner.pull('loro');
          yield* carol.pull('loro');
          expect(yield* owner.text('loro')).toContain('retained after SQLite failure');
          expect(yield* carol.text('loro')).toBe(yield* bob.text('loro'));
          offline = true;
          yield* bob.editOffline('loro', ' / retained after removal');
          offline = false;
          const dbPath = join(f.directory, 'bob-loro.sqlite');
          const durablePair = () => {
            const db = new Database(dbPath, { readonly: true });
            try {
              return db.prepare('SELECT document,cursor FROM lab_document_state WHERE id=1').get();
            } finally {
              db.close();
            }
          };
          const pairBeforeDeniedFlush = durablePair();
          const native = new StreamsClient({
            url: `${f.server.baseUrl}/ds/${Buffer.from(f.genesis.toBytes()).toString('hex')}/loro`,
            retry: { maxAttempts: 1 },
          });
          const beforeDenied = yield* Effect.promise(() => native.head());
          const removal = yield* owner.removeMemberAndRotate(bobMembership);
          yield* owner.acknowledgeEpochRotation(removal);
          const rejected = yield* Effect.result(bob.flushOffline('loro'));
          expect(Result.isFailure(rejected)).toBe(true);
          if (Result.isFailure(rejected)) {
            expect(rejected.failure).toMatchObject({
              _tag: 'LabContentError',
              code: 'auth_failed',
            });
          }
          expect(bobRefusals.at(-1)).toMatchObject({ status: 403 });
          expect(bobRefusals.at(-1)?.path.endsWith('/loro')).toBe(true);
          expect(durablePair()).toEqual(pairBeforeDeniedFlush);
          const afterDenied = yield* Effect.promise(() => native.head());
          if (!beforeDenied.ok || !afterDenied.ok)
            throw new Error('actual native content heads required');
          expect(afterDenied.result.nextOffset).toBe(beforeDenied.result.nextOffset);
          yield* bob.close();
          const retained = durablePair() as { document: Uint8Array; cursor: string };
          const observed = new LoroDoc();
          try {
            observed.import(retained.document);
            expect(observed.getText('text').toString()).toContain('retained after removal');
          } finally {
            observed.free();
          }
        })
      )
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

class MissingLocalEditInput extends Data.TaggedError('MissingLocalEditInput')<{
  readonly code: 'missing-original-input';
}> {}
it.each(['loro', 'flock'] as const)(
  'replays captured native %s edit inputs through real import and durable local persistence',
  async (model) => {
    const directory = mkdtempSync(join(tmpdir(), 'lab-native-edit-replay-'));
    const f = history(),
      captured: { model: string; text: string; delta: Uint8Array }[] = [];
    const countsBeforeCapture: number[] = [];
    const noNetwork: typeof fetch = async () => {
      throw new Error('local edit must not use transport');
    };
    const inspect = (file: string) => {
      const db = new Database(join(directory, file), { readonly: true });
      try {
        return db.prepare('SELECT document FROM lab_document_state WHERE id=1').get() as
          | { document: Uint8Array }
          | undefined;
      } finally {
        db.close();
      }
    };
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const make = (
              file: string,
              mode: 'create' | 'open',
              hooks?: LabLocalEditReplayHooks
            ) => {
              const common = {
                path: join(directory, file),
                mode,
                streamUrl: 'http://127.0.0.1:1/ds/synthetic/replay',
                fetch: noNetwork,
                genesis: f.anchor,
                resource: 'native-edit-replay',
                writeEpoch: 'current' as const,
                signer: f.owner,
                ledger: () => Effect.succeed(f.view),
                readEpochKey: () => Effect.die('offline edits must not read keys'),
              };
              return (
                model === 'loro'
                  ? makeLabLoroSession(common)
                  : makeLabFlockSession({
                      ...common,
                      replica: file,
                      now: () => (file === 'source.sqlite' ? 100 : 999999),
                    })
              ).pipe(Effect.provideService(LabLocalEditReplay, hooks));
            };
            const source = yield* make('source.sqlite', 'create', {
              take: () => undefined,
              capture: (kind, text, delta) => {
                countsBeforeCapture.push(inspect('source.sqlite') ? 1 : 0);
                captured.push({ model: kind, text, delta });
              },
            });
            yield* source.editOffline('first');
            yield* source.editOffline(' second');
            expect(yield* source.text()).toBe('first second');
            expect(countsBeforeCapture).toEqual([0, 1]);
            expect(captured.map((row) => [row.model, row.text])).toEqual([
              [model, 'first'],
              [model, ' second'],
            ]);
            const owner = yield* Effect.acquireRelease(Scope.make(), (scope) =>
              Scope.close(scope, Exit.void)
            );
            let at = 0;
            const replayed = yield* make('replayed.sqlite', 'create', {
              take: (selected, text) => {
                const original = captured[at++];
                if (!original || original.model !== selected || original.text !== text)
                  throw new MissingLocalEditInput({ code: 'missing-original-input' });
                return original.delta;
              },
              capture: () => {
                throw new Error('replay must not generate a replacement local edit');
              },
            }).pipe(Effect.provideService(Scope.Scope, owner));
            yield* replayed.editOffline('first');
            yield* replayed.editOffline(' second');
            expect(at).toBe(2);
            expect(yield* replayed.text()).toBe('first second');
            expect(yield* replayed.cursor()).toBeNull();
            yield* Scope.close(owner, Exit.void);
            const reopened = yield* make('replayed.sqlite', 'open');
            expect(yield* reopened.text()).toBe('first second');
            expect(yield* reopened.cursor()).toBeNull();
            const sourceBytes = inspect('source.sqlite')!.document,
              replayBytes = inspect('replayed.sqlite')!.document;
            if (model === 'loro') {
              const before = new LoroDoc(),
                after = new LoroDoc();
              try {
                before.import(sourceBytes);
                after.import(replayBytes);
                const a = before.version(),
                  b = after.version();
                try {
                  expect(b.toJSON()).toEqual(a.toJSON());
                } finally {
                  a.free();
                  b.free();
                }
              } finally {
                before.free();
                after.free();
              }
            } else {
              const before = Flock.fromFile(sourceBytes, 'inspect-source'),
                after = Flock.fromFile(replayBytes, 'inspect-replay');
              expect(after.version()).toEqual(before.version());
              expect(after.get(['text'])).toBe('first second');
            }
            const missing = new MissingLocalEditInput({ code: 'missing-original-input' });
            const failed = yield* make('missing.sqlite', 'create', {
              take: () => {
                throw missing;
              },
              capture: () => {
                throw new Error('missing inputs cannot become new edits');
              },
            });
            const result = yield* Effect.result(failed.editOffline('not-recorded'));
            expect(Result.isFailure(result) && result.failure).toBe(missing);
            expect(inspect('missing.sqlite')).toBeUndefined();
            expect(yield* failed.cursor()).toBeNull();
          })
        )
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
);
