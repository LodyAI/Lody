import Database from 'better-sqlite3';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Cause, Deferred, Effect, Exit, Fiber, Result } from 'effect';
import { TestClock } from 'effect/testing';
import { Bytes } from '@lody/e2ee-core';
import { expect, it } from 'vitest';
import { decodeRecord, hashRecordBytes } from '@lody/e2ee-core/protocol';
import { commitEpochKey } from '@lody/e2ee-core/protocol';
import { makeSqliteProtectedEpochKeys } from '@lody/e2ee-core/internal';
import { type EpochStagedGroupKey } from '@lody/e2ee-core/services';
import {
  getCommittedEpochStagingKey,
  obsoleteEpochStagedGroup,
  sameEpochStagedGroup,
} from '@lody/e2ee-core/protocol';
import { executeLabActions } from '../src/platform/action-executor';
import { makeLabActorProxy } from '../src/platform/attack-proxy';
import { makeLabAttackTransport } from '../src/platform/attack-transport';
import { exportDevice } from '../src/platform/device';
import { makeLabHttpIdentity } from '../src/platform/http-identity';
import { makeLabEpochStagingRemote } from '../src/platform/epoch-staging-http';
import { openLabWorkspaceSession } from '../src/platform/full-session';
import { makeLabProcessActor } from '../src/platform/process-actor';
import { makeLabScenarioFixture } from '../src/platform/scenario-fixture';
import { labSyntheticProtector } from '../src/platform/synthetic-protection';
import type { LabActorConfiguration } from '../src/pure/actor-config';
import { awaitProducedEvent } from './native-child';
const ok = Result.getOrThrow;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
type Fixture = Effect.Success<ReturnType<typeof makeLabScenarioFixture>>;
type Transport = Effect.Success<ReturnType<typeof makeLabAttackTransport>>;
const expectRefusal = (result: Result.Result<unknown, unknown>, tag: string, code: string) => {
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) expect(result.failure).toMatchObject({ _tag: tag, code });
};
/** A backend refusal reached through a workspace's staging port: `BackendError` with the Lab error as cause. */
const expectBackendRefusal = (
  result: Result.Result<unknown, unknown>,
  tag: string,
  code: string
) => {
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result))
    expect(result.failure).toMatchObject({
      _tag: 'BackendError',
      reason: code,
      cause: { _tag: tag, code },
    });
};
const actors: readonly LabActorConfiguration[] = [
  { id: 'owner', role: 'owner' },
  { id: 'survivor', role: 'owner', memberOf: 'owner' },
  { id: 'witness', role: 'guest' },
  { id: 'retired', role: 'owner', memberOf: 'owner', behavior: 'revoked-device' },
];
const realActor = Effect.fnUntraced(function* (f: Fixture, actor: string, transport: Transport) {
  const device = yield* exportDevice(f.devices.get(actor)!);
  const proxy = yield* makeLabActorProxy({
    origin: f.host.baseUrl,
    fetch: transport.fetchFor(actor),
  });
  return yield* makeLabProcessActor((mode) =>
    Effect.sync(() => ({
      syntheticOnly: true as const,
      device,
      targets: Object.fromEntries(
        [...f.devices].map(([id, native]) => [
          id,
          {
            signingKey: hex(native.publicKey.toBytes()),
            membership: hex(f.memberships.get(id)!.toBytes()),
          },
        ])
      ),
      initialKeyOwner: actor === f.primary,
      epochRotation: true,
      baseUrl: proxy.baseUrl,
      directory: f.directory,
      actor,
      mode,
      genesis: hex(f.genesis.toBytes()),
      records: f.records.map(hex),
      point: { head: hex(f.point().head.toBytes()), length: f.point().length },
    }))
  );
});
const delayStage = Effect.fnUntraced(function* (transport: Transport, actor: string) {
  const target = { actor, stream: 'stagedgroup' as const, method: 'POST' as const, occurrence: 0 };
  yield* transport.apply({ kind: 'intercept', target, mutation: { kind: 'delay' } });
  // Release before child/proxy cleanup even when an assertion fails while held.
  yield* Effect.addFinalizer(() =>
    transport.apply({ kind: 'release-delay', target }).pipe(Effect.asVoid, Effect.orDie)
  );
  return target;
});
const candidate = (f: Fixture, actor: string) => {
  const db = new Database(join(f.directory, `${actor}-rotation.sqlite`), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return db
      .prepare(
        'SELECT epoch,commitment,record,envelopes,blob,outcome FROM epoch_rotation_candidates WHERE consumed=0'
      )
      .get() as {
      epoch: number;
      commitment: Uint8Array;
      record: Uint8Array;
      envelopes: Uint8Array;
      blob: Uint8Array;
      outcome: string | null;
    };
  } finally {
    db.close();
  }
};
const candidateKey = (f: Fixture, row: ReturnType<typeof candidate>): EpochStagedGroupKey => ({
  genesis: hex(f.genesis.toBytes()),
  epoch: row.epoch,
  commitment: hex(row.commitment),
  recordHash: hex(hashRecordBytes(row.record).toBytes()),
});
const installedEpochs = (f: Fixture, actor: string) => {
  const db = new Database(join(f.directory, `${actor}-keys.sqlite`), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return (
      db.prepare('SELECT epoch FROM installed_epoch_keys ORDER BY epoch').all() as {
        epoch: number;
      }[]
    ).map((row) => row.epoch);
  } finally {
    db.close();
  }
};

