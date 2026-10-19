import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Deferred, Effect, Fiber, Result } from 'effect';
import { TestClock } from 'effect/testing';
import { spawn, type ChildProcess } from 'node:child_process';
import { expect, it } from 'vitest';
import { makeLabScenarioFixture } from '../src/platform/scenario-fixture';
import { LabProcessSpawn, makeLabProcessActor } from '../src/platform/process-actor';
import { history } from './ledger-fixture';
import { exportDevice } from '../src/platform/device';
import { executeLabActions, inspectLabEvidence } from '../src/platform/action-executor';
import type { runLabKeyRound } from '../src/platform/key-round';
import Database from 'better-sqlite3';
it('hard kills a real actor after protected writes, restarts with independent pins and original installed keys without reinstalling a historical envelope', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-process-'));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* makeLabScenarioFixture(join(root, 'fixture'));
          const ownerFixture = yield* exportDevice(f.owner),
            peerFixture = yield* exportDevice(f.peer);
          const actor = (label: 'owner' | 'peer') =>
            makeLabProcessActor((mode) =>
              Effect.sync(() => ({
                syntheticOnly: true as const,
                targets: Object.fromEntries(
                  [...f.devices].map(([id, device]) => [
                    id,
                    {
                      signingKey: Buffer.from(device.publicKey.toBytes()).toString('hex'),
                      membership: Buffer.from(f.memberships.get(id)!.toBytes()).toString('hex'),
                    },
                  ])
                ),
                initialKeyOwner: label === f.primary,
                device: label === 'owner' ? ownerFixture : peerFixture,
                baseUrl: f.host.baseUrl,
                directory: f.directory,
                actor: label,
                mode,
                genesis: Buffer.from(f.genesis.toBytes()).toString('hex'),
                records: f.records.map((record) => Buffer.from(record).toString('hex')),
                point: {
                  head: Buffer.from(f.point().head.toBytes()).toString('hex'),
                  length: f.point().length,
                },
              }))
            );
          const a = yield* actor('owner'),
            b = yield* actor('peer');
          const started = yield* a.start('create');
          expect(started.ok).toBe(true);
          const pid = a.pid();
          expect((yield* b.start('create')).ok).toBe(true);
          const ownerKeys = yield* a.call('keys');
          const peerKeys = yield* b.call('keys');
          expect(ownerKeys.ok).toBe(true);
          expect(peerKeys.ok).toBe(true);
          type Round = Effect.Success<ReturnType<typeof runLabKeyRound>>;
          const deliveryId = (ownerKeys.value as Round).deliveryResults.items[0]!.id;
          const receiveId = (peerKeys.value as Round).results[0]!.id;
          const repairPlan = yield* executeLabActions({
            actors: { owner: a, peer: b },
            maxSteps: 8,
            actions: [
              {
                kind: 'key-command',
                actor: 'peer',
                command: {
                  operation: 'repair',
                  requestId: '000-blocked',
                  rejectedDigest: 'ff'.repeat(32),
                },
                expect: { ok: true },
              },
              {
                kind: 'key-command',
                actor: 'peer',
                command: { operation: 'repair', requestId: '001-process' },
                expect: { ok: true },
              },
              {
                kind: 'key-command',
                actor: 'peer',
                command: { operation: 'keys', limit: 1 },
                expect: { ok: true },
              },
              {
                kind: 'key-command',
                actor: 'peer',
                command: { operation: 'keys', limit: 1, cursors: { repairs: '000-blocked' } },
                expect: { ok: true },
              },
              {
                kind: 'key-command',
                actor: 'peer',
                command: { operation: 'key-results', limit: 1 },
                expect: { ok: true },
              },
              {
                kind: 'key-command',
                actor: 'peer',
                command: {
                  operation: 'acknowledge-key-result',
                  resultKind: 'repair',
                  resultId: '001-process',
                },
                expect: { ok: true },
              },
              {
                kind: 'key-command',
                actor: 'peer',
                command: {
                  operation: 'acknowledge-key-result',
                  resultKind: 'receive',
                  resultId: receiveId,
                },
                expect: { ok: true },
              },
              {
                kind: 'key-command',
                actor: 'owner',
                command: {
                  operation: 'acknowledge-key-result',
                  resultKind: 'delivery',
                  resultId: deliveryId,
                },
                expect: { ok: true },
              },
            ],
          });
          expect(repairPlan.verdict).toBe('pass');
          expect(
            inspectLabEvidence({ version: 1, syntheticOnly: true, run: repairPlan }).run.verdict
          ).toBe('pass');
          const firstPage = repairPlan.observations[2]!.reply.value as Round;
          expect(firstPage.repairs).toEqual({
            processed: 1,
            blocked: ['000-blocked'],
            next: '000-blocked',
          });
          const nextPage = repairPlan.observations[3]!.reply.value as Round;
          expect(nextPage.repairs).toEqual({ processed: 1, blocked: [], next: null });
          expect(nextPage.repairResults.items).toEqual([
            { id: '001-process', outcome: 'Repaired' },
          ]);
          const read = (actorName: string, store: string, query: string) => {
            const db = new Database(join(f.directory, `${actorName}-${store}.sqlite`), {
              readonly: true,
              fileMustExist: true,
            });
            try {
              return db.prepare(query).all();
            } finally {
              db.close();
            }
          };
          expect(
            read('peer', 'repair', 'SELECT id,phase,consumed FROM repair_tasks ORDER BY id')
          ).toEqual([
            { id: '000-blocked', phase: 'Pending', consumed: 0 },
            { id: '001-process', phase: 'Repaired', consumed: 1 },
          ]);
          expect(
            read(
              'peer',
              'receive',
              "SELECT id,consumed,report IS NOT NULL AS retained FROM receive_tasks WHERE id='" +
                receiveId +
                "'"
            )
          ).toEqual([{ id: receiveId, consumed: 1, retained: 1 }]);
          expect(
            read(
              'owner',
              'send',
              "SELECT id,phase,consumed FROM distribution_tasks WHERE id='" + deliveryId + "'"
            )
          ).toEqual([{ id: deliveryId, phase: 'Observed', consumed: 1 }]);
          const afterAck = yield* b.keyCommand({ operation: 'key-results' });
          expect(afterAck.ok).toBe(true);
          expect(afterAck.value).toMatchObject({ repair: { items: [], next: null } });
          expect((yield* a.keyCommand({ operation: 'keys' })).ok).toBe(true);
          expect((yield* b.keyCommand({ operation: 'keys' })).ok).toBe(true);
          expect((yield* a.call('create', 'loro')).ok).toBe(true);
          expect((yield* a.call('create', 'flock')).ok).toBe(true);
          expect((yield* a.call('append', 'loro', 'OS original')).ok).toBe(true);
          expect((yield* a.call('append', 'flock', 'OS flock')).ok).toBe(true);
          expect((yield* b.call('pull', 'loro')).ok).toBe(true);
          const before = yield* a.call('observe', 'loro');
          expect(before.value).toMatchObject({ text: 'OS original', status: 'active' });
          const killed = yield* a.crash();
          expect(killed.signal).toBe('SIGKILL');
          expect((yield* a.start('open')).ok).toBe(true);
          expect(a.pid()).not.toBe(pid);
          const restored = yield* a.call('observe', 'loro');
          expect(restored.value).toEqual(before.value);
          expect((yield* a.call('observe', 'flock')).value).toMatchObject({ text: 'OS flock' });
          expect((yield* a.call('append', 'loro', ' reopened')).ok).toBe(true);
          expect((yield* a.call('append', 'flock', ' reopened')).ok).toBe(true);
          expect((yield* b.call('pull', 'flock')).ok).toBe(true);
          expect((yield* b.call('observe', 'flock')).value).toMatchObject({
            text: 'OS flock reopened',
          });
          expect((yield* b.call('pull', 'loro')).ok).toBe(true);
          expect((yield* b.call('observe', 'loro')).value).toMatchObject({
            text: 'OS original reopened',
          });
          yield* a.shutdown();
          yield* b.shutdown();
        })
      )
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(['crash', 'shutdown'] as const)(
  'retains the real %s child until its explicit native close notification, independently of elapsed virtual time',
  async (operation) => {
    const root = mkdtempSync(join(tmpdir(), 'lab-native-close-observation-'));
    let child: ChildProcess | undefined;
    let closeReleased = false;
    let delayedClose: (() => void) | undefined;
    const releaseClose = () => {
      closeReleased = true;
      const deliver = delayedClose;
      delayedClose = undefined;
      deliver?.();
    };
    let actualClose: Promise<void> | undefined;
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const nativeClosed = yield* Deferred.make<void>();
            const create = () => {
              child = spawn(
                process.execPath,
                [
                  '-e',
                  `
              process.on('message', (message) => {
                process.send({ id: message.id, ok: true }, () => {
                  if (message.operation === 'close') process.exit(0);
                });
              });
            `,
                ],
                { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
              );
              const native = child;
              const emit = native.emit;
              actualClose = new Promise<void>((resolve) => {
                native.emit = function (event: string | symbol, ...args: unknown[]) {
                  if (event === 'close') {
                    const deliver = () => {
                      Reflect.apply(emit, native, [event, ...args]);
                    };
                    if (closeReleased) deliver();
                    else delayedClose = deliver;
                    Deferred.doneUnsafe(nativeClosed, Effect.void);
                    resolve();
                    return true;
                  }
                  return Reflect.apply(emit, native, [event, ...args]);
                };
              });
              return native;
            };
            const fixture = history();
            // This worker substitutes only the IPC protocol; the process and exit
            // are real. No cryptographic or session behavior is inferred from it.
            const actor = yield* makeLabProcessActor((mode) =>
              Effect.succeed({
                syntheticOnly: true,
                device: 'unused by this IPC-only native owner fixture',
                targets: {},
                initialKeyOwner: false,
                baseUrl: 'http://127.0.0.1:1',
                directory: root,
                actor: 'owner',
                mode,
                genesis: Buffer.from(fixture.anchor.toBytes()).toString('hex'),
                records: fixture.records.map((record) => Buffer.from(record).toString('hex')),
                point: {
                  head: Buffer.from(fixture.checkpoint.head.toBytes()).toString('hex'),
                  length: fixture.checkpoint.length,
                },
              })
            ).pipe(Effect.provideService(LabProcessSpawn, create));
            expect((yield* actor.start('create')).ok).toBe(true);
            const closing = yield* Effect.result(
              operation === 'crash' ? actor.crash() : actor.shutdown()
            ).pipe(Effect.forkChild);
            yield* Deferred.await(nativeClosed);
            expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
            yield* TestClock.adjust('6 seconds');
            expect(closing.pollUnsafe()).toBeUndefined();
            releaseClose();
            expect(Result.isSuccess(yield* Fiber.join(closing))).toBe(true);
          }).pipe(Effect.ensuring(Effect.sync(releaseClose)))
        ).pipe(Effect.provide(TestClock.layer()))
      );
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await actualClose;
      releaseClose();
      rmSync(root, { recursive: true, force: true });
    }
  }
);
