import { publicActivity } from './control/activities';
import { observeCapacity } from './sources/capacity';
import { hasUnresolvedToolEffects, reconcileSessionTurnsLegacy } from './sources/sessions-legacy';
import type { SessionAutomationObservation } from '@/session/automation-observations';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import { OrchestrationConnection } from '../orchestration/platform/database';
import { classifyCapacityFailure } from '@/session/acp-error-classification';
import type { RateLimitsSnapshot } from 'acp-extension-core';
import { retainsAutomationGrant } from './actions/authorization';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Clock, Deferred, Effect, Layer, Fiber } from 'effect';
import type {
  AutomationEvent,
  AutomationRuleDraft,
  CapacityObservation,
} from '@lody/shared/automations';
import { AutomationLedger, automationIdentity } from './storage/ledger';
import { configureSessionPolicies, internalPolicy } from './policies/session';
import { evaluateCapacity } from './runtime/capacity';
import { Automations, AutomationHost } from './runtime/engine';
import { evaluateAutomationProgram as evaluateProgram } from './programs/codemode';
import { observePullRequests } from './sources/pull-requests';
import type { SessionId, SessionMeta } from '@lody/shared';

function required<A>(value: A | undefined): A {
  if (value === undefined) throw new Error('Missing fixture value');
  return value;
}

const evaluateAutomationProgram = (
  program: string,
  context: import('@lody/shared/automations').AutomationProgramContext,
  read: (
    input: import('@lody/shared/automations').AutomationReadRequest
  ) => Promise<import('@lody/shared/automations').AutomationReadResponse>
) =>
  Effect.runPromise(
    evaluateProgram(program, context, (input) => Effect.tryPromise(() => read(input)))
  );

const roots: string[] = [];
const stores: AutomationLedger[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const event: AutomationEvent = {
  id: 'run:1:attempt:1',
  source: 'github/repo/owner/project',
  type: 'github.workflow.completed',
  version: 1,
  subject: 'pr/42',
  observedAt: 100,
  scope: { workspaceId: 'workspace', sessionId: 'session' },
  data: { headSha: 'current', conclusion: 'failure' },
  provenance: 'poll',
  completeness: 'observed',
  depth: 0,
};
const draft: AutomationRuleDraft = {
  id: 'rule',
  name: 'CI response',
  scope: { workspaceId: 'workspace' },
  selector: { types: [event.type] },
  enabled: true,
  handler: {
    kind: 'agent',
    invocation: {
      target: { kind: 'existing', sessionId: 'session', onUnavailable: 'blocked' },
      input: { kind: 'external_event', ref: 'event' },
      ifBusy: 'enqueue',
    },
  },
  grants: {
    actions: ['agent.invoke'],
    sessionIds: ['session'],
    agentRoleIds: [],
    bindingIds: [],
    allowLinkedSession: false,
    allowCapacityAttempt: false,
  },
  budget: { maxActionsPerEvent: 10, maxInvocationsPerCorrelation: 2, maxDepth: 4 },
};
const intent = { key: 'step', action: { kind: 'agent.invoke', parameters: {} } };
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lody-automations-'));
  roots.push(root);
  const filename = path.join(root, 'automations.sqlite');
  const open = () => {
    const ledger = new AutomationLedger({ kind: 'disk', path: filename }, 'workspace', 'machine');
    stores.push(ledger);
    return ledger;
  };
  const ledger = open();
  ledger.upsert(draft, 'user', 1);
  return { ledger, open };
}

