import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Deferred, Effect, Exit, Fiber, Result } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'vitest';
import { LabScenarioError, runLabScenario } from '../src/platform/scenario-runner';
import { executeLabActions, inspectLabEvidence } from '../src/platform/action-executor';
import { makeLabScenarioFixture } from '../src/platform/scenario-fixture';
import { LabProcessSpawn, makeLabProcessActor } from '../src/platform/process-actor';
import { exportDevice } from '../src/platform/device';
import type { LabProcessReply } from '../src/platform/process-actor';
it('keeps real offline edits across SIGKILL and flushes them through the finite process action interface', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-offline-actions-'));
  try {
    const artifact = await Effect.runPromise(
      runLabScenario({
        directory: root,
        actions: [
          { kind: 'start', actor: 'owner', mode: 'create', expect: { ok: true } },
          { kind: 'call', actor: 'owner', operation: 'keys', expect: { ok: true } },
          {
            kind: 'call',
            actor: 'owner',
            operation: 'create',
            document: 'loro',
            expect: { ok: true },
          },
          {
            kind: 'call',
            actor: 'owner',
            operation: 'edit-offline',
            document: 'loro',
            text: 'durable offline action',
            expect: { ok: true },
          },
          { kind: 'crash', actor: 'owner', expect: { ok: true } },
          { kind: 'start', actor: 'owner', mode: 'open', expect: { ok: true } },
          {
            kind: 'call',
            actor: 'owner',
            operation: 'flush-offline',
            document: 'loro',
            expect: { ok: true },
          },
          {
            kind: 'call',
            actor: 'owner',
            operation: 'pull',
            document: 'loro',
            expect: { ok: true },
          },
          {
            kind: 'call',
            actor: 'owner',
            operation: 'observe',
            document: 'loro',
            expect: { ok: true, text: 'durable offline action' },
          },
        ],
      })
    );
    expect(artifact.run.verdict).toBe('pass');
    expect(artifact.run.observations.at(-1)!.reply.value).toMatchObject({
      text: 'durable offline action',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('executes all finite kinds on real OS/HPKE/SQLite/SDK actors; bad cipher/storage retain the measured durable pair and lost ACK retries original bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-action-complete-'));
  try {
    const artifact = await Effect.runPromise(runLabScenario({ directory: root }));
    expect(artifact.run.verdict).toBe('pass');
    expect(artifact.run.observations).toHaveLength(39);
    expect(artifact.run.observations[18]!.reply.error).toEqual({
      tag: 'LabContentError',
      code: 'decrypt_failed',
    });
    expect(artifact.run.observations[38]!.reply.ok).toBe(true);
    expect(artifact.measurements.modelMeasurements).toHaveLength(39);
    expect(
      artifact.measurements.modelMeasurements.every(
        (row) => row.prediction.rule !== 'unknown-action'
      )
    ).toBe(true);
    expect(artifact.measurements.modelMeasurements.some((row) => row.verdict === 'violation')).toBe(
      false
    );
    expect(artifact.run.observations[18]!.reply.trace!.cipherChanged).toBeGreaterThan(0);
    expect(artifact.run.observations[32]!.reply.trace!.ackDropped).toBe(1);
    expect(artifact.run.observations[19]!.durability).toBe('pass');
    expect(artifact.run.observations[26]!.reply.ok).toBe(false);
    expect(artifact.run.observations[27]!.durability).toBe('pass');
    expect(artifact.run.observations[35]!.reply.value).toEqual({
      outcome: 'Committed',
      recordHex: artifact.originals[2]!.hex,
    });
    expect(artifact.originals).toHaveLength(3); // resume did not append/re-sign another record
    expect(
      artifact.ciphertext.every((stream) => stream.status === 200 && stream.bodyHex.length > 0)
    ).toBe(true);
    expect(artifact.implementation.releases.effect).toBe('4.0.2');
    expect(artifact.run.coverage.exactCiphertextReplay).toBe('unavailable');
    expect(artifact.measurements.writerMeasurements).toHaveLength(3);
    expect(
      artifact.measurements.writerMeasurements.every(
        (row) => row.expected === 'allow' && row.accepted
      )
    ).toBe(true);
    expect(artifact.measurements.attacks.properties).toContainEqual({
      id: 'confidentiality.backend-plaintext',
      verdict: 'pass',
    });
    expect(artifact.measurements.attacks.properties).toContainEqual({
      id: 'confidentiality.insider-post-exclusion',
      verdict: 'unavailable',
    });
    expect(artifact.report.confidentiality).toBe('unavailable');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it.each(['open', 'close'] as const)(
  'the 120s scenario watchdog awaits every real child and host before a typed harness failure when %s never replies',
  async (stalled) => {
    const root = mkdtempSync(join(tmpdir(), 'lab-action-watchdog-'));
    const children: ChildProcess[] = [];
    const closes: Promise<void>[] = [];
    const exits: { pid: number | undefined; signal: NodeJS.Signals | null }[] = [];
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const blocked = yield* Deferred.make<string, unknown>();
            // Explicit worker-protocol substitution. Both children are real; one
            // announces readiness but never replies to open or graceful close.
            const create = () => {
              const first = children.length === 0;
              const child = spawn(
                process.execPath,
                [
                  '-e',
                  `let baseUrl;
                process.on('message', (message) => {
                  if (message.configuration) baseUrl = message.configuration.baseUrl;
                  if (message.operation === '${stalled}' && ${stalled === 'open' ? !first : first})
                    process.send({ ready: true, baseUrl });
                  else process.send({ id: message.id, ok: true });
                });`,
                ],
                { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
              );
              children.push(child);
              closes.push(
                new Promise<void>((resolve) =>
                  child.once('close', (_code, signal) => {
                    exits.push({ pid: child.pid, signal });
                    resolve();
                  })
                )
              );
              child.on('message', (message) => {
                if (
                  message &&
                  typeof message === 'object' &&
                  'ready' in message &&
                  'baseUrl' in message &&
                  typeof message.baseUrl === 'string'
                )
                  Deferred.doneUnsafe(blocked, Effect.succeed(message.baseUrl));
              });
              return child;
            };
            const scenario = yield* Effect.forkChild(
              Effect.result(
                runLabScenario({
                  directory: root,
                  actions: [
                    { kind: 'start', actor: 'owner', mode: 'create', expect: { ok: true } },
                    { kind: 'start', actor: 'peer', mode: 'create', expect: { ok: true } },
                  ],
                }).pipe(
                  Effect.provideService(LabProcessSpawn, create),
                  Effect.onExit((exit) =>
                    Exit.isFailure(exit) ? Deferred.failCause(blocked, exit.cause) : Effect.void
                  )
                )
              )
            );
            const baseUrl = yield* Deferred.await(blocked);
            expect(children).toHaveLength(2);
            yield* Effect.promise(async () => {
              const response = await fetch(`${baseUrl}/healthz`);
              expect(response.status).toBe(200);
              await response.body?.cancel();
            });
            yield* TestClock.adjust('119 seconds');
            expect(scenario.pollUnsafe()).toBeUndefined();
            expect(exits).toEqual([]);
            yield* TestClock.adjust('1 second');
            const result = yield* Fiber.join(scenario);
            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result)) {
              expect(result.failure).toBeInstanceOf(LabScenarioError);
              expect(result.failure).toMatchObject({ code: 'watchdog' });
            }
            expect(exits).toHaveLength(2);
            expect(exits.every((exit) => exit.signal === 'SIGKILL')).toBe(true);
            for (const child of children) expect(() => process.kill(child.pid!, 0)).toThrow();
            expect(existsSync(join(root, 'evidence.json'))).toBe(false);
            yield* Effect.promise(() => expect(fetch(`${baseUrl}/healthz`)).rejects.toThrow());
          })
        ).pipe(Effect.provide(TestClock.layer()))
      );
    } finally {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await Promise.all(closes);
      rmSync(root, { recursive: true, force: true });
    }
  }
);
it('a known durable-loss defect is measured after actual SIGKILL/reopen, not timeout or a fake boolean', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-action-negative-'));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* makeLabScenarioFixture(join(root, 'fixture'));
          const device = yield* exportDevice(f.owner);
          const config = (mode: 'create' | 'open') =>
            Effect.sync(() => ({
              syntheticOnly: true as const,
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
              actor: 'owner' as const,
              mode,
              genesis: Buffer.from(f.genesis.toBytes()).toString('hex'),
              records: f.records.map((r) => Buffer.from(r).toString('hex')),
              point: {
                head: Buffer.from(f.point().head.toBytes()).toString('hex'),
                length: f.point().length,
              },
            }));
          const actual = yield* makeLabProcessActor(config);
          const defective = {
            ...actual,
            crash: () =>
              actual.crash().pipe(
                Effect.tap(() =>
                  Effect.acquireUseRelease(
                    Effect.sync(
                      () =>
                        new Database(join(f.directory, 'owner-loro.sqlite'), {
                          fileMustExist: true,
                        })
                    ),
                    (db) => Effect.sync(() => db.exec('DELETE FROM lab_document_state')),
                    (db) => Effect.sync(() => db.close())
                  )
                )
              ),
          };
          const result = yield* executeLabActions({
            actors: { owner: defective },
            maxSteps: 20,
            actions: [
              { kind: 'start', actor: 'owner', mode: 'create', expect: { ok: true } },
              {
                kind: 'call',
                actor: 'owner',
                operation: 'create',
                document: 'loro',
                expect: { ok: true },
              },
              {
                kind: 'call',
                actor: 'owner',
                operation: 'append',
                document: 'loro',
                text: 'persist me',
                expect: { ok: true },
              },
              { kind: 'crash', actor: 'owner', expect: { ok: true } },
              { kind: 'start', actor: 'owner', mode: 'open', expect: { ok: true } },
              {
                kind: 'call',
                actor: 'owner',
                operation: 'observe',
                document: 'loro',
                expect: { ok: true, text: 'persist me' },
              },
            ],
          });
          expect(result.observations.at(-1)!.reply.value).toMatchObject({ text: '' });
          expect(result.observations.at(-1)!.durability).toBe('violation');
          expect(result.verdict).toBe('violation');
        })
      )
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('preflights every initial action before any effect, ignores caller map override, and refuses unknown actors/kinds and forward observations', async () => {
  let started = false;
  const actor = {
    start: () =>
      Effect.sync(() => {
        started = true;
        return { ok: true } as LabProcessReply;
      }),
    call: () => Effect.promise(() => Promise.resolve({ ok: true } as LabProcessReply)),
    keyCommand: () => Effect.succeed({ ok: true } as LabProcessReply),
    crash: () => Effect.succeed({ code: null, signal: 'SIGKILL' as const }),
    shutdown: () => Effect.void,
    pid: () => undefined,
    diagnostics: () => '',
  };
  for (const actions of [
    [{ kind: 'new-unknown', actor: 'owner' }],
    [
      {
        kind: 'call',
        actor: 'owner',
        operation: 'pull',
        expect: { ok: false, refusal: { tag: 'LabContentError', code: 'decrypt_failed' } },
      },
    ],
    [{ kind: 'call', actor: 'owner', operation: 'pull', document: 'loro', expect: { ok: false } }],
    [
      {
        kind: 'call',
        actor: 'owner',
        operation: 'append',
        document: 'loro',
        expect: { ok: true },
      },
    ],
    [
      {
        kind: 'call',
        actor: 'owner',
        operation: 'resume',
        expect: { ok: false, outcome: 'Committed' },
      },
    ],
    [
      {
        kind: 'call',
        actor: 'owner',
        operation: 'resume',
        expect: { ok: true, refusal: { tag: 'LabContentError', code: 'decrypt_failed' } },
      },
    ],
    [{ kind: 'start', actor: 'missing', mode: 'create' }],
    [
      {
        kind: 'call',
        actor: 'owner',
        operation: 'observe',
        document: 'loro',
        expect: { ok: true, unchangedFrom: 2 },
      },
    ],
  ]) {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.result(executeLabActions({ actors: { owner: actor }, actions, maxSteps: 10 }))
      )
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result))
      expect(result.failure).toMatchObject({
        _tag: 'LabActionError',
        code: actions[0]!.actor === 'missing' ? 'unknown-actor' : 'invalid-plan',
      });
    expect(started).toBe(false);
    if (actions[0]!.actor !== 'missing')
      expect(() =>
        inspectLabEvidence({
          version: 1,
          syntheticOnly: true,
          run: { observations: actions.map((action) => ({ action, reply: { ok: true } })) },
        })
      ).toThrow();
  }
  const rows: unknown[] = [
    { kind: 'start', actor: 'owner', mode: 'create' },
    { kind: 'bad', actor: 'owner' },
  ];
  Object.defineProperty(rows, 0, {
    get() {
      rows.length = 1;
      return { kind: 'start', actor: 'owner', mode: 'create' };
    },
  });
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.result(executeLabActions({ actors: { owner: actor }, actions: rows, maxSteps: 10 }))
    )
  );
  expect(Result.isFailure(result)).toBe(true);
  expect(started).toBe(false);
  let accessorRead = false;
  for (const [row, object, key] of [
    [{ kind: 'start', actor: 'owner', mode: 'create' }, undefined, 'kind'],
    [{ kind: 'start', actor: 'owner', mode: 'create', expect: {} }, 'expect', 'ok'],
    [
      {
        kind: 'call',
        actor: 'owner',
        operation: 'pull',
        document: 'loro',
        expect: { ok: false, refusal: {} },
      },
      'refusal',
      'code',
    ],
  ] as const) {
    const target =
      object === undefined ? row : object === 'expect' ? row.expect : row.expect.refusal;
    Object.defineProperty(target, key, {
      get() {
        accessorRead = true;
        return 'accessor must not run';
      },
    });
    const rejected = await Effect.runPromise(
      Effect.scoped(
        Effect.result(executeLabActions({ actors: { owner: actor }, actions: [row], maxSteps: 10 }))
      )
    );
    expect(Result.isFailure(rejected)).toBe(true);
  }
  expect(accessorRead).toBe(false);
  expect(started).toBe(false);
  const emptyText = await Effect.runPromise(
    Effect.scoped(
      executeLabActions({
        actors: { owner: actor },
        actions: [
          {
            kind: 'call',
            actor: 'owner',
            operation: 'append',
            document: 'loro',
            text: '',
            expect: { ok: true },
          },
        ],
        maxSteps: 2,
      })
    )
  );
  expect(emptyText.verdict).toBe('pass');
  expect(inspectLabEvidence({ version: 1, syntheticOnly: true, run: emptyText }).run.verdict).toBe(
    'pass'
  );
});

