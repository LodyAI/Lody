import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Deferred, Effect, Exit, Fiber } from 'effect';
import { expect, it } from 'vitest';
import { runLabScenario } from '../src/platform/scenario-runner';
import { executeLabActions, type LabAction } from '../src/platform/action-executor';
import { makeLabScenarioFixture } from '../src/platform/scenario-fixture';
import { makeLabAttackTransport } from '../src/platform/attack-transport';
import { makeLabActorProxy } from '../src/platform/attack-proxy';
import { LabProcessSpawn, makeLabProcessActor } from '../src/platform/process-actor';
import { exportDevice } from '../src/platform/device';
const good = { ok: true } as const;
const actors = [
  { id: 'owner', role: 'owner' },
  { id: 'writer', role: 'member' },
] as const;
const prefix: readonly LabAction[] = [
  { kind: 'start', actor: 'owner', mode: 'create', expect: good },
  { kind: 'start', actor: 'writer', mode: 'create', expect: good },
  { kind: 'call', actor: 'owner', operation: 'keys', expect: good },
  { kind: 'call', actor: 'writer', operation: 'keys', expect: good },
  { kind: 'call', actor: 'owner', operation: 'create', document: 'loro', expect: good },
  { kind: 'call', actor: 'writer', operation: 'pull', document: 'loro', expect: good },
];
it('keeps a real append owned across plan phases and records both predictions after a concurrent genuine role change', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-async-model-'));
  try {
    mkdirSync(join(root, 'baseline'));
    mkdirSync(join(root, 'race'));
    // Discover the exact next native request from a real unchanged prefix. This
    // avoids a timer or assuming how many key-round control reads occur.
    const baseline = await Effect.runPromise(
      runLabScenario({ directory: join(root, 'baseline'), actors, actions: prefix })
    );
    const reads = baseline.measurements.transport.events.filter(
      (row) => row.actor === 'writer' && row.stream === 'control' && row.method === 'GET'
    );
    const target = {
      actor: 'writer',
      stream: 'control' as const,
      method: 'GET' as const,
      occurrence: reads.at(-1)!.occurrence + 1,
    };
    const result = await Effect.runPromise(
      runLabScenario({
        directory: join(root, 'race'),
        actors,
        actions: [
          ...prefix,
          {
            kind: 'transport',
            actor: 'owner',
            action: { kind: 'intercept', target, mutation: { kind: 'delay' } },
            expect: good,
          },
          {
            kind: 'begin-call',
            actor: 'writer',
            id: 'held-append',
            operation: 'append',
            document: 'loro',
            text: 'must-not-reach-backend',
            expect: good,
          },
          {
            kind: 'transport',
            actor: 'owner',
            action: { kind: 'wait-response', target },
            expect: good,
          },
          {
            kind: 'call',
            actor: 'owner',
            operation: 'set-role',
            target: 'writer',
            role: 'guest',
            expect: { ok: true, outcome: 'Committed' },
          },
          { kind: 'call', actor: 'owner', operation: 'acknowledge', expect: good },
          {
            kind: 'transport',
            actor: 'owner',
            action: { kind: 'release-delay', target },
            expect: good,
          },
          {
            kind: 'join-call',
            actor: 'writer',
            id: 'held-append',
            expect: { ok: false, refusal: { tag: 'LabContentError', code: 'unauthorized' } },
          },
          { kind: 'call', actor: 'owner', operation: 'pull', document: 'loro', expect: good },
          {
            kind: 'call',
            actor: 'owner',
            operation: 'observe',
            document: 'loro',
            expect: { ok: true, text: '' },
          },
        ],
      })
    );
    const joined = result.measurements.modelMeasurements[12]!;
    expect(joined.concurrent?.action).toMatchObject({
      actor: 'writer',
      kind: 'call',
      operation: 'append',
    });
    expect(joined.concurrent?.before.expected).toBe('allow');
    expect(joined.concurrent?.atJoin.expected).toBe('deny');
    expect(joined.concurrent?.beforePoint.length).toBe(2);
    expect(joined.concurrent?.joinPoint.length).toBe(3);
    expect(joined.verdict).toBe('unavailable');
    expect(result.run.observations[12]!.integrity).toBe('pass');
    expect(result.run.observations[14]!.durability).toBe('pass');
    expect(result.measurements.transport.hits).toContainEqual({
      id: JSON.stringify(['writer', 'control', 'GET', target.occurrence]),
      kind: 'delay',
    });
    expect(
      result.measurements.transport.events.some(
        (row) => row.actor === 'writer' && row.stream === 'loro' && row.method === 'POST'
      )
    ).toBe(false);
    expect(result.originals).toHaveLength(3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(['stop', 'interrupt'] as const)(
  'joins the actual child close and native HTTP/SQLite owners when %s occurs during a held call',
  async (method) => {
    const root = mkdtempSync(join(tmpdir(), 'lab-call-cancel-'));
    let childClosed = false,
      databaseClosed = false,
      pid: number | undefined,
      proxyUrl = '';
    const originalClose = Database.prototype.close;
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* makeLabScenarioFixture(join(root, 'fixture'));
            Database.prototype.close = function () {
              if (this.name === join(f.directory, 'credentials.sqlite')) databaseClosed = true;
              return originalClose.call(this);
            };
            const transport = yield* makeLabAttackTransport({
              origin: f.host.baseUrl,
              genesis: f.genesis,
            });
            const proxy = yield* makeLabActorProxy({
              origin: f.host.baseUrl,
              fetch: transport.fetchFor('owner'),
            });
            proxyUrl = proxy.baseUrl;
            const device = yield* exportDevice(f.owner),
              spawnNative = yield* LabProcessSpawn;
            const actor = yield* makeLabProcessActor((mode) =>
              Effect.sync(() => ({
                syntheticOnly: true as const,
                device,
                targets: {},
                initialKeyOwner: true,
                baseUrl: proxy.baseUrl,
                directory: f.directory,
                actor: 'owner',
                mode,
                genesis: Buffer.from(f.genesis.toBytes()).toString('hex'),
                records: f.records.map((record) => Buffer.from(record).toString('hex')),
                point: {
                  head: Buffer.from(f.point().head.toBytes()).toString('hex'),
                  length: f.point().length,
                },
              }))
            ).pipe(
              Effect.provideService(LabProcessSpawn, () => {
                const child = spawnNative();
                child.once('close', () => {
                  childClosed = true;
                });
                return child;
              })
            );
            expect((yield* actor.start('create')).ok).toBe(true);
            pid = actor.pid();
            const target = {
              actor: 'owner',
              stream: 'control' as const,
              method: 'GET' as const,
              occurrence: 1,
            };
            yield* transport.apply({ kind: 'intercept', target, mutation: { kind: 'delay' } });
            const stopped = yield* Deferred.make<void>();
            const running = yield* executeLabActions({
              actors: { owner: actor },
              maxSteps: 10,
              stop: Deferred.await(stopped),
              actions: [
                {
                  kind: 'begin-call',
                  actor: 'owner',
                  id: 'held',
                  operation: 'refresh',
                  expect: good,
                },
                { kind: 'join-call', actor: 'owner', id: 'held', expect: good },
              ],
            }).pipe(Effect.exit, Effect.forkChild);
            const observed = yield* transport.waitForEvent(target);
            expect(observed.source).toBe('native');
            expect(observed.status).toBe(200);
            expect(childClosed).toBe(false);
            expect(databaseClosed).toBe(false);
            if (method === 'stop') {
              yield* Deferred.succeed(stopped, undefined);
              const outcome = yield* Fiber.join(running);
              expect(Exit.isFailure(outcome)).toBe(true);
              if (Exit.isFailure(outcome))
                expect(
                  outcome.cause.reasons.some(
                    (reason) =>
                      reason._tag === 'Fail' &&
                      (reason.error as { code?: string }).code === 'stopped'
                  )
                ).toBe(true);
            } else yield* Fiber.interrupt(running);
            expect(childClosed).toBe(true);
            expect(actor.pid()).toBeUndefined();
            expect(() => process.kill(pid!, 0)).toThrow();
            // The external response gate is still held. Parent cleanup aborts and
            // joins that native proxy before the earlier actual credential SQLite owner.
          })
        )
      );
      expect(childClosed).toBe(true);
      expect(databaseClosed).toBe(true);
      await expect(fetch(`${proxyUrl}/healthz`)).rejects.toThrow();
    } finally {
      Database.prototype.close = originalClose;
      rmSync(root, { recursive: true, force: true });
    }
  },
  0
);