describe('Automation durability', () => {
  it('activates only the current confirmed failure once when recovery is enabled', () => {
    const { ledger, open } = fixture();
    const work = {
      id: 'capacity-work',
      ownerUserId: 'user',
      updatedAt: 100,
      sessionId: 'session',
      turnId: 'current',
      nativeSessionId: 'native',
      bindingId: 'binding',
      fingerprint: 'config',
      inputRef: 'current',
      confirmedBoundary: 'assistant',
      unresolvedEffects: false,
      release: 'released' as const,
      state: 'blocked_on_capacity' as const,
      attempts: 0,
    };
    ledger.recordWork(work, {
      ...event,
      id: work.id,
      source: 'session/session',
      type: 'provider.quota.exhausted',
      subject: work.id,
      data: { workId: work.id, bindingId: work.bindingId },
    });
    configureSessionPolicies(ledger, 'session', 'user', { recoverCapacity: true }, 101);
    ledger.activateCurrentCapacityFailure('session', 'user', 'newer', 102);
    expect(ledger.deliveries()).toHaveLength(0);
    ledger.activateCurrentCapacityFailure('session', 'user', 'current', 103);
    expect(ledger.deliveries()).toHaveLength(1);
    expect(ledger.deliveries()[0]?.event.data.workId).toBe(work.id);
    ledger.close();
    const reopened = open();
    reopened.activateCurrentCapacityFailure('session', 'user', 'current', 104);
    expect(reopened.deliveries()).toHaveLength(1);
  });

  it('rolls back the recovery setting when activation fails', () => {
    const { ledger } = fixture();
    expect(() =>
      ledger.configureSession(
        () => {
          configureSessionPolicies(ledger, 'session', 'user', { recoverCapacity: true }, 100);
          throw new Error('activation failed');
        },
        'session',
        'user',
        'current',
        100
      )
    ).toThrow('activation failed');
    expect(ledger.rules().some((rule) => rule.name === 'recover-capacity')).toBe(false);
  });
  const fact = (index: number, released = true): SessionAutomationObservation => ({
    sessionId: 'session' as SessionId,
    turnId: `input-${index}`,
    assistantTurnId: `assistant-${index}`,
    userId: 'user',
    inputConfig: {},
    outcome: 'completed',
    released,
    finalized: true,
    observedAt: index,
  });
  const manager = {
    repo: { getDocMeta: async () => ({ meta: { machineId: 'machine', userId: 'user' } }) },
  } as unknown as LoroDocumentManager;

  it('consumes later observations with smaller hashes without restarting or an empty scan', async () => {
    const { ledger } = fixture();
    const facts = [fact(1), fact(2)].sort((a, b) =>
      automationIdentity(b.sessionId, b.assistantTurnId).localeCompare(
        automationIdentity(a.sessionId, a.assistantTurnId)
      )
    );
    for (const outcome of facts) {
      ledger.stageTurn(outcome);
      await reconcileSessionTurnsLegacy(
        ledger,
        manager,
        () => 'normal',
        () => {},
        100
      );
    }
    expect(ledger.sessionEvents('session', -1, 200)).toHaveLength(2);
    expect(ledger.stagedTurns(100)).toEqual([]);
  });

  it('retries pending release and failed reads across restart without starving the next batch', async () => {
    const { ledger, open } = fixture();
    for (let index = 0; index < 101; index++) ledger.stageTurn(fact(index, false));
    const failures: unknown[] = [];
    const report = (cause: unknown) => failures.push(cause);
    await reconcileSessionTurnsLegacy(ledger, manager, () => 'unreleased', report, 100);
    expect(ledger.stagedTurns(100).map((item) => item.fact.turnId)).toEqual(['input-100']);
    await reconcileSessionTurnsLegacy(ledger, manager, () => 'normal', report, 100);
    expect(ledger.sessionEvents('session', -1, 200).map((observed) => observed.subject)).toEqual([
      'input-100',
    ]);
    ledger.close();
    const recovered = open();
    expect(recovered.stagedTurns(15_099)).toEqual([]);
    const unavailable = {
      repo: {
        getDocMeta: async () => {
          throw new Error('read unavailable');
        },
      },
    } as unknown as LoroDocumentManager;
    await reconcileSessionTurnsLegacy(recovered, unavailable, () => 'normal', report, 15_100);
    expect(failures).toHaveLength(100);
    expect(recovered.stagedTurns(30_099)).toEqual([]);
    await reconcileSessionTurnsLegacy(recovered, manager, () => 'normal', report, 30_100);
    expect(recovered.stagedTurns(30_100)).toEqual([]);
    expect(recovered.sessionEvents('session', -1, 200)).toHaveLength(101);
    expect(
      recovered.sessionEvents('session', -1, 200).some((observed) => observed.subject === 'input-0')
    ).toBe(true);
  });

  it('preserves staged outcomes when upgrading the ledger and wakes refreshed release evidence', () => {
    const { ledger, open } = fixture();
    const location = ledger.location;
    ledger.close();
    const database = new OrchestrationConnection(location);
    database.raw.exec(`DROP TABLE turn_observations;
      CREATE TABLE turn_observations (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      PRAGMA user_version = 1;`);
    const outcome = fact(1, false);
    const id = automationIdentity(outcome.sessionId, outcome.assistantTurnId);
    database.raw
      .prepare('INSERT INTO turn_observations VALUES (?,?)')
      .run(id, JSON.stringify(outcome));
    database.close();
    const recovered = open();
    expect(recovered.stagedTurns(0)).toEqual([{ id, fact: outcome }]);
    recovered.deferTurn(id, 15_000);
    recovered.stageTurn({ ...outcome, released: true });
    recovered.stageTurn(outcome);
    expect(recovered.stagedTurns(1)).toEqual([{ id, fact: { ...outcome, released: true } }]);
  });

  it('commits a polling baseline without fabricating events and freezes later rule revisions', () => {
    const { ledger, open } = fixture();
    ledger.observe(event.source, { revision: 'baseline', observedAt: 10, data: {} }, [event]);
    expect(ledger.deliveries()).toEqual([]);
    ledger.observe(event.source, { revision: 'next', observedAt: 100, data: {} }, [event]);
    ledger.upsert({ ...draft, name: 'changed' }, 'user', 101, 1);
    ledger.close();
    const recovered = open();
    recovered.publish(event);
    const [delivery] = recovered.deliveries();
    expect(recovered.deliveries()).toHaveLength(1);
    expect(delivery?.rule.name).toBe('CI response');
    expect(recovered.checkpoint(event.source)?.revision).toBe('next');
    const receipt = recovered.accept(required(delivery), intent, 102);
    expect(recovered.accept(required(delivery), intent, 103)).toEqual(receipt);
    expect(() =>
      recovered.accept(
        required(delivery),
        { ...intent, action: { ...intent.action, parameters: { changed: true } } },
        104
      )
    ).toThrow('AUTOMATION_IDEMPOTENCY_CONFLICT');
  });

  it('does not route old facts to newly created rules across restart', () => {
    const { ledger, open } = fixture();
    ledger.publish(event);
    ledger.upsert({ ...draft, id: 'later' }, 'user', 120);
    ledger.publish(event);
    expect(ledger.deliveries().map((d) => d.rule.id)).toEqual(['rule']);
    ledger.close();
    const recovered = open();
    recovered.publish(event);
    expect(recovered.deliveries().map((d) => d.rule.id)).toEqual(['rule']);
  });

  it('budgets causally related invocations across events and survives repeated acceptance', () => {
    const { ledger } = fixture();
    for (let index = 0; index < 3; index++)
      ledger.publish({ ...event, id: `run:${index}`, correlationId: 'fix-loop' });
    const deliveries = ledger.deliveries();
    ledger.accept(required(deliveries[0]), intent, 100);
    ledger.accept(required(deliveries[0]), intent, 101);
    ledger.accept(required(deliveries[1]), intent, 102);
    expect(() => ledger.accept(required(deliveries[2]), intent, 103)).toThrow(
      'AUTOMATION_INVOCATION_BUDGET_EXHAUSTED'
    );
    expect(ledger.activities()).toHaveLength(2);
  });

  it('reconciles an effect after a lost acknowledgement without invoking it twice', async () => {
    const { ledger } = fixture();
    ledger.publish(event);
    const acceptedTargets = new Set<string>();
    const host = Layer.succeed(AutomationHost, {
      authorize: () => Effect.succeed({ value: 'yes', reason: 'authorized' }),
      condition: () => Effect.succeed({ value: 'yes', reason: 'current' }),
      prepare: () => Effect.succeed({ state: 'resolved', prepared: {} }),
      submit: (receipt) =>
        Effect.sync(() => {
          if (acceptedTargets.has(receipt.turnId)) throw new Error('duplicate effect');
          acceptedTargets.add(receipt.turnId);
        }).pipe(Effect.andThen(Effect.fail(new Error('ack lost')))),
      reconcile: (receipt) =>
        Effect.succeed({ state: acceptedTargets.has(receipt.turnId) ? 'settled' : 'unknown' }),
      cancel: () => Effect.succeed({ state: 'cancelled' }),
      report: () => Effect.void,
    });
    const layer = Automations.layer(ledger).pipe(Layer.provide(host));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* Automations;
          yield* runtime.pass;
          const receipt = required(ledger.activities()[0]);
          expect(receipt.state).toBe('unknown');
          ledger.update(receipt.id, 'unknown', { retryAt: 0 }, 100);
          yield* runtime.pass;
          expect(ledger.receipt(receipt.id)?.state).toBe('settled');
          expect(acceptedTargets).toEqual(new Set([receipt.turnId]));
        }).pipe(Effect.provide(layer))
      )
    );
  });
});