it.each([
  { name: 'wrong text with unchanged actual SQL pair', wrongText: true, changed: false },
  { name: 'correct text with changed actual SQL pair', wrongText: false, changed: true },
  { name: 'correct text with unchanged actual SQL pair', wrongText: false, changed: false },
])(
  'aggregates both durable expectations: $name',
  async ({ wrongText, changed }) => {
    const root = mkdtempSync(join(tmpdir(), 'lab-action-conjunction-'));
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const f = yield* makeLabScenarioFixture(join(root, 'fixture'));
            const device = yield* exportDevice(f.owner);
            const actor = yield* makeLabProcessActor((mode) =>
              Effect.sync(() => ({
                syntheticOnly: true as const,
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
                actor: 'owner' as const,
                mode,
                genesis: Buffer.from(f.genesis.toBytes()).toString('hex'),
                records: f.records.map((record) => Buffer.from(record).toString('hex')),
                point: {
                  head: Buffer.from(f.point().head.toBytes()).toString('hex'),
                  length: f.point().length,
                },
              }))
            );
            let observed = 0;
            // Only the wrong-text negative control projects a defective observation.
            // The OS actor supplies the actual SQL digests; the changed-pair case
            // performs a real additional edit and durable write instead of faking them.
            const measured = {
              ...actor,
              call: (...args: Parameters<typeof actor.call>) =>
                actor.call(...args).pipe(
                  Effect.map((reply) => {
                    if (args[0] === 'observe' && ++observed === 2 && wrongText)
                      return {
                        ...reply,
                        value: { ...(reply.value as object), text: 'wrong observed text' },
                      };
                    return reply;
                  })
                ),
            };
            const result = yield* executeLabActions({
              actors: { owner: measured },
              maxSteps: 20,
              actions: [
                { kind: 'start', actor: 'owner', mode: 'create', expect: { ok: true } },
                {
                  kind: 'call',
                  actor: 'owner',
                  operation: 'create',
                  document: 'loro',
                  expect: { ok: true },
                },
                {
                  kind: 'call',
                  actor: 'owner',
                  operation: 'append',
                  document: 'loro',
                  text: 'expected original',
                  expect: { ok: true },
                },
                {
                  kind: 'call',
                  actor: 'owner',
                  operation: 'observe',
                  document: 'loro',
                  expect: { ok: true, text: 'expected original' },
                },
                ...(changed
                  ? [
                      {
                        kind: 'call',
                        actor: 'owner',
                        operation: 'append',
                        document: 'loro',
                        text: '+',
                        expect: { ok: true },
                      },
                    ]
                  : []),
                {
                  kind: 'call',
                  actor: 'owner',
                  operation: 'observe',
                  document: 'loro',
                  expect: {
                    ok: true,
                    text: changed ? 'expected original+' : 'expected original',
                    unchangedFrom: 3,
                  },
                },
              ],
            });
            const prior = result.observations[3]!.reply.value as { persisted: unknown };
            const last = result.observations.at(-1)!;
            const value = last.reply.value as { persisted: unknown; text: string };
            if (changed) expect(value.persisted).not.toEqual(prior.persisted);
            else expect(value.persisted).toEqual(prior.persisted);
            expect(value.text).toBe(
              wrongText
                ? 'wrong observed text'
                : changed
                  ? 'expected original+'
                  : 'expected original'
            );
            expect(last.checks.text).toBe(wrongText ? 'violation' : 'pass');
            expect(last.checks.unchangedFrom).toBe(changed ? 'violation' : 'pass');
            const verdict = wrongText || changed ? 'violation' : 'pass';
            expect(last.durability).toBe(verdict);
            expect(result.verdict).toBe(verdict);
            const inspected = inspectLabEvidence({ version: 1, syntheticOnly: true, run: result });
            expect(inspected.run.verdict).toBe(verdict);
            expect(inspected.run.observations.at(-1)!.checks).toEqual(last.checks);
          })
        )
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  15000
);