it('hard-kills after HTTP staging but before CAS, resumes exact originals, then survives permanent publisher destruction after commit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-staged-publisher-crashes-'));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* makeLabScenarioFixture(join(root, 'fixture'), actors);
          const transport = yield* makeLabAttackTransport({
            origin: f.host.baseUrl,
            genesis: f.genesis,
            maxEvents: 1024,
          });
          const publisher = yield* realActor(f, 'owner', transport);
          expect((yield* publisher.start('create')).ok, publisher.diagnostics()).toBe(true);
          expect(f.view().inspectState().epoch.rotationRequired).toBe(true);
          const before = f.point();
          const target = yield* delayStage(transport, 'owner');
          const pending = yield* Effect.result(publisher.call('rotate-epoch')).pipe(
            Effect.forkChild
          );
          const staged = yield* awaitProducedEvent(transport.waitForEvent(target), pending);
          expect(staged.status).toBe(200);
          const original = candidate(f, 'owner');
          const key = candidateKey(f, original);
          const group = yield* f.staging.readGroup(key);
          expect(group).not.toBeNull();
          expect(group!.envelopes.map((row) => row.recipient).sort()).toEqual(
            [...f.view().inspectState().devices.keys()].sort()
          );
          expect(f.point().head.equals(before.head)).toBe(true);
          expect(f.point().length).toBe(before.length);
          expect(installedEpochs(f, 'owner')).toEqual([0]);
          const oldPid = publisher.pid();
          expect((yield* publisher.crash()).signal).toBe('SIGKILL');
          expectRefusal(yield* Fiber.join(pending), 'LabProcessError', 'child-exited');
          yield* transport.apply({ kind: 'release-delay', target });
          expect((yield* publisher.start('open')).ok, publisher.diagnostics()).toBe(true);
          expect(publisher.pid()).not.toBe(oldPid);
          const resumed = yield* publisher.call('resume-epoch-rotation');
          expect(resumed, publisher.diagnostics()).toMatchObject({
            ok: true,
            value: { outcome: 'Committed', epoch: 1, recordHex: hex(original.record) },
          });
          const retained = candidate(f, 'owner');
          expect(retained.envelopes).toEqual(original.envelopes);
          expect(retained.blob).toEqual(original.blob);
          expect(sameEpochStagedGroup(group!, (yield* f.staging.readGroup(key))!)).toBe(true);
          expect(f.point().length).toBe(before.length + 1);
          expect((yield* publisher.call('create', 'loro')).ok).toBe(true);
          expect(
            (yield* publisher.call('append', 'loro', 'committed before publisher loss')).ok
          ).toBe(true);
          expect((yield* publisher.crash()).signal).toBe('SIGKILL');
          // Only remote ciphertext/control remain accessible to the surviving child.
          for (const file of readdirSync(f.directory).filter((entry) => entry.startsWith('owner-')))
            rmSync(join(f.directory, file));
          const survivor = yield* realActor(f, 'survivor', transport);
          expect((yield* survivor.start('create')).ok, survivor.diagnostics()).toBe(true);
          expect(installedEpochs(f, 'survivor')).toEqual([]);
          const keys = yield* survivor.call('keys');
          expect(keys, survivor.diagnostics()).toMatchObject({ ok: true });
          expect(installedEpochs(f, 'survivor')).toContain(1);
          expect((yield* survivor.call('pull', 'loro')).ok).toBe(true);
          expect((yield* survivor.call('observe', 'loro')).value).toMatchObject({
            text: 'committed before publisher loss',
            status: 'active',
          });
          expect(sameEpochStagedGroup(group!, (yield* f.staging.readGroup(key))!)).toBe(true);
          yield* survivor.shutdown();
        })
      )
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('stages concurrent genuine management candidates through HTTP, commits one, ignores the loser, and conditionally deletes only its group', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-staged-competing-managers-'));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* makeLabScenarioFixture(join(root, 'fixture'), actors);
          const transport = yield* makeLabAttackTransport({
            origin: f.host.baseUrl,
            genesis: f.genesis,
            maxEvents: 1024,
          });
          const first = yield* realActor(f, 'owner', transport),
            second = yield* realActor(f, 'survivor', transport);
          expect((yield* first.start('create')).ok).toBe(true);
          expect((yield* second.start('create')).ok).toBe(true);
          expect((yield* first.call('keys')).ok).toBe(true);
          expect((yield* second.call('keys')).ok).toBe(true);
          const witnessInput = f.input('witness', 'create');
          const witness = yield* openLabWorkspaceSession(witnessInput);
          const before = f.point();
          const targetA = yield* delayStage(transport, 'owner'),
            targetB = yield* delayStage(transport, 'survivor');
          const a = yield* first.call('rotate-epoch').pipe(Effect.forkChild),
            b = yield* second.call('rotate-epoch').pipe(Effect.forkChild);
          expect((yield* awaitProducedEvent(transport.waitForEvent(targetA), a)).status).toBe(200);
          expect((yield* awaitProducedEvent(transport.waitForEvent(targetB), b)).status).toBe(200);
          const losing = candidate(f, 'survivor'),
            loserKey = candidateKey(f, losing);
          const winning = candidate(f, 'owner'),
            winnerKey = candidateKey(f, winning);
          expect(winnerKey.commitment).not.toBe(loserKey.commitment);
          expect(yield* f.staging.readGroup(winnerKey)).not.toBeNull();
          expect(yield* f.staging.readGroup(loserKey)).not.toBeNull();
          expect(f.point().length).toBe(before.length);
          expect(yield* witness.receiveCommittedEpoch()).toEqual({
            staged: false,
            installed: false,
          });
          expect(installedEpochs(f, 'witness')).toEqual([]);
          expectBackendRefusal(
            yield* Effect.result(
              witness.epochStaging.deleteGroup(loserKey, {
                epoch: 1,
                commitment: winnerKey.commitment,
              })
            ),
            'LabEpochStagingHttpError',
            'unauthorized'
          );
          expect(yield* f.staging.readGroup(loserKey)).not.toBeNull();
          yield* transport.apply({ kind: 'release-delay', target: targetA });
          const committed = yield* Fiber.join(a);
          expect(committed, first.diagnostics()).toMatchObject({
            ok: true,
            value: { outcome: 'Committed', epoch: 1, recordHex: hex(winning.record) },
          });
          expect(yield* witness.receiveCommittedEpoch()).toEqual({ staged: true, installed: true });
          const view = (yield* witness.current()).view;
          expect(ok(getCommittedEpochStagingKey(view, 1)).recordHash).toBe(winnerKey.recordHash);
          const stored = yield* makeSqliteProtectedEpochKeys({
            path: witnessInput.keys.keyStore.path,
            mode: 'open',
            genesis: f.genesis,
            recipient: f.devices.get('witness')!.publicKey,
            ledger: f.ledger,
            protector: labSyntheticProtector,
          });
          const actual = yield* stored.read(1);
          expect(hex(ok(commitEpochKey(f.genesis, 1, actual)).toBytes())).toBe(
            winnerKey.commitment
          );
          yield* transport.apply({ kind: 'release-delay', target: targetB });
          const conflict = yield* Fiber.join(b);
          expect(conflict, second.diagnostics()).toMatchObject({
            ok: true,
            value: { outcome: 'Conflict', epoch: 1, recordHex: hex(losing.record) },
          });
          const conflictPlan = yield* executeLabActions({
            actors: { survivor: second },
            maxSteps: 4,
            actions: [
              {
                kind: 'call',
                actor: 'survivor',
                operation: 'resume-epoch-rotation',
                expect: { ok: true, outcome: 'Conflict' },
              },
            ],
          });
          expect(conflictPlan.verdict).toBe('pass');
          expect(conflictPlan.observations[0]!.checks.outcome).toBe('pass');
          expect(candidate(f, 'survivor').blob).toHaveLength(0);
          expect(installedEpochs(f, 'survivor')).toEqual([0]);
          expect(f.point().length).toBe(before.length + 1);
          expectBackendRefusal(
            yield* Effect.result(
              witness.epochStaging.deleteGroup(winnerKey, {
                epoch: 1,
                commitment: loserKey.commitment,
              })
            ),
            'LabEpochStagingHttpError',
            'unauthorized'
          );
          // Another active personal device in the same Owner membership is not
          // the original publisher. A genuine occupied tuple cannot authorize it.
          const otherIdentity = yield* makeLabHttpIdentity({
            baseUrl: f.host.baseUrl,
            genesis: f.genesis,
          });
          const otherAuth = yield* otherIdentity.authenticate(f.devices.get('owner')!);
          const otherRemote = yield* makeLabEpochStagingRemote({
            url: `${f.host.baseUrl}/v1/spaces/${hex(f.genesis.toBytes())}/epoch-staging`,
            fetch: otherAuth.fetch,
          });
          expectRefusal(
            yield* Effect.result(
              otherRemote.deleteGroup(loserKey, ok(obsoleteEpochStagedGroup(view, loserKey)))
            ),
            'LabEpochStagingHttpError',
            'unauthorized'
          );
          expect(yield* f.staging.readGroup(loserKey)).not.toBeNull();
          const publisherIdentity = yield* makeLabHttpIdentity({
            baseUrl: f.host.baseUrl,
            genesis: f.genesis,
          });
          const publisherAuth = yield* publisherIdentity.authenticate(f.devices.get('survivor')!);
          const publisherRemote = yield* makeLabEpochStagingRemote({
            url: `${f.host.baseUrl}/v1/spaces/${hex(f.genesis.toBytes())}/epoch-staging`,
            fetch: publisherAuth.fetch,
          });
          yield* publisherRemote.deleteGroup(
            loserKey,
            ok(obsoleteEpochStagedGroup(view, loserKey))
          );
          expect(yield* f.staging.readGroup(loserKey)).toBeNull();
          expect(yield* f.staging.readGroup(winnerKey)).not.toBeNull();
          const events = yield* transport.events();
          expect(
            events.filter(
              (event) =>
                event.actor === 'survivor' && event.stream === 'control' && event.method === 'POST'
            )
          ).toHaveLength(0);
          yield* first.shutdown();
          yield* second.shutdown();
        })
      )
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('uses one genuine atomic removal publication and stages only its active poststate devices over HTTP', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-staged-atomic-removal-'));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const configuration: readonly LabActorConfiguration[] = [
            ...actors,
            { id: 'guest-recovery', role: 'guest', kind: 'recovery', memberOf: 'witness' },
          ];
          const f = yield* makeLabScenarioFixture(join(root, 'fixture'), configuration);
          const owner = yield* openLabWorkspaceSession({
            ...f.input('owner', 'create'),
            epochRotation: {
              path: join(f.directory, 'owner-rotation.sqlite'),
              mode: 'create',
              protector: labSyntheticProtector,
            },
          });
          const survivor = yield* openLabWorkspaceSession(f.input('survivor', 'create'));
          const removed = yield* openLabWorkspaceSession(f.input('witness', 'create'));
          const before = f.point();
          const publication = yield* owner.removeMemberAndRotate(f.memberships.get('witness')!);
          expect(publication).toMatchObject({ outcome: 'Committed', epoch: 1 });
          expect(f.point().length).toBe(before.length + 1);
          const decoded = ok(decodeRecord(publication.record));
          expect(decoded.body.type === 'ordinary' && decoded.body.operation.type).toBe(
            'removeMemberAndPublishEpoch'
          );
          const after = (yield* owner.current()).view;
          expect(
            after.inspectState().members.has(hex(f.memberships.get('witness')!.toBytes()))
          ).toBe(false);
          expect(after.inspectState().epoch.rotationRequired).toBe(false);
          const key = ok(getCommittedEpochStagingKey(after, 1));
          const group = yield* owner.epochStaging.readGroup(key);
          expect(group!.envelopes.map((row) => row.recipient).sort()).toEqual(
            [...after.inspectState().devices.keys()].sort()
          );
          for (const id of ['witness', 'guest-recovery'])
            expect(group!.envelopes.map((row) => row.recipient)).not.toContain(
              hex(f.devices.get(id)!.publicKey.toBytes())
            );
          expect(yield* survivor.receiveCommittedEpoch()).toEqual({
            staged: true,
            installed: true,
          });
          expect(installedEpochs(f, 'survivor')).toEqual([1]);
          const refused = yield* Effect.result(removed.receiveCommittedEpoch());
          expectBackendRefusal(refused, 'LabEpochStagingHttpError', 'unauthorized');
          expect(yield* owner.epochStaging.readGroup(key)).toEqual(group);
          expect(installedEpochs(f, 'witness')).toEqual([]);
        })
      )
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('observes a staged response after virtual time advances, and diagnoses an ended producer instead of waiting for a guessed deadline', async () => {
  const entered = Deferred.makeUnsafe<void>(),
    release = Deferred.makeUnsafe<void>();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const genesis = ok(Bytes.genesisHash(new Uint8Array(32).fill(215)));
        const transport = yield* makeLabAttackTransport({
          origin: 'http://127.0.0.1:1',
          genesis,
          fetch: async () => {
            Deferred.doneUnsafe(entered, Effect.void);
            await Effect.runPromise(Deferred.await(release));
            return new Response('staged', { status: 200 });
          },
        });
        const target = {
          actor: 'owner',
          stream: 'stagedgroup' as const,
          method: 'POST' as const,
          occurrence: 0,
        };
        const request = transport.fetchFor('owner');
        const producer = yield* Effect.tryPromise({
          try: async () => {
            const response = await request(
              `http://127.0.0.1:1/ds/${hex(genesis.toBytes())}/epoch-staging`,
              { method: 'POST' }
            );
            await response.body?.cancel();
          },
          catch: (cause) => cause,
        }).pipe(Effect.forkChild);
        const observing = yield* awaitProducedEvent(transport.waitForEvent(target), producer).pipe(
          Effect.forkChild
        );
        yield* Deferred.await(entered);
        yield* TestClock.adjust('6 seconds');
        expect(observing.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.join(observing)).status).toBe(200);
        yield* Fiber.join(producer);

        const ended = yield* Effect.fail(
          new Error('synthetic producer ended before dispatch')
        ).pipe(Effect.forkChild);
        const missing = yield* Effect.exit(
          awaitProducedEvent(transport.waitForEvent({ ...target, occurrence: 1 }), ended)
        );
        expect(Exit.isFailure(missing)).toBe(true);
        if (Exit.isFailure(missing))
          expect(Cause.pretty(missing.cause)).toContain(
            'Lab test producer ended before its required event'
          );
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
    ).pipe(Effect.provide(TestClock.layer()))
  );
});