describe('Capacity evidence', () => {
  it.each([
    [undefined, Number.MAX_SAFE_INTEGER],
    [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER - 1],
  ])('waits for quota evidence with reset estimate %s', async (retryAt, expectedRetryAt) => {
    const { ledger } = fixture();
    configureSessionPolicies(ledger, 'session', 'user', { recoverCapacity: true }, 1);
    const work = {
      id: 'unknown-quota',
      ownerUserId: 'user',
      updatedAt: 1,
      sessionId: 'session',
      turnId: 'input',
      nativeSessionId: 'native',
      bindingId: 'account',
      fingerprint: 'config-version',
      inputRef: 'input',
      confirmedBoundary: 'assistant',
      unresolvedEffects: false,
      release: 'released' as const,
      state: 'blocked_on_capacity' as const,
      attempts: 0,
    };
    ledger.recordWork(work, {
      ...event,
      id: work.id,
      source: 'session/session',
      type: 'provider.quota.exhausted',
      subject: work.id,
      data: {
        workId: work.id,
        bindingId: work.bindingId,
        ...(retryAt === undefined ? {} : { retryAt }),
      },
    });
    const delivery = required(ledger.deliveries().find((item) => item.event.id === work.id));
    const receipt = ledger.accept(delivery, required(internalPolicy(delivery)[0]), 101);
    ledger.finishDelivery(delivery, undefined, 101);
    let submitted = false;
    const host = Layer.succeed(AutomationHost, {
      authorize: () =>
        Effect.succeed({ value: 'unknown' as const, reason: 'capacity_observation_stale' }),
      condition: () => Effect.succeed({ value: 'yes' as const, reason: 'current' }),
      prepare: () => Effect.succeed({ state: 'resolved' as const, prepared: {} }),
      submit: () =>
        Effect.sync(() => {
          submitted = true;
          return { state: 'settled' as const };
        }),
      reconcile: () => Effect.succeed({ state: 'settled' as const }),
      cancel: () => Effect.succeed({ state: 'cancelled' as const }),
      report: () => Effect.void,
    });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* Automations;
          yield* runtime.pass;
          expect(ledger.receipt(receipt.id)).toMatchObject({
            state: 'blocked',
            retryAt: expectedRetryAt,
          });
          expect(submitted).toBe(false);
        }).pipe(Effect.provide(Automations.layer(ledger).pipe(Layer.provide(host))))
      )
    );
  });
  it('keeps an availability wake that arrives while a quota check is in flight', async () => {
    const { ledger } = fixture();
    configureSessionPolicies(ledger, 'session', 'user', { recoverCapacity: true }, 1);
    const work = {
      id: 'race-work',
      ownerUserId: 'user',
      updatedAt: 1,
      sessionId: 'session',
      turnId: 'input',
      nativeSessionId: 'native',
      bindingId: 'account',
      fingerprint: 'config-version',
      inputRef: 'input',
      confirmedBoundary: 'assistant',
      unresolvedEffects: false,
      release: 'released' as const,
      state: 'blocked_on_capacity' as const,
      attempts: 0,
    };
    ledger.recordWork(work, {
      ...event,
      id: work.id,
      source: 'session/session',
      type: 'provider.quota.exhausted',
      subject: work.id,
      data: { workId: work.id, bindingId: work.bindingId },
    });
    const delivery = required(ledger.deliveries().find((item) => item.event.id === work.id));
    const receipt = ledger.accept(delivery, required(internalPolicy(delivery)[0]), 101);
    ledger.finishDelivery(delivery, undefined, 101);
    const entered = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    const submitted = Deferred.makeUnsafe<void>();
    let checks = 0;
    const host = Layer.succeed(AutomationHost, {
      authorize: () =>
        ++checks === 1
          ? Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({
                value: 'no' as const,
                reason: 'capacity_exhausted',
                retryAt: Number.MAX_SAFE_INTEGER,
              })
            )
          : Effect.succeed({ value: 'yes' as const, reason: 'authorized' }),
      condition: () => Effect.succeed({ value: 'yes' as const, reason: 'current' }),
      prepare: () => Effect.succeed({ state: 'resolved' as const, prepared: {} }),
      submit: () =>
        Deferred.succeed(submitted, undefined).pipe(Effect.as({ state: 'settled' as const })),
      reconcile: () => Effect.succeed({ state: 'settled' as const }),
      cancel: () => Effect.succeed({ state: 'cancelled' as const }),
      report: () => Effect.void,
    });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* Automations;
          yield* Deferred.await(entered);
          const now = yield* Clock.currentTimeMillis;
          observeCapacity(
            ledger,
            { bindingId: 'account', fingerprint: 'config-version' },
            {
              fetchedAtEpochSeconds: Math.floor(now / 1000),
              rateLimits: [
                {
                  limitId: 'quota',
                  scope: { providerId: 'provider' },
                  windows: [
                    { usedPercent: 0, windowDurationSeconds: 18000, resetsAtEpochSeconds: null },
                  ],
                },
              ],
            },
            'push',
            now
          );
          yield* runtime.wake;
          yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(submitted);
          yield* runtime.pass;
          expect(ledger.receipt(receipt.id)?.state).toBe('settled');
        }).pipe(
          Effect.provide(Automations.layer(ledger).pipe(Layer.provide(host))),
          Effect.timeout('5 seconds')
        )
      )
    );
  });
  it('wakes only matching quota work on a confirmed available observation, including after restart', () => {
    const { ledger, open } = fixture();
    configureSessionPolicies(ledger, 'session', 'user', { recoverCapacity: true }, 1);
    const work = {
      id: 'quota-work',
      ownerUserId: 'user',
      updatedAt: 1,
      sessionId: 'session',
      turnId: 'input',
      nativeSessionId: 'native',
      bindingId: 'account',
      fingerprint: 'config-version',
      modelId: 'model-a',
      inputRef: 'input',
      confirmedBoundary: 'assistant',
      unresolvedEffects: false,
      release: 'released' as const,
      state: 'blocked_on_capacity' as const,
      attempts: 0,
    };
    ledger.recordWork(work, {
      ...event,
      id: work.id,
      source: 'session/session',
      type: 'provider.quota.exhausted',
      subject: work.id,
      data: { workId: work.id, bindingId: work.bindingId, retryAt: 500000 },
    });
    const delivery = required(ledger.deliveries().find((item) => item.event.id === work.id));
    const receipt = ledger.accept(delivery, required(internalPolicy(delivery)[0]), 101);
    ledger.update(receipt.id, 'accepted', { state: 'blocked', retryAt: 500000 }, 101);
    const overloaded = { ...work, id: 'overloaded-work' };
    ledger.recordWork(overloaded, {
      ...event,
      id: overloaded.id,
      source: 'session/session',
      type: 'provider.model.overloaded',
      subject: overloaded.id,
      data: { workId: overloaded.id, bindingId: overloaded.bindingId, retryAt: 500000 },
    });
    const overloadedDelivery = required(
      ledger.deliveries().find((item) => item.event.id === overloaded.id)
    );
    const overloadedReceipt = ledger.accept(
      overloadedDelivery,
      required(internalPolicy(overloadedDelivery)[0]),
      101
    );
    ledger.update(overloadedReceipt.id, 'accepted', { state: 'blocked', retryAt: 500000 }, 101);
    const snapshot = (usedPercent: number): RateLimitsSnapshot => ({
      fetchedAtEpochSeconds: 100,
      rateLimits: [
        {
          limitId: 'quota',
          scope: { providerId: 'provider', modelId: 'model-a' },
          windows: [{ usedPercent, windowDurationSeconds: 18000, resetsAtEpochSeconds: 500 }],
        },
      ],
    });
    observeCapacity(
      ledger,
      { bindingId: 'account', fingerprint: 'other' },
      snapshot(0),
      'push',
      100000
    );
    expect(ledger.receipt(receipt.id)?.retryAt).toBe(500000);
    observeCapacity(
      ledger,
      { bindingId: 'account', fingerprint: 'config-version' },
      snapshot(100),
      'push',
      100000
    );
    expect(ledger.receipt(receipt.id)?.retryAt).toBe(500000);
    const available = { ...snapshot(0), fetchedAtEpochSeconds: 101 };
    observeCapacity(
      ledger,
      { bindingId: 'account', fingerprint: 'config-version' },
      available,
      'push',
      101000
    );
    expect(ledger.receipt(receipt.id)).toMatchObject({ retryAt: 101000, capacityWakeRevision: 1 });
    expect(ledger.receipt(overloadedReceipt.id)?.retryAt).toBe(500000);
    ledger.close();
    const recovered = open();
    expect(recovered.pending(101000).map((item) => item.id)).toContain(receipt.id);
    observeCapacity(
      recovered,
      { bindingId: 'account', fingerprint: 'config-version' },
      available,
      'push',
      101000
    );
    expect(recovered.receipt(receipt.id)?.capacityWakeRevision).toBe(1);
  });
  const observation: CapacityObservation = {
    bindingId: 'account',
    fingerprint: 'config-version',
    observedAt: 100,
    validUntil: 200,
    source: 'query',
    authentication: 'valid',
    billing: 'valid',
    windows: [
      { id: 'five-hour', usedPercent: 10 },
      { id: 'weekly', usedPercent: 100, resetsAt: 1000 },
    ],
  };
  const binding = { bindingId: 'account', fingerprint: 'config-version' };
  it('keeps weekly exhaustion authoritative after the short window recovers', () => {
    expect(evaluateCapacity(observation, binding, 150)).toEqual({
      value: 'no',
      reason: 'capacity_exhausted',
      retryAt: 1000,
    });
    expect(evaluateCapacity(observation, binding, 1001).value).toBe('unknown');
    expect(
      evaluateCapacity(observation, { ...binding, fingerprint: 'new-account' }, 150).value
    ).toBe('unknown');
    expect(
      evaluateCapacity(
        { ...observation, windows: [{ id: 'weekly', usedPercent: 10 }] },
        binding,
        150
      ).value
    ).toBe('yes');
  });
});