it('preserves ok/outcome failures and missing measurements instead of turning them into passes', async () => {
  for (const { reply, expected, verdict } of [
    {
      reply: { ok: false, value: { outcome: 'Committed' } },
      expected: { ok: true, outcome: 'Committed' },
      verdict: 'harness-error',
    },
    {
      reply: { ok: true, value: { outcome: 'Conflict' } },
      expected: { ok: true, outcome: 'Committed' },
      verdict: 'harness-error',
    },
    {
      reply: { ok: true, value: { outcome: 'Committed' } },
      expected: { ok: true, outcome: 'Committed' },
      verdict: 'pass',
    },
    {
      reply: { ok: true },
      expected: { ok: false, refusal: { tag: 'LabContentError', code: 'decrypt_failed' } },
      verdict: 'violation',
    },
    {
      reply: { ok: false },
      expected: { ok: true, text: 'not observed' },
      verdict: 'harness-error',
    },
    {
      reply: { ok: false, error: { tag: 'LedgerError', code: 'native-unavailable' } },
      expected: { ok: false, refusal: { tag: 'LedgerError', code: 'native-unavailable' } },
      verdict: 'harness-error',
    },
    {
      reply: { ok: true, value: { outcome: 'Conflict' } },
      expected: { ok: true, outcome: 'Conflict' },
      verdict: 'pass',
    },
    { reply: { ok: true }, expected: undefined, verdict: 'unavailable' },
  ]) {
    const actor = {
      start: () => Effect.succeed(reply as LabProcessReply),
      // This reply fixture has the same asynchronous IPC boundary as an actor.
      call: () => Effect.promise(() => Promise.resolve(reply as LabProcessReply)),
      keyCommand: () => Effect.succeed(reply as LabProcessReply),
      crash: () => Effect.succeed({ code: null, signal: 'SIGKILL' as const }),
      shutdown: () => Effect.void,
      pid: () => undefined,
      diagnostics: () => '',
    };
    const result = await Effect.runPromise(
      Effect.scoped(
        executeLabActions({
          actors: { owner: actor },
          maxSteps: 5,
          actions: [{ kind: 'call', actor: 'owner', operation: 'resume', expect: expected }],
        })
      )
    );
    expect(result.verdict).toBe(verdict);
    expect(result.observations[0]!.integrity).toBe(verdict);
    if (expected?.text) expect(result.observations[0]!.checks.text).toBe('harness-error');
    const inspected = inspectLabEvidence({ version: 1, syntheticOnly: true, run: result });
    expect(inspected.run.verdict).toBe(result.verdict);
    expect(inspected.run.observations).toEqual(result.observations);
  }
});

