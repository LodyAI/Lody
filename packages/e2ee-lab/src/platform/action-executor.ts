import { Data, Effect, Fiber, Schema, Scope } from 'effect';
import { makeLabRuntime } from './runtime';
import { driveLabPermits } from './driver';
import type { makeLabProcessActor, LabProcessReply } from './process-actor';
import { judgeClientDurability, worstVerdict, type JudgeVerdict } from '../pure/judge';
import type { ScheduleChoice } from '../pure/schedule';
import { LabKeyCommand } from './process-contract';
import { LabStorageMutation } from './storage-attack';
import { LabKeyRoundCursors } from './key-round';
import { LabTransportAttackActionSchema, type makeLabAttackTransport } from './attack-transport';
const Name = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/));
const Text = Schema.String.check(Schema.isMaxLength(4096));
const Index = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Refusal = Schema.Struct({ tag: Text, code: Text });
const Expect = Schema.Struct({
  ok: Schema.Boolean,
  refusal: Schema.optional(Refusal),
  outcome: Schema.optional(Schema.Literals(['Committed', 'Conflict'])),
  text: Schema.optional(Text),
  unchangedFrom: Schema.optional(Index),
});
const Base = { actor: Name, expect: Schema.optional(Expect) };
const Action = Schema.Union([
  Schema.Struct({
    ...Base,
    kind: Schema.Literal('measure'),
    probes: Schema.Array(
      Schema.Literals([
        'insider-post-exclusion',
        'wrong-context',
        'unauthorized-writer',
        'forged-control',
      ])
    ).check(Schema.isMaxLength(4)),
  }),
  Schema.Struct({
    ...Base,
    kind: Schema.Literal('storage'),
    store: Schema.Literals([
      'loro',
      'flock',
      'feed',
      'journal',
      'receive',
      'keys',
      'repair',
      'send',
      'outbox',
      'host-mailbox',
      'host-stagedgroup',
      'host-streams',
    ]),
    mutation: LabStorageMutation,
  }),
  Schema.Struct({
    ...Base,
    kind: Schema.Literal('transport'),
    action: LabTransportAttackActionSchema,
  }),
  Schema.Struct({
    ...Base,
    kind: Schema.Literal('begin-call'),
    id: Name,
    operation: Schema.Literals([
      'pull',
      'refresh',
      'append',
      'flush-offline',
      'rotate-epoch',
      'remove-member-and-rotate',
      'resume-epoch-rotation',
      'upload-snapshot',
    ]),
    target: Schema.optional(Name),
    document: Schema.optional(Schema.Literals(['loro', 'flock'])),
    text: Schema.optional(Text),
  }),
  Schema.Struct({ ...Base, kind: Schema.Literal('join-call'), id: Name }),
  Schema.Struct({ ...Base, kind: Schema.Literal('key-command'), command: LabKeyCommand }),
  Schema.Struct({
    ...Base,
    kind: Schema.Literal('start'),
    mode: Schema.Literals(['create', 'open']),
  }),
  Schema.Struct({
    ...Base,
    kind: Schema.Literal('call'),
    operation: Schema.Literals([
      'keys',
      'refresh',
      'resume',
      'create',
      'append',
      'upload-snapshot',
      'pull',
      'recover',
      'observe',
      'acknowledge',
      'edit-offline',
      'flush-offline',
      'revoke',
      'set-role',
      'rotate-epoch',
      'remove-member-and-rotate',
      'resume-epoch-rotation',
      'acknowledge-epoch-rotation',
      'publish-without-stage',
    ]),
    document: Schema.optional(Schema.Literals(['loro', 'flock'])),
    text: Schema.optional(Text),
    target: Schema.optional(Name),
    role: Schema.optional(Schema.Literals(['admin', 'member', 'guest'])),
  }),
  Schema.Struct({
    ...Base,
    kind: Schema.Literal('persist'),
    document: Schema.Literals(['loro', 'flock']),
  }),
  Schema.Struct({ ...Base, kind: Schema.Literal('crash') }),
  Schema.Struct({
    ...Base,
    kind: Schema.Literal('attack'),
    attack: Schema.Literals([
      'clear',
      'corrupt-loro',
      'drop-control-ack',
      'deny-loro-persist',
      'restore-loro-persist',
    ]),
  }),
]);
export type LabAction = typeof Action.Type;
export const LabActionPlanSchema = Schema.Array(Action).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256)
);
/** A model proposes actions, never verdicts. Its expected outcomes are discarded;
 * the independent oracle and actual property observers decide violations. */