describe('JavaScript conditions', () => {
  const context = { sessionId: 'session', workspaceId: 'workspace', now: 100 };
  it('checks arbitrary state asynchronously and persists one continuation across restart', async () => {
    const { ledger, open } = fixture();
    const program = `async ({ ctx }) => {
      const result = await ctx.read('events');
      if (result.value.status !== 'ready') return false;
      return {resumeText: 'Continue with the result', payload: result.value};
    }`;
    const wait = ledger.registerWait({ program, intervalMs: 1000 }, 'session', 'user', 100);
    expect(ledger.registerWait({ program, intervalMs: 1000 }, 'session', 'user', 101).id).toBe(
      wait.id
    );

    const missing = await evaluateAutomationProgram(program, context, async () => ({
      value: { status: 'waiting' },
      observedAt: 100,
    }));
    const claimed = required(ledger.updateWait(wait.id, 'waiting', { state: 'checking' }, 100));
    expect(ledger.finishWait(claimed, missing, 100)?.state).toBe('waiting');
    expect(ledger.dueWaits(1099)).toEqual([]);
    ledger.close();
    const recovered = open();
    const next = required(recovered.dueWaits(1100)[0]);
    recovered.updateWait(next.id, 'waiting', { state: 'checking' }, 1100);
    const result = await evaluateAutomationProgram(program, context, async () => ({
      value: { status: 'ready' },
      observedAt: 1100,
    }));
    const matched = required(recovered.finishWait(next, result, 1100));
    expect(matched).toMatchObject({
      state: 'matched',
      result: { resumeText: 'Continue with the result', payload: { status: 'ready' } },
    });
    expect(recovered.finishWait(next, result, 1101)).toBeUndefined();
    expect(recovered.activities()).toMatchObject([{ sessionId: 'session', state: 'accepted' }]);
    expect(recovered.activities()).toHaveLength(1);
    recovered.cancelWait(next.id, 1102);
    expect(recovered.rule(next.id)?.enabled).toBe(false);
  });
  it('exposes only explicit tools, bounds CPU and rejects malformed results', async () => {
    const invoke = (program: string) =>
      evaluateAutomationProgram(program, context, async () => {
        throw new Error('No tools needed');
      });
    expect(
      await invoke(`() => {
      if (typeof process !== 'undefined' || typeof require !== 'undefined' || typeof fetch !== 'undefined') throw new Error('host leaked');
      return false;
    }`)
    ).toBe(false);
    await expect(invoke(`() => ({}).constructor.constructor('return this')()`)).rejects.toThrow();
    expect(await invoke('async () => false; // A normal function file\n')).toBe(false);
    const expire = (program: string) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const clock = yield* Clock.Clock;
          const immediateClock: Clock.Clock = {
            monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
            monotonicTimeNanos: clock.monotonicTimeNanos,
            currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
            currentTimeMillis: clock.currentTimeMillis,
            currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
            currentTimeNanos: clock.currentTimeNanos,
            sleep: () => Effect.void,
          };
          return yield* evaluateProgram(program, context, () =>
            Effect.fail('unexpected read')
          ).pipe(Effect.provideService(Clock.Clock, immediateClock));
        })
      );
    await expect(expire('() => { while (true) {} }')).rejects.toThrow('timed out');
    await expect(invoke('async () => true')).rejects.toThrow();
    await expect(invoke('async () => ({resumeText: ""})')).rejects.toThrow();
    await expect(expire('async () => new Promise(() => {})')).rejects.toThrow('timed out');
  });
  it('bounds condition reads and validates returned observations', async () => {
    const read = () => Effect.succeed({ value: null, observedAt: 100 });
    await expect(
      Effect.runPromise(
        evaluateProgram(
          `async ({ctx}) => { for (let i = 0; i < 33; i++) await ctx.read('events'); return false; }`,
          context,
          read
        )
      )
    ).rejects.toThrow();
    await expect(
      Effect.runPromise(
        evaluateProgram(
          `async ({ctx}) => { await ctx.read('events'); return false; }`,
          context,
          () => Effect.succeed({ value: 'x'.repeat(128 * 1024), observedAt: 100 })
        )
      )
    ).rejects.toThrow();
  });
  it('interrupts and joins an in-flight scoped read on cancellation', async () => {
    const entered = Deferred.makeUnsafe<void>();
    let closed = false;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* evaluateProgram(
            `async ({ctx}) => { await ctx.read('events'); return false; }`,
            context,
            () =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(
                  Effect.sync(() => {
                    closed = true;
                  })
                )
              )
          ).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          yield* Fiber.interrupt(fiber);
          expect(closed).toBe(true);
        })
      )
    );
  });
  it('validates a registration without executing its condition or reads', async () => {
    const result = await Effect.runPromise(
      evaluateProgram(
        `async ({ctx}) => { await ctx.read('events'); return false; }`,
        context,
        () => Effect.fail(new Error('unexpected read')),
        true
      )
    );
    expect(result).toBe(false);
    await expect(
      Effect.runPromise(evaluateProgram('this is invalid', context, () => Effect.never, true))
    ).rejects.toThrow();
  });
  it('does not accept a late result after cancellation or expiry', () => {
    const { ledger } = fixture();
    const wait = ledger.registerWait(
      { program: '() => false', intervalMs: 1000, expiresAt: 500 },
      'session',
      'user',
      100
    );
    ledger.updateWait(wait.id, 'waiting', { state: 'checking' }, 100);
    ledger.cancelWait(wait.id, 101);
    expect(ledger.finishWait(wait, { resumeText: 'Late' }, 102)).toBeUndefined();
    const next = ledger.registerWait(
      { program: '() => false', intervalMs: 1000, expiresAt: 500 },
      'session',
      'user',
      102
    );
    ledger.updateWait(next.id, 'waiting', { state: 'checking' }, 102);
    expect(ledger.finishWait(next, { resumeText: 'Late' }, 500)?.state).toBe('expired');
    expect(ledger.activities()).toEqual([]);
  });
});