it('requires the exact refusal and never treats input, defect or unrelated transport failure as a security pass', async () => {
  for (const [error, verdict] of [
    [{ tag: 'LabContentError', code: 'decrypt_failed' }, 'pass'],
    [{ tag: 'LabContentError', code: 'transport' }, 'harness-error'],
    [{ tag: 'LabHarnessError', code: 'invalid-input-or-untyped-failure' }, 'harness-error'],
    [undefined, 'harness-error'],
  ] as const) {
    const actor = {
      start: () => Effect.succeed({ ok: true }),
      call: () => Effect.succeed({ ok: false, error }),
      keyCommand: () => Effect.succeed({ ok: false, error }),
      crash: () => Effect.succeed({ code: null, signal: 'SIGKILL' as const }),
      shutdown: () => Effect.void,
      pid: () => undefined,
      diagnostics: () => '',
    };
    const result = await Effect.runPromise(
      Effect.scoped(
        executeLabActions({
          actors: { owner: actor },
          maxSteps: 2,
          actions: [
            {
              kind: 'call',
              actor: 'owner',
              operation: 'pull',
              document: 'loro',
              expect: { ok: false, refusal: { tag: 'LabContentError', code: 'decrypt_failed' } },
            },
          ],
        })
      )
    );
    expect(result.verdict).toBe(verdict);
  }
});

it('inspect recomputes observations instead of trusting stored pass verdicts', () => {
  const artifact = {
    version: 1,
    syntheticOnly: true,
    run: {
      verdict: 'pass',
      observations: [
        {
          action: {
            kind: 'call',
            actor: 'owner',
            operation: 'pull',
            document: 'loro',
            expect: { ok: false, refusal: { tag: 'LabContentError', code: 'decrypt_failed' } },
          },
          reply: { ok: false, error: { tag: 'LabContentError', code: 'transport' } },
          integrity: 'pass',
          checks: { ok: 'pass' },
        },
      ],
    },
  };
  expect(inspectLabEvidence(artifact).run.verdict).toBe('harness-error');
  artifact.run.observations[0]!.reply.error.code = 'decrypt_failed';
  expect(inspectLabEvidence(artifact).run.verdict).toBe('pass');
  expect(() =>
    inspectLabEvidence({ version: 1, syntheticOnly: true, run: { verdict: 'pass' } })
  ).toThrow();
});