export function captureModelActionPlan(input: unknown): readonly LabAction[] {
  const actions = Schema.decodeUnknownSync(LabActionPlanSchema)(input).map(
    ({ expect: _expect, ...row }) => row as LabAction
  );
  actions.forEach(assertLabActionSemantics);
  return actions;
}
export type LabActionActor = Effect.Success<ReturnType<typeof makeLabProcessActor>>;
export class LabActionError extends Data.TaggedError('LabActionError')<{
  readonly code: 'invalid-plan' | 'unknown-actor' | 'missing-observation';
}> {}
export interface LabActionObservation {
  readonly action: LabAction;
  readonly reply: LabProcessReply;
  readonly integrity: JudgeVerdict;
  readonly durability: JudgeVerdict;
  readonly checks: {
    readonly ok: JudgeVerdict;
    readonly refusal?: JudgeVerdict;
    readonly outcome?: JudgeVerdict;
    readonly text?: JudgeVerdict;
    readonly unchangedFrom?: JudgeVerdict;
  };
}
function assertLabActionSemantics(row: LabAction, index: number) {
  if (
    (row.expect?.unchangedFrom !== undefined && row.expect.unchangedFrom >= index) ||
    (row.kind === 'storage' &&
      (row.store === 'host-streams') !== (row.mutation.stream !== undefined)) ||
    (row.expect?.ok === false &&
      (row.expect.outcome !== undefined || row.expect.refusal === undefined)) ||
    (row.expect?.ok === true && row.expect.refusal !== undefined) ||
    (row.kind === 'call' &&
      ['create', 'append', 'pull', 'recover', 'observe', 'edit-offline', 'flush-offline'].includes(
        row.operation
      ) &&
      row.document === undefined) ||
    (row.kind === 'call' &&
      ['append', 'edit-offline'].includes(row.operation) &&
      row.text === undefined)
  )
    throw new LabActionError({ code: 'invalid-plan' });
}

/** Aggregate independently measured dimensions; absent durable checks add no claim. */
export function summarizeLabActions(
  observations: readonly Pick<LabActionObservation, 'integrity' | 'durability'>[]
) {
  const integrity = worstVerdict(observations.map((row) => row.integrity));
  const durability = worstVerdict(
    observations.filter((row) => row.durability !== 'unavailable').map((row) => row.durability)
  );
  return {
    integrity,
    durability,
    verdict: worstVerdict(durability === 'unavailable' ? [integrity] : [integrity, durability]),
  };
}
/** Own finite plan before effects. Not an unbounded agent/script interpreter:
 * missing actions/actors/observations fail visibly; no re-seal entropy replay.
 * Each actual start/call/persist/crash/attack crosses an Effect scheduler phase.
 * Raw crypto/DB/HTTP occurs only in the actor, not a duplicate core/reference. */