describe('PR observations', () => {
  it('emits an observed transition once and ignores a late older provider response', () => {
    const { ledger } = fixture();
    ledger.upsert({ ...draft, selector: { types: ['github.pr.merged'] } }, 'user', 2, 1);
    const meta = { id: 'session', machineId: 'machine' } as SessionMeta;
    const pr = {
      number: 42,
      url: 'https://github.com/owner/project/pull/42',
      status: 'open' as const,
      headRefName: 'topic',
      updatedAt: '2026-10-20T10:00:00Z',
      ciState: null,
      mergeState: null,
    };
    observePullRequests(ledger, meta, 'owner/project', [pr], 100);
    observePullRequests(
      ledger,
      meta,
      'owner/project',
      [{ ...pr, status: 'merged', updatedAt: '2026-10-20T11:00:00Z' }],
      200
    );
    observePullRequests(ledger, meta, 'owner/project', [pr], 300);
    observePullRequests(
      ledger,
      meta,
      'owner/project',
      [{ ...pr, status: 'merged', updatedAt: '2026-10-20T11:00:00Z' }],
      400
    );
    expect(ledger.deliveries()).toHaveLength(1);
    expect(ledger.deliveries()[0]?.event.type).toBe('github.pr.merged');
  });
});

describe('Invocation authority', () => {
  it('cannot enlarge accepted target permissions through a later rule revision', () => {
    const { ledger } = fixture();
    ledger.publish(event);
    const receipt = ledger.accept(
      required(ledger.deliveries()[0]),
      {
        key: 'invoke',
        action: {
          kind: 'agent.invoke',
          parameters: {
            target: { kind: 'existing', sessionId: 'other', onUnavailable: 'blocked' },
            input: { kind: 'external_event', ref: 'event' },
          },
        },
      },
      100
    );
    const expanded = ledger.upsert(
      { ...draft, grants: { ...draft.grants, sessionIds: ['session', 'other'] } },
      'user',
      101,
      1
    );
    expect(retainsAutomationGrant(receipt, expanded)).toBe(false);
    expect(
      retainsAutomationGrant(
        {
          ...receipt,
          intent: {
            ...receipt.intent,
            action: {
              kind: 'agent.invoke',
              parameters: {
                target: { kind: 'existing', sessionId: 'session', onUnavailable: 'blocked' },
                input: { kind: 'external_event', ref: 'event' },
              },
            },
          },
        },
        expanded
      )
    ).toBe(true);
  });
});

describe('Recovery evidence and activity inspection', () => {
  it('retains an exhausted weekly window when a later push reports only the short window', () => {
    const { ledger } = fixture();
    const binding = { bindingId: 'config', fingerprint: 'launch' };
    const snapshot = (time: number, weekly: boolean): RateLimitsSnapshot => ({
      fetchedAtEpochSeconds: time,
      rateLimits: [
        {
          scope: { providerId: 'synthetic' },
          limitId: 'account',
          windows: [
            {
              usedPercent: 10,
              windowDurationSeconds: 18000,
              resetsAtEpochSeconds: 1000,
              label: 'short',
            },
            ...(weekly
              ? [
                  {
                    usedPercent: 100,
                    windowDurationSeconds: 604800,
                    resetsAtEpochSeconds: 2000,
                    label: 'weekly',
                  },
                ]
              : []),
          ],
        },
      ],
    });
    observeCapacity(ledger, binding, snapshot(100, true), 'push', 100000);
    observeCapacity(ledger, binding, snapshot(110, false), 'push', 110000);
    expect(evaluateCapacity(ledger.capacity('config'), binding, 110000)).toMatchObject({
      value: 'no',
      reason: 'capacity_exhausted',
    });
    observeCapacity(ledger, binding, snapshot(401, false), 'push', 401000);
    expect(evaluateCapacity(ledger.capacity('config'), binding, 401000)).toMatchObject({
      value: 'unknown',
      reason: 'capacity_window_stale',
    });
    expect(ledger.deliveries()).toEqual([]);
  });
  it('requires structured quota evidence and a confirmed tool boundary', () => {
    expect(
      classifyCapacityFailure({
        code: -32603,
        message: 'model unavailable',
        data: { codexErrorInfo: 'serverOverloaded' },
      })
    ).toBe('provider_overloaded');
    expect(
      classifyCapacityFailure({ code: -32603, message: '429 quota billing limit reached' })
    ).toBeUndefined();
    expect(
      classifyCapacityFailure({
        code: -32603,
        message: 'billing',
        data: { errorKind: 'billing_error' },
      })
    ).toBeUndefined();
    expect(
      classifyCapacityFailure({
        code: -32603,
        message: 'rate limit',
        data: { errorKind: 'rate_limit' },
      })
    ).toBe('rate_limited');
    expect(
      classifyCapacityFailure({
        code: -32603,
        message: "You've hit your session limit · resets 2:30pm (UTC)",
      })
    ).toBe('quota_exhausted');
    expect(hasUnresolvedToolEffects(undefined)).toBe(true);
    expect(hasUnresolvedToolEffects([{ type: 'tool_call', status: 'in_progress' }])).toBe(true);
    expect(hasUnresolvedToolEffects([{ type: 'tool_call', status: 'failed' }])).toBe(true);
    expect(hasUnresolvedToolEffects([{ type: 'tool_call', status: 'completed' }])).toBe(false);
  });
  it('pages handler failures and actions with the same timestamp without leaking another Session', () => {
    const { ledger } = fixture();
    ledger.upsert(
      { ...draft, scope: { workspaceId: 'workspace', sessionId: 'session' } },
      'user',
      2,
      1
    );
    ledger.upsert(
      { ...draft, id: 'other-session', scope: { workspaceId: 'workspace', sessionId: 'other' } },
      'user',
      2
    );
    ledger.publish(event);
    ledger.publish({
      ...event,
      id: 'other-event',
      scope: { workspaceId: 'workspace', sessionId: 'other' },
    });
    const own = ledger.deliveries().find((entry) => entry.rule.id === 'rule');
    if (!own) throw new Error('missing delivery');
    ledger.accept(own, intent, 100);
    ledger.finishDelivery(own, 'handler_failed', 100);
    const first = ledger.activityPage('user', 'session', 1);
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeDefined();
    const second = ledger.activityPage('user', 'session', 1, first.nextCursor);
    expect(second.items).toHaveLength(1);
    expect(first.items[0]?.id).not.toBe(second.items[0]?.id);
    expect([...first.items, ...second.items].map((item) => item.kind).sort()).toEqual([
      'action',
      'handler',
    ]);
    expect([...first.items, ...second.items].find((item) => item.kind === 'handler')).toMatchObject(
      { state: 'failed', reason: 'handler_failed' }
    );
    expect(second.nextCursor).toBeUndefined();
    expect(ledger.activityPage('other-user', undefined, 100).items).toEqual([]);
  });
  it('bounds queued actions while preserving duplicate acceptance and capacity after completion', () => {
    const { ledger } = fixture();
    ledger.upsert({ ...draft, budget: { ...draft.budget, maxPendingActions: 1 } }, 'user', 2, 1);
    ledger.publish(event);
    const delivery = ledger.deliveries()[0];
    if (!delivery) throw new Error('missing delivery');
    const receipt = ledger.accept(delivery, intent, 100);
    expect(ledger.accept(delivery, intent, 101).id).toBe(receipt.id);
    expect(() => ledger.accept(delivery, { ...intent, key: 'second' }, 102)).toThrow(
      'AUTOMATION_QUEUE_BUDGET_EXHAUSTED'
    );
    ledger.update(receipt.id, 'accepted', { state: 'settled' }, 103);
    expect(ledger.accept(delivery, { ...intent, key: 'second' }, 104).state).toBe('accepted');
  });
});

it('cancels a claimed work intent even when input preparation has not finished', () => {
  const { ledger } = fixture();
  ledger.publish(event);
  ledger.putWork({
    id: 'unfinished',
    ownerUserId: 'user',
    updatedAt: 100,
    sessionId: 'session',
    turnId: 'original',
    nativeSessionId: 'native',
    bindingId: 'binding',
    fingerprint: 'config',
    inputRef: 'original',
    confirmedBoundary: 'assistant',
    unresolvedEffects: false,
    release: 'released',
    state: 'blocked_on_capacity',
    attempts: 0,
  });
  const receipt = ledger.accept(
    required(ledger.deliveries()[0]),
    {
      key: 'resume',
      action: {
        kind: 'agent.invoke',
        parameters: {
          target: { kind: 'existing', sessionId: 'session', onUnavailable: 'blocked' },
          input: { kind: 'pending_work', ref: 'unfinished' },
          ifBusy: 'enqueue',
        },
      },
    },
    100
  );
  expect(ledger.claimWork('unfinished', receipt.id)).toBe(true);
  expect(ledger.hasSessionWork('session')).toBe(true);
  ledger.cancel(receipt.id, 101);
  expect(ledger.work('unfinished')?.state).toBe('cancelled');
  expect(ledger.hasSessionWork('session')).toBe(false);
  expect(ledger.claimWork('unfinished', 'other')).toBe(false);
});

it('cancels an invocation without waiting for an unrelated capacity adapter', async () => {
  const { ledger } = fixture();
  ledger.publish(event);
  const delivery = required(ledger.deliveries()[0]);
  const cancel = ledger.accept(delivery, { ...intent, key: 'cancel' }, 100);
  ledger.update(cancel.id, 'accepted', { state: 'queued', retryAt: Number.MAX_SAFE_INTEGER }, 101);
  const slow = ledger.accept(delivery, { ...intent, key: 'slow' }, 100);
  ledger.finishDelivery(delivery);
  const entered = Deferred.makeUnsafe<void>();
  const finish = Deferred.makeUnsafe<void>();
  const host = Layer.succeed(AutomationHost, {
    authorize: (receipt) =>
      receipt.id === slow.id
        ? Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(finish)),
            Effect.as({ value: 'yes' as const, reason: 'available' })
          )
        : Effect.succeed({ value: 'yes', reason: 'authorized' }),
    condition: () => Effect.succeed({ value: 'yes', reason: 'current' }),
    prepare: () => Effect.succeed({ state: 'resolved', prepared: {} }),
    submit: () => Effect.succeed({ state: 'queued' }),
    reconcile: () => Effect.succeed({ state: 'queued' }),
    cancel: () => Effect.succeed({ state: 'cancelled' }),
    report: () => Effect.void,
  });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* Automations;
        yield* Deferred.await(entered);
        yield* runtime.cancel(cancel.id);
        expect(ledger.receipt(cancel.id)?.state).toBe('cancelled');
        expect(ledger.receipt(slow.id)?.state).toBe('accepted');
        yield* Deferred.succeed(finish, undefined);
      }).pipe(Effect.provide(Automations.layer(ledger).pipe(Layer.provide(host))))
    )
  );
});

it.each([
  [
    'superseded',
    { value: 'no', reason: 'workflow_superseded', terminalState: 'superseded' },
    'superseded',
    false,
  ],
  [
    'failed',
    { value: 'no', reason: 'target_unavailable', terminalState: 'failed' },
    'failed',
    false,
  ],
  ['temporarily unavailable', { value: 'unknown', reason: 'source_unavailable' }, 'blocked', false],
  ['revoked guard', { value: 'no', reason: 'expired' }, 'superseded', true],
] as const)(
  'persists %s immediately when admission changes during preparation',
  async (_name, after, state, guard) => {
    const { ledger } = fixture();
    ledger.publish(event);
    const delivery = required(ledger.deliveries()[0]);
    const receipt = ledger.accept(
      delivery,
      { ...intent, ...(guard ? { guard: { kind: 'test.guard', parameters: {} } } : {}) },
      100
    );
    ledger.finishDelivery(delivery);
    let prepared = false;
    const host = Layer.succeed(AutomationHost, {
      authorize: () =>
        Effect.succeed(prepared && !guard ? after : { value: 'yes' as const, reason: 'current' }),
      condition: () =>
        Effect.succeed(prepared && guard ? after : { value: 'yes' as const, reason: 'current' }),
      prepare: () =>
        Effect.sync(() => {
          prepared = true;
          return { state: 'resolved' as const, prepared: {} };
        }),
      submit: () => Effect.succeed({ state: 'queued' }),
      reconcile: () => Effect.succeed({ state: 'queued' }),
      cancel: () => Effect.succeed({ state: 'cancelled' }),
      report: () => Effect.void,
    });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* Automations;
          yield* runtime.pass;
          expect(ledger.receipt(receipt.id)).toMatchObject({
            state,
            reason: guard ? `guard:${after.reason}` : after.reason,
            attempts: 0,
          });
        }).pipe(Effect.provide(Automations.layer(ledger).pipe(Layer.provide(host))))
      )
    );
  }
);