export const executeLabActions = Effect.fn('Lab.executeActions')(function* (input: {
  readonly actors: Readonly<Record<string, LabActionActor>>;
  readonly actions: readonly unknown[];
  readonly sourceIndices?: readonly number[];
  readonly maxSteps: number;
  readonly schedule?: readonly ScheduleChoice[];
  readonly stop?: Effect.Effect<void>;
  /** Run-private factual instrumentation, never an authorization decision or a
   * replacement for the actor. Called after the actual operation settles. */
  readonly measure?: (
    action: Extract<LabAction, { kind: 'measure' }>
  ) => Effect.Effect<unknown, unknown>;
  readonly mutateStorage?: (
    action: Extract<LabAction, { kind: 'storage' }>
  ) => Effect.Effect<unknown, unknown>;
  readonly transport?: Effect.Success<ReturnType<typeof makeLabAttackTransport>>;
  readonly beforeAction?: (action: LabAction, index: number) => Effect.Effect<void, unknown>;
  readonly onObservation?: (observation: LabActionObservation) => Effect.Effect<void, unknown>;
}) {
  const onObservation = input.onObservation;
  const beforeAction = input.beforeAction;
  const actions = yield* Effect.try({
    try: () => {
      const rows = input.actions,
        count = rows.length;
      if (!Array.isArray(rows) || !Number.isSafeInteger(count) || count > 256)
        throw new LabActionError({ code: 'invalid-plan' });
      const own = (value: unknown, keys: readonly string[]) => {
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new LabActionError({ code: 'invalid-plan' });
        const out: Record<string, unknown> = {};
        for (const key of keys) {
          const property = Object.getOwnPropertyDescriptor(value, key);
          if (property && !('value' in property))
            throw new LabActionError({ code: 'invalid-plan' });
          if (property) out[key] = property.value;
        }
        return out;
      };
      const initial: unknown[] = [];
      for (let index = 0; index < count; index++) {
        const property = Object.getOwnPropertyDescriptor(rows, String(index));
        if (!property || !('value' in property)) throw new LabActionError({ code: 'invalid-plan' });
        initial.push(property.value);
      }
      const owned: LabAction[] = [];
      for (const row of initial) {
        const captured = own(row, [
          'kind',
          'actor',
          'mode',
          'operation',
          'document',
          'text',
          'attack',
          'command',
          'expect',
          'action',
          'target',
          'role',
          'id',
          'store',
          'mutation',
          'probes',
        ]);
        if (captured.action !== undefined) {
          const action = own(captured.action, [
            'kind',
            'target',
            'mutation',
            'eventId',
            'actor',
            'stream',
          ]);
          if (action.target !== undefined)
            action.target = own(action.target, ['actor', 'stream', 'method', 'occurrence']);
          if (action.mutation !== undefined) {
            const mutation = own(action.mutation, [
              'kind',
              'eventId',
              'nextOffset',
              'offset',
              'length',
              'status',
              'bodyHex',
              'headers',
            ]);
            if (mutation.headers !== undefined)
              mutation.headers = own(mutation.headers, Object.keys(mutation.headers as object));
            action.mutation = mutation;
          }
          captured.action = action;
        }
        if (captured.probes !== undefined) {
          if (!Array.isArray(captured.probes)) throw new LabActionError({ code: 'invalid-plan' });
          const probeCount = captured.probes.length,
            probes: unknown[] = [];
          if (probeCount > 4) throw new LabActionError({ code: 'invalid-plan' });
          for (let index = 0; index < probeCount; index++) {
            const descriptor = Object.getOwnPropertyDescriptor(captured.probes, String(index));
            if (!descriptor || !('value' in descriptor))
              throw new LabActionError({ code: 'invalid-plan' });
            probes.push(descriptor.value);
          }
          if (captured.probes.length !== probeCount)
            throw new LabActionError({ code: 'invalid-plan' });
          captured.probes = probes;
        }
        if (captured.mutation !== undefined)
          captured.mutation = own(captured.mutation, ['kind', 'table', 'column', 'stream']);
        if (captured.command !== undefined) {
          const command = own(captured.command, [
            'operation',
            'limit',
            'cursors',
            'requestId',
            'rejectedDigest',
            'resultKind',
            'resultId',
          ]);
          if (command.cursors !== undefined)
            command.cursors = own(command.cursors, Object.keys(LabKeyRoundCursors.fields));
          captured.command = command;
        }
        if (captured.expect !== undefined) {
          const expected = own(captured.expect, [
            'ok',
            'refusal',
            'outcome',
            'text',
            'unchangedFrom',
          ]);
          if (expected.refusal !== undefined)
            expected.refusal = own(expected.refusal, ['tag', 'code']);
          captured.expect = expected;
        }
        owned.push(Schema.decodeUnknownSync(Action)(captured));
      }

      return owned;
    },
    catch: () => new LabActionError({ code: 'invalid-plan' }),
  });
  const actors = new Map(
    Object.entries(input.actors).map(([name, actor]) => [
      name,
      Object.freeze({
        start: actor.start.bind(actor),
        call: actor.call.bind(actor),
        keyCommand: actor.keyCommand.bind(actor),
        crash: actor.crash.bind(actor),
      }),
    ])
  );
  if (actions.some((row) => !actors.has(row.actor)))
    return yield* new LabActionError({ code: 'unknown-actor' });
  yield* Effect.try({
    try: () => actions.forEach(assertLabActionSemantics),
    catch: () => new LabActionError({ code: 'invalid-plan' }),
  });
  const runtime = yield* makeLabRuntime({ mode: 'manual', time: 0, fetch });
  const observations: LabActionObservation[] = [];
  const pending = new Map<string, Fiber.Fiber<LabProcessReply, unknown>>();
  // Calls outlive one scheduler phase, while the plan still owns and joins them.
  const callsScope = yield* Effect.acquireRelease(Scope.make(), (scope, exit) =>
    Scope.close(scope, exit)
  );
  const work = Effect.gen(function* () {
    for (const [index, action] of actions.entries()) {
      if (beforeAction) yield* beforeAction(action, index);
      const materialIndex = input.sourceIndices?.[index] ?? index;
      const actor = actors.get(action.actor)!;
      const operation = action.kind === 'call' ? action.operation : action.kind;
      const reply = yield* runtime.phaseEffect(
        action.actor,
        operation,
        'execute',
        Effect.gen(function* () {
          switch (action.kind) {
            case 'measure':
              if (!input.measure) return yield* new LabActionError({ code: 'invalid-plan' });
              return { ok: true, value: yield* input.measure(action) };
            case 'storage':
              if (!input.mutateStorage) return yield* new LabActionError({ code: 'invalid-plan' });
              return { ok: true, value: yield* input.mutateStorage(action) };
            case 'transport':
              if (!input.transport) return yield* new LabActionError({ code: 'invalid-plan' });
              return { ok: true, value: yield* input.transport.apply(action.action) };
            case 'begin-call':
              if (pending.has(action.id))
                return yield* new LabActionError({ code: 'invalid-plan' });
              pending.set(
                action.id,
                yield* Effect.forkIn(
                  actor.call(action.operation, action.document, action.text, {
                    materialIndex,
                    target: action.target,
                  }),
                  callsScope
                )
              );
              return { ok: true };
            case 'join-call': {
              const fiber = pending.get(action.id);
              if (!fiber) return yield* new LabActionError({ code: 'missing-observation' });
              pending.delete(action.id);
              return yield* Fiber.join(fiber);
            }
            case 'key-command':
              return yield* actor.keyCommand(action.command, materialIndex);
            case 'start':
              return yield* actor.start(action.mode, materialIndex);
            case 'call':
              return yield* actor.call(action.operation, action.document, action.text, {
                target: action.target,
                role: action.role,
                materialIndex,
              });
            case 'persist':
              return yield* actor.call('persist', action.document, undefined, { materialIndex });
            case 'attack':
              return yield* actor.call('attack', action.attack, undefined, { materialIndex });
            case 'crash':
              return { ok: true, value: yield* actor.crash() };
            default:
              return yield* new LabActionError({ code: 'invalid-plan' });
          }
        })
      );
      const { integrity, durability, checks } = yield* Effect.try({
        try: () => assessLabAction(action, reply, observations),
        catch: () => new LabActionError({ code: 'missing-observation' }),
      });
      const observation = { action, reply, integrity, durability, checks };
      if (onObservation) yield* onObservation(observation);
      observations.push(observation);
    }
    if (pending.size) return yield* new LabActionError({ code: 'missing-observation' });
    return observations;
  });
  yield* driveLabPermits(runtime, input.schedule ?? 'record', work, {
    maxSteps: input.maxSteps,
    stop: input.stop,
  }).pipe(Effect.onExit((exit) => Scope.close(callsScope, exit)));
  return {
    observations,
    schedule: runtime.permitLog.map((choice) => ({ ...choice, identity: { ...choice.identity } })),
    verdict: summarizeLabActions(observations).verdict,
    coverage: {
      confidentiality: 'unavailable' as const,
      exactCiphertextReplay: 'unavailable' as const,
    },
  };
});

/** Recompute measurements from observations, never their self-reported verdicts. */
export function assessLabAction(
  action: LabAction,
  reply: LabProcessReply,
  observations: readonly Pick<LabActionObservation, 'reply'>[]
) {
  const matched = action.expect ? reply.ok === action.expect.ok : undefined;
  const checks: {
    ok: JudgeVerdict;
    refusal?: JudgeVerdict;
    outcome?: JudgeVerdict;
    text?: JudgeVerdict;
    unchangedFrom?: JudgeVerdict;
  } = {
    ok: !action.expect
      ? 'unavailable'
      : action.expect.ok
        ? matched
          ? 'pass'
          : 'harness-error'
        : reply.ok
          ? 'violation'
          : 'pass',
  };
  if (!reply.ok) {
    const refusal = action.expect?.refusal;
    checks.refusal =
      !reply.error ||
      reply.error.tag === 'LabHarnessError' ||
      reply.error.tag === 'LabProviderError' ||
      reply.error.tag === 'LabActionFailure' ||
      ['internal_error', 'unknown', 'native', 'native-unavailable', 'invalid-plan'].includes(
        reply.error.code
      ) ||
      !refusal ||
      refusal.tag !== reply.error.tag ||
      refusal.code !== reply.error.code
        ? 'harness-error'
        : 'pass';
  }
  if (action.expect?.outcome !== undefined) {
    const value = reply.value as { outcome?: string } | undefined;
    checks.outcome =
      reply.ok && value?.outcome === action.expect.outcome ? 'pass' : 'harness-error';
  }
  if (action.expect?.text !== undefined) {
    const value = reply.value as { text?: unknown } | undefined;
    checks.text = judgeClientDurability({
      observed: reply.ok,
      cursorAheadOfDocument: false,
      lostDurableData: value?.text !== action.expect.text,
    });
  }
  if (action.expect?.unchangedFrom !== undefined) {
    const previous = observations[action.expect.unchangedFrom]?.reply.value as
      | { persisted?: unknown }
      | undefined;
    const value = reply.value as { persisted?: unknown } | undefined;
    if (!previous?.persisted || !value?.persisted)
      throw new LabActionError({ code: 'missing-observation' });
    // Independent snapshot of prior actual durable state; do not call production policy as expected value.
    checks.unchangedFrom = judgeClientDurability({
      observed: reply.ok,
      cursorAheadOfDocument: false,
      lostDurableData: JSON.stringify(previous.persisted) !== JSON.stringify(value.persisted),
    });
  }
  // Preserve every applicable measurement: a later pass cannot erase a
  // violation, harness error or unmeasured result from another condition.
  const integrity = worstVerdict([
    checks.ok,
    ...(checks.refusal === undefined ? [] : [checks.refusal]),
    ...(checks.outcome === undefined ? [] : [checks.outcome]),
  ]);
  const durability = worstVerdict([
    ...(checks.text === undefined ? [] : [checks.text]),
    ...(checks.unchangedFrom === undefined ? [] : [checks.unchangedFrom]),
  ]);

  return { integrity, durability, checks };
}

const Evidence = Schema.Struct({
  version: Schema.Literal(1),
  syntheticOnly: Schema.Literal(true),
  run: Schema.Struct({
    observations: Schema.Array(
      Schema.Struct({
        action: Action,
        reply: Schema.Struct({
          ok: Schema.Boolean,
          value: Schema.optional(Schema.Unknown),
          error: Schema.optional(Refusal),
        }),
      })
    ).check(Schema.isMaxLength(256)),
  }),
});
/** Untrusted artifact consistency check, not authentication or a fresh execution.
 * Stored verdict/checks/report fields are deliberately not used. */
export function inspectLabEvidence(input: unknown) {
  const evidence = Schema.decodeUnknownSync(Evidence)(input);
  const observations: LabActionObservation[] = [];
  for (const { action, reply } of evidence.run.observations) {
    assertLabActionSemantics(action, observations.length);
    observations.push({ action, reply, ...assessLabAction(action, reply, observations) });
  }
  return {
    version: 1,
    syntheticOnly: true,
    verification: 'recomputed-untrusted-observations',
    run: {
      verdict: summarizeLabActions(observations).verdict,
      observations,
    },
  };
}