it('keeps private prepared inputs and binding fingerprints out of tool-visible activity', () => {
  const { ledger } = fixture();
  ledger.publish(event);
  const receipt = ledger.accept(required(ledger.deliveries()[0]), intent, 100);
  ledger.update(
    receipt.id,
    'accepted',
    { prepared: { config: { prompt: 'PRIVATE_INPUT', fingerprint: 'credential-derivative' } } },
    101
  );
  ledger.putWork({
    id: 'private-work',
    ownerUserId: 'user',
    updatedAt: 100,
    sessionId: 'session',
    turnId: 'original',
    nativeSessionId: 'native',
    bindingId: 'binding',
    fingerprint: 'credential-derivative',
    inputRef: 'original',
    confirmedBoundary: 'assistant',
    unresolvedEffects: false,
    release: 'released',
    state: 'blocked_on_capacity',
    attempts: 0,
  });
  const visible = ledger.activityPage('user', undefined, 100).items.map(publicActivity);
  expect(visible.find((item) => item.kind === 'work')).toMatchObject({
    state: 'blocked_on_capacity',
    bindingId: 'binding',
  });
  expect(visible.find((item) => item.kind === 'action')).toMatchObject({
    id: receipt.id,
    state: 'accepted',
  });
  expect(JSON.stringify(visible)).not.toContain('credential-derivative');
  expect(JSON.stringify(visible)).not.toContain('PRIVATE_INPUT');
});

function conditionHost(
  evaluate: (
    wait: import('@lody/shared/automations').AutomationWait
  ) => Effect.Effect<import('@lody/shared/automations').AutomationResult, unknown>
) {
  return Layer.succeed(AutomationHost, {
    evaluate,
    authorize: () => Effect.succeed({ value: 'yes', reason: 'authorized' }),
    condition: () => Effect.succeed({ value: 'yes', reason: 'current' }),
    prepare: (receipt) =>
      Effect.succeed({ state: 'resolved', sessionId: receipt.sessionId, prepared: {} }),
    submit: () => Effect.succeed({ state: 'queued' }),
    reconcile: () => Effect.succeed({ state: 'queued' }),
    cancel: () => Effect.succeed({ state: 'cancelled' }),
    report: () => Effect.void,
  });
}

it('recovers an interrupted check and delivers its result through the existing receipt loop once', async () => {
  const { ledger, open } = fixture();
  const wait = ledger.registerWait(
    { program: '() => false', intervalMs: 1000 },
    'session',
    'user',
    0
  );
  ledger.updateWait(wait.id, 'waiting', { state: 'checking' }, 0);
  ledger.close();
  const recovered = open();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* Automations;
        yield* runtime.pass;
        yield* runtime.pass;
        expect(recovered.wait(wait.id)).toMatchObject({
          state: 'matched',
          result: { resumeText: 'Continue' },
        });
        expect(recovered.activities()).toMatchObject([{ state: 'queued', sessionId: 'session' }]);
        expect(recovered.activities()).toHaveLength(1);
        yield* runtime.cancel(wait.id);
        expect(recovered.wait(wait.id)?.state).toBe('cancelled');
        expect(recovered.activities()[0]?.state).toBe('cancelled');
      }).pipe(
        Effect.provide(
          Automations.layer(recovered).pipe(
            Layer.provide(conditionHost(() => Effect.succeed({ resumeText: 'Continue' })))
          )
        )
      )
    )
  );
});

it('joins a cancelled condition’s tool cleanup before returning and never creates a continuation', async () => {
  const { ledger } = fixture();
  const wait = ledger.registerWait(
    { program: '() => false', intervalMs: 1000 },
    'session',
    'user',
    0
  );
  const entered = Deferred.makeUnsafe<void>();
  const cleanupStarted = Deferred.makeUnsafe<void>();
  const cleanupRelease = Deferred.makeUnsafe<void>();
  let cleaned = false;
  const evaluate = () =>
    Effect.scoped(
      Effect.acquireRelease(Deferred.succeed(entered, undefined), () =>
        Deferred.succeed(cleanupStarted, undefined).pipe(
          Effect.andThen(Deferred.await(cleanupRelease)),
          Effect.andThen(
            Effect.sync(() => {
              cleaned = true;
            })
          )
        )
      ).pipe(Effect.andThen(Effect.never))
    );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* Automations;
        yield* Deferred.await(entered);
        const cancellation = yield* runtime.cancel(wait.id).pipe(Effect.forkChild);
        yield* Deferred.await(cleanupStarted);
        expect(ledger.wait(wait.id)?.state).toBe('cancelled');
        expect(cleaned).toBe(false);
        yield* Deferred.succeed(cleanupRelease, undefined);
        yield* Fiber.join(cancellation);
        expect(cleaned).toBe(true);
        expect(ledger.activities()).toEqual([]);
      }).pipe(
        Effect.provide(Automations.layer(ledger).pipe(Layer.provide(conditionHost(evaluate))))
      )
    )
  );
});

it('reports bounded check failures without inventing a ready result', async () => {
  const { ledger } = fixture();
  const wait = ledger.registerWait(
    { program: '() => false', intervalMs: 1000 },
    'session',
    'user',
    0
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* Automations;
        for (let attempt = 0; attempt < 5; attempt++) {
          ledger.updateWait(wait.id, 'waiting', { nextCheckAt: 0 }, 0);
          yield* runtime.pass;
        }
        expect(ledger.wait(wait.id)).toMatchObject({ state: 'failed', consecutiveErrors: 5 });
        expect(ledger.wait(wait.id)?.lastError).toContain('Synthetic tool error');
        expect(ledger.activities()).toEqual([]);
      }).pipe(
        Effect.provide(
          Automations.layer(ledger).pipe(
            Layer.provide(conditionHost(() => Effect.fail(new Error('Synthetic tool error'))))
          )
        )
      )
    )
  );
});

describe('Scoped observations and admission evidence', () => {
  const sha = 'a'.repeat(40);
  const prUrl = 'https://github.com/owner/project/pull/42';
  const meta = {
    id: 'session',
    userId: 'user',
    machineId: 'machine',
    pullRequests: [{ url: prUrl, status: 'open' }],
  } as SessionMeta;
  const run = {
    runId: 1,
    attempt: 1,
    workflowId: 5,
    headSha: sha,
    branch: 'feature',
    status: 'completed',
    conclusion: 'failure',
    updatedAt: 100,
    url: 'https://github.com/owner/project/actions/runs/1',
    repository: 'owner/project',
    headRepository: 'owner/project',
    prNumbers: [42],
  };
  const pr = {
    number: 42,
    url: prUrl,
    status: 'open' as const,
    headRefName: 'feature',
    headSha: sha,
    headRepository: 'owner/project',
    updatedAt: new Date(100).toISOString(),
    ciState: 'f' as const,
    mergeState: null,
  };

  it('retains the observed attempt across restart and rejects changed HEAD, reruns and stale evidence', async () => {
    const { observeWorkflows, readWorkflowRuns, checkWorkflowEvidence } =
      await import('./sources/workflows');
    const { ledger, open } = fixture();
    observePullRequests(ledger, meta, 'owner/project', [pr], 100);
    observeWorkflows(ledger, meta, 'owner/project', sha, [run], false, 100);
    const initial = readWorkflowRuns(ledger, meta, 100);
    expect(initial.value.status).toBe('observed');
    const wait = ledger.registerWait(
      { program: '() => false', intervalMs: 1000 },
      'session',
      'user',
      100
    );
    ledger.updateWait(wait.id, 'waiting', { state: 'checking' }, 100);
    ledger.recordRead(wait.id, 'github.workflowRuns', initial.evidence, 100);
    const matched = required(
      ledger.finishWait(wait, { resumeText: 'CI failed', payload: { headSha: 'forged' } }, 100)
    );
    ledger.close();
    const recovered = open();
    const receipt = required(recovered.receipt(required(matched.invocationId)));
    expect(receipt.evidence).toEqual(initial.evidence);
    expect(recovered.wantsRead('github.workflowRuns', 'session')).toBe(true);
    expect(checkWorkflowEvidence(recovered, receipt.evidence ?? [], 100).value).toBe('yes');
    expect(checkWorkflowEvidence(recovered, receipt.evidence ?? [], 120_101).value).toBe('unknown');
    observeWorkflows(
      recovered,
      meta,
      'owner/project',
      sha,
      [{ ...run, attempt: 2, status: 'in_progress', conclusion: null, updatedAt: 200 }],
      false,
      200
    );
    expect(checkWorkflowEvidence(recovered, receipt.evidence ?? [], 200)).toMatchObject({
      value: 'no',
      reason: 'workflow_superseded',
    });
    observeWorkflows(recovered, meta, 'owner/project', sha, [run], false, 201);
    expect(readWorkflowRuns(recovered, meta, 201).value).toMatchObject({
      pullRequests: [{ runs: [{ attempt: 2, status: 'in_progress' }] }],
    });
    observePullRequests(
      recovered,
      meta,
      'owner/project',
      [{ ...pr, headSha: 'b'.repeat(40), updatedAt: new Date(300).toISOString() }],
      300
    );
    expect(checkWorkflowEvidence(recovered, receipt.evidence ?? [], 300).value).toBe('no');
    recovered.cancelWait(wait.id, 301);
    expect(recovered.wantsRead('github.workflowRuns', 'session')).toBe(false);
  });

  it('reads authoritative scoped state, rejects cross-session parameters and invalidates a waiting dependency', async () => {
    const { readAutomationContext } = await import('./context/reads-legacy');
    const { observeWorkflows } = await import('./sources/workflows');
    const { ledger } = fixture();
    const wait = ledger.registerWait(
      { program: '() => false', intervalMs: 1000 },
      'session',
      'user',
      100
    );
    ledger.updateWait(wait.id, 'waiting', { state: 'checking' }, 100);
    const options = {
      ledger,
      wait,
      now: 100,
      manager: {
        repo: { getDocMeta: async () => ({ meta }) },
      } as unknown as import('@/lib/loro/doc').LoroDocumentManager,
      authority: {} as import('@/session/session-automation-authority').SessionAutomationAuthority,
    };
    expect(
      await readAutomationContext({
        ...options,
        input: { resource: 'github.workflowRuns', parameters: {} },
      })
    ).toMatchObject({ value: { status: 'unknown' } });
    expect(ledger.wantsRead('github.workflowRuns', 'session')).toBe(true);
    await expect(
      readAutomationContext({
        ...options,
        input: { resource: 'session', parameters: { sessionId: 'someone-else' } },
      })
    ).rejects.toThrow();
    await expect(
      readAutomationContext({ ...options, input: { resource: 'process.env', parameters: {} } })
    ).rejects.toThrow('AUTOMATION_READ_UNAVAILABLE');
    expect(
      await readAutomationContext({ ...options, input: { resource: 'session', parameters: {} } })
    ).toEqual({
      value: {
        id: 'session',
        latestInputId: null,
        lastHandledInputId: null,
        archived: false,
        stopped: false,
      },
      observedAt: 100,
    });
    expect(ledger.hasSessionWork('session', wait.id)).toBe(false);
    ledger.finishWait(wait, false, 100);
    expect(ledger.dueWaits(200)).toEqual([]);
    observeWorkflows(ledger, meta, 'owner/project', sha, [run], false, 200);
    expect(ledger.dueWaits(200).map((item) => item.id)).toEqual([wait.id]);
    ledger.cancelWait(wait.id, 201);
    await expect(
      readAutomationContext({ ...options, input: { resource: 'session', parameters: {} } })
    ).rejects.toThrow('AUTOMATION_WAIT_INACTIVE');
  });

  it('records a persistent deadline once without treating it as capacity', () => {
    const { ledger, open } = fixture();
    ledger.upsert(
      { ...draft, scope: { workspaceId: 'workspace', sessionId: 'session' } },
      'user',
      2,
      1
    );
    ledger.publish(event);
    const receipt = ledger.accept(
      required(ledger.deliveries()[0]),
      { ...intent, notBefore: 500 },
      100
    );
    ledger.recordDeadline(receipt, 499);
    expect(
      ledger.sessionEvents('session', 0, 10).filter((item) => item.type === 'timer.due')
    ).toEqual([]);
    ledger.recordDeadline(receipt, 500);
    ledger.close();
    const recovered = open();
    recovered.recordDeadline(receipt, 600);
    expect(
      recovered.sessionEvents('session', 0, 10).filter((item) => item.type === 'timer.due')
    ).toMatchObject([{ occurredAt: 500, observedAt: 500 }]);
    expect(recovered.receipt(receipt.id)).toMatchObject({
      state: 'accepted',
      intent: { notBefore: 500 },
    });
    expect(recovered.capacity('binding')).toBeUndefined();
  });
});
