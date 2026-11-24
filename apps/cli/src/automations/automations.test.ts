import { publicActivity } from './control/activities';
import { observeCapacity } from './sources/capacity';
import { hasUnresolvedToolEffects, reconcileSessionTurnsLegacy } from './sources/sessions-legacy';
import type { SessionAutomationObservation } from '@/session/automation-observations';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import { OrchestrationConnection } from '../orchestration/platform/database';
import { classifyCapacityFailure } from '@/session/acp-error-classification';
import type { RateLimitsSnapshot } from 'acp-extension-core';
import { retainsAutomationGrant } from './actions/authorization';
import { deliveryRequest } from './actions/session-actions-legacy';
import en from '../../../../locales/en.json';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAutomationContext } from './context/fetch';
import { execAutomationCommand } from './context/exec';
import { platformLayer } from '@/platform/process-options';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Arbitrary, Clock, Deferred, Effect, Layer, Fiber, Schema } from 'effect';
import { it as effectIt } from '@effect/vitest';
import type {
  AutomationEvent,
  AutomationRuleDraft,
  CapacityObservation,
} from '@lody/shared/automations';
import { AutomationLedger, automationIdentity } from './storage/ledger';
import {
  configureSessionPolicies,
  internalPolicy,
  sessionPolicySettings,
} from './policies/session';
import {
  advanceDelivery,
  deliveryStepCurrent,
  readDeliveryProgress,
  readPullRequestSnapshot,
  startDeliveryEpoch,
  DELIVERY_CI_REPORT_GRACE_MS,
  DELIVERY_PR_CREATION_GRACE_MS,
} from './policies/delivery';
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
/** Structural access to the ledger's own connection for schema-level assertions. */
const rawDb = (ledger: AutomationLedger) =>
  (
    ledger as unknown as {
      connection: {
        raw: {
          prepare: (sql: string) => {
            all: (...args: unknown[]) => Array<Record<string, unknown>>;
            get: (...args: unknown[]) => Record<string, unknown> | undefined;
            run: (...args: unknown[]) => unknown;
          };
        };
      };
    }
  ).connection.raw;

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
    ledger.activateCurrentCapacityFailure('session', 'newer', 102);
    expect(ledger.deliveries()).toHaveLength(0);
    ledger.activateCurrentCapacityFailure('session', 'current', 103);
    expect(ledger.deliveries()).toHaveLength(1);
    expect(ledger.deliveries()[0]?.event.data.workId).toBe(work.id);
    ledger.close();
    const reopened = open();
    reopened.activateCurrentCapacityFailure('session', 'current', 104);
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

  it('observes a turn a teammate sent in a Session on this machine', async () => {
    const { ledger } = fixture();
    ledger.stageTurn({ ...fact(1), userId: 'teammate' });
    await reconcileSessionTurnsLegacy(
      ledger,
      manager,
      () => 'normal',
      () => {},
      100
    );
    expect(ledger.sessionEvents('session', -1, 200)).toMatchObject([{ subject: 'input-1' }]);
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

  it('publishes availability only on a recorded outage recovery while every fresh evidence wakes recovery', () => {
    const { ledger } = fixture();
    configureSessionPolicies(ledger, 'session', 'user', { recoverCapacity: true }, 1);
    const work = {
      id: 'parked-work',
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
    ledger.update(receipt.id, 'accepted', { state: 'blocked', retryAt: 900_000 }, 102);
    const transitions = () =>
      (
        rawDb(ledger)
          .prepare("SELECT COUNT(*) AS n FROM events WHERE type='provider.capacity.available'")
          .get() as { n: number }
      ).n;
    const snapshot = (usedPercent: number, fetchedAt: number): RateLimitsSnapshot => ({
      fetchedAtEpochSeconds: fetchedAt,
      rateLimits: [
        {
          limitId: 'quota',
          scope: { providerId: 'provider' },
          windows: [{ usedPercent, windowDurationSeconds: 18000, resetsAtEpochSeconds: 500 }],
        },
      ],
    });
    // 'unknown' -> 'yes' wakes the parked receipt on fresh evidence but publishes nothing.
    observeCapacity(
      ledger,
      { bindingId: 'account', fingerprint: 'config-version' },
      snapshot(0, 100),
      'push',
      100_000
    );
    expect(transitions()).toBe(0);
    expect(ledger.receipt(receipt.id)).toMatchObject({
      retryAt: 100_000,
      capacityWakeRevision: 1,
    });
    observeCapacity(
      ledger,
      { bindingId: 'account', fingerprint: 'config-version' },
      snapshot(0, 200),
      'push',
      200_000
    );
    expect(transitions()).toBe(0);
    // 'no' -> 'yes': the recorded outage recovering publishes exactly once.
    observeCapacity(
      ledger,
      { bindingId: 'account', fingerprint: 'config-version' },
      snapshot(100, 250),
      'push',
      250_000
    );
    observeCapacity(
      ledger,
      { bindingId: 'account', fingerprint: 'config-version' },
      snapshot(0, 300),
      'push',
      300_000
    );
    expect(transitions()).toBe(1);
    // A gap past the 5-minute freshness bound reads 'unknown': no second recovery.
    observeCapacity(
      ledger,
      { bindingId: 'account', fingerprint: 'config-version' },
      snapshot(0, 610),
      'push',
      610_000
    );
    expect(transitions()).toBe(1);
    observeCapacity(
      ledger,
      { bindingId: 'account', fingerprint: 'other' },
      snapshot(0, 615),
      'push',
      615_000
    );
    expect(transitions()).toBe(1);
  });
});

describe('JavaScript conditions', () => {
  const context = { sessionId: 'session', workspaceId: 'workspace', now: 100 };
  it('passes command results through the condition interpreter', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'lody-automation-exec-'));
    roots.push(root);
    const program = `async ({ctx}) => {
      const result = await ctx.exec({command: ${JSON.stringify(process.execPath)}, args: ['-e', 'process.stdout.write("ready"); process.exitCode = 7']});
      return result.exitCode === 7 ? {resumeText: result.stdout} : false;
    }`;
    const result = await Effect.runPromise(
      evaluateProgram(
        program,
        context,
        () => Effect.fail('unexpected read'),
        false,
        (input) =>
          execAutomationCommand(input, root, { PATH: process.env.PATH }).pipe(
            Effect.provide(platformLayer({}))
          )
      )
    );
    expect(result).toEqual({ resumeText: 'ready' });
  });
  it('exposes buffered HTTP responses to conditions', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ready":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    try {
      expect(
        await evaluateAutomationProgram(
          `async ({ctx}) => {
        const response = await ctx.fetch('https://example.com/status');
        const data = await response.json();
        return response.ok && data.ready ? { resumeText: 'Ready' } : false;
      }`,
          context,
          async () => {
            throw new Error('unexpected read');
          }
        )
      ).toEqual({ resumeText: 'Ready' });
    } finally {
      fetchMock.mockRestore();
    }
  });
  it('rejects oversized bodies and aborts active HTTP requests', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('x'.repeat(64 * 1024 + 1)))
      .mockImplementationOnce(
        (_url, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          })
      );
    try {
      await expect(
        fetchAutomationContext({ url: 'https://example.com' }, new AbortController().signal)
      ).rejects.toThrow('AUTOMATION_FETCH_BODY_TOO_LARGE');
      const controller = new AbortController();
      const pending = fetchAutomationContext({ url: 'https://example.com' }, controller.signal);
      controller.abort();
      await expect(pending).rejects.toThrow('aborted');
    } finally {
      fetchMock.mockRestore();
    }
  });
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
  it('aborts a fetch when the evaluation is interrupted', async () => {
    const entered = Deferred.makeUnsafe<void>();
    let aborted = false;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new Error('aborted'));
            },
            { once: true }
          );
          Effect.runSync(Deferred.succeed(entered, undefined));
        })
    );
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fiber = yield* evaluateProgram(
              `async ({ctx}) => { await ctx.fetch('https://example.com'); return false; }`,
              context,
              () => Effect.fail('unexpected read')
            ).pipe(Effect.forkChild);
            yield* Deferred.await(entered);
            yield* Fiber.interrupt(fiber);
            expect(aborted).toBe(true);
          })
        )
      );
    } finally {
      fetchMock.mockRestore();
    }
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
      authority: {
        canEdit: async () => 'yes',
      } as unknown as import('@/session/session-automation-authority').SessionAutomationAuthority,
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

describe('Auto delivery', () => {
  const prUrl = 'https://github.com/owner/project/pull/42';
  const sessionMeta = (pullRequests: SessionMeta['pullRequests'] = []) =>
    ({ id: 'session', userId: 'user', machineId: 'machine', pullRequests }) as SessionMeta;
  const linked = sessionMeta([{ url: prUrl, status: 'open' }]);
  const pr = (
    headSha: string,
    ciState: 's' | 'f' | 'p' | null,
    mergeState: 'c' | 'b' | 'd' | 'u' | null
  ) => ({
    number: 42,
    url: prUrl,
    status: 'open' as const,
    headRefName: 'feature',
    headSha,
    headRepository: 'owner/project',
    updatedAt: new Date(100).toISOString(),
    ciState,
    mergeState,
  });
  const options = { fixCi: true, resolveConflicts: true, merge: true };

  function enabled(settings = options) {
    const { ledger } = fixture();
    startDeliveryEpoch(ledger, 'session', 1);
    configureSessionPolicies(ledger, 'session', 'user', { autoDeliver: settings }, 1);
    return ledger;
  }
  /** Runs the policy for every pending delivery, as the engine does, and returns new receipts. */
  function deliver(ledger: AutomationLedger, now: number) {
    return ledger.deliveries().flatMap((delivery) => {
      const receipts = internalPolicy(delivery).map((intent) =>
        ledger.accept(delivery, intent, now)
      );
      ledger.finishDelivery(delivery, undefined, now);
      return receipts;
    });
  }
  function settleAll(ledger: AutomationLedger, now: number) {
    for (const receipt of ledger.pending(Number.MAX_SAFE_INTEGER, 100))
      ledger.update(receipt.id, receipt.state, { state: 'settled' }, now);
  }
  const requested = (receipts: ReturnType<typeof deliver>) =>
    receipts.map((receipt) => {
      const input = (receipt.intent.action.parameters as { input: { kind: string; ref: string } })
        .input;
      return `${input.kind}:${input.ref}`;
    });

  it('round-trips the setting and asks for a pull request once when none exists', () => {
    const ledger = enabled({ fixCi: true, resolveConflicts: false, merge: false });
    expect(sessionPolicySettings(ledger, 'session').autoDeliver).toEqual({
      fixCi: true,
      resolveConflicts: false,
      merge: false,
    });
    expect(advanceDelivery({ ledger, meta: sessionMeta(), options, now: 10 }).status).toEqual({
      state: 'pr',
    });
    advanceDelivery({ ledger, meta: sessionMeta(), options, now: 20 });
    const receipts = deliver(ledger, 20);
    expect(requested(receipts)).toEqual(['delivery:create_pr']);
    expect(receipts[0]?.intent.condition).toEqual({
      kind: 'session.group.settled',
      parameters: { rootId: 'session' },
    });
    settleAll(ledger, 30);
    expect(advanceDelivery({ ledger, meta: sessionMeta(), options, now: 40 }).status.state).toBe(
      'pr'
    );
    expect(
      advanceDelivery({
        ledger,
        meta: sessionMeta(),
        options,
        now: 31 + DELIVERY_PR_CREATION_GRACE_MS,
      }).status
    ).toEqual({ state: 'stalled', reason: 'pr_not_created' });
  });

  it('asks for a new pull request instead of adopting one merged by earlier work', () => {
    const ledger = enabled();
    const earlier = sessionMeta([{ url: prUrl, status: 'merged' }]);
    observePullRequests(
      ledger,
      earlier,
      'owner/project',
      [{ ...pr('a'.repeat(40), 's', 'c'), status: 'merged' as const }],
      5
    );
    const decision = advanceDelivery({ ledger, meta: earlier, options, now: 10 });
    expect(decision).toMatchObject({ status: { state: 'pr' } });
    expect(decision.finished).toBeUndefined();
    expect(requested(deliver(ledger, 10))).toEqual(['delivery:create_pr']);
  });

  it('requests a CI fix per failing head, stops on an unchanged head and after the limit', () => {
    const ledger = enabled();
    let now = 100;
    const heads = ['a', 'b', 'c', 'd'].map((c) => c.repeat(40));
    for (const [index, head] of heads.slice(0, 3).entries()) {
      observePullRequests(ledger, linked, 'owner/project', [pr(head, 'f', 'u')], ++now);
      const decision = advanceDelivery({ ledger, meta: linked, options, now: ++now });
      expect(decision.status).toEqual({ state: 'fix', attempt: index + 1, prUrl });
      expect(requested(deliver(ledger, now))).toEqual(['delivery:fix_ci']);
      expect(advanceDelivery({ ledger, meta: linked, options, now: ++now }).status.state).toBe(
        'fix'
      );
      settleAll(ledger, ++now);
    }
    observePullRequests(ledger, linked, 'owner/project', [pr(required(heads[2]), 'f', 'u')], ++now);
    expect(advanceDelivery({ ledger, meta: linked, options, now: ++now }).status).toEqual({
      state: 'stalled',
      reason: 'no_new_commit',
      prUrl,
    });
    observePullRequests(ledger, linked, 'owner/project', [pr(required(heads[3]), 'f', 'u')], ++now);
    expect(advanceDelivery({ ledger, meta: linked, options, now: ++now }).status).toEqual({
      state: 'stalled',
      reason: 'ci_limit',
      prUrl,
    });
    expect(deliver(ledger, now)).toEqual([]);
  });

  it('merges a green head once, drops a request whose head moved and ends after the merge', () => {
    const ledger = enabled();
    const first = 'a'.repeat(40);
    observePullRequests(ledger, linked, 'owner/project', [pr(first, 'p', null)], 100);
    expect(advanceDelivery({ ledger, meta: linked, options, now: 101 }).status.state).toBe('ci');
    observePullRequests(ledger, linked, 'owner/project', [pr(first, 's', 'c')], 102);
    expect(
      advanceDelivery({
        ledger,
        meta: { ...linked, workspaceUnpushed: true },
        options,
        now: 103,
      }).status
    ).toEqual({ state: 'stalled', reason: 'workspace_unpushed', prUrl });
    expect(deliver(ledger, 103)).toEqual([]);
    expect(advanceDelivery({ ledger, meta: linked, options, now: 104 }).status.state).toBe('merge');
    const receipts = deliver(ledger, 104);
    expect(requested(receipts)).toEqual(['delivery:merge']);
    const merge = required(receipts[0]);
    expect(deliveryStepCurrent(ledger, 'session', merge.event.id).value).toBe('yes');
    observePullRequests(ledger, linked, 'owner/project', [pr('b'.repeat(40), 'p', null)], 105);
    expect(deliveryStepCurrent(ledger, 'session', merge.event.id).value).toBe('no');
    settleAll(ledger, 106);
    observePullRequests(
      ledger,
      linked,
      'owner/project',
      [{ ...pr('b'.repeat(40), 's', 'c'), status: 'merged' as const }],
      107
    );
    const done = advanceDelivery({ ledger, meta: linked, options, now: 108 });
    expect(done).toMatchObject({ finished: true, status: { state: 'merged' } });
  });

  it('waits for checks on a head that reports none before treating it as green', () => {
    const ledger = enabled();
    const head = 'a'.repeat(40);
    observePullRequests(ledger, linked, 'owner/project', [pr(head, null, 'c')], 100);
    expect(advanceDelivery({ ledger, meta: linked, options, now: 101 }).status.state).toBe('ci');
    observePullRequests(
      ledger,
      linked,
      'owner/project',
      [pr(head, null, 'c')],
      99 + DELIVERY_CI_REPORT_GRACE_MS
    );
    expect(
      advanceDelivery({ ledger, meta: linked, options, now: 100 + DELIVERY_CI_REPORT_GRACE_MS })
        .status.state
    ).toBe('ci');
    expect(deliver(ledger, 100 + DELIVERY_CI_REPORT_GRACE_MS)).toEqual([]);
    observePullRequests(
      ledger,
      linked,
      'owner/project',
      [pr(head, null, 'c')],
      101 + DELIVERY_CI_REPORT_GRACE_MS
    );
    expect(
      advanceDelivery({ ledger, meta: linked, options, now: 102 + DELIVERY_CI_REPORT_GRACE_MS })
        .status.state
    ).toBe('merge');
  });

  it('leaves merging to the user unless chosen and stops when GitHub blocks the merge', () => {
    const ledger = enabled({ fixCi: true, resolveConflicts: true, merge: false });
    observePullRequests(ledger, linked, 'owner/project', [pr('a'.repeat(40), 's', 'c')], 100);
    expect(
      advanceDelivery({ ledger, meta: linked, options: { ...options, merge: false }, now: 101 })
        .status.state
    ).toBe('ready');
    observePullRequests(ledger, linked, 'owner/project', [pr('a'.repeat(40), 's', 'b')], 102);
    expect(advanceDelivery({ ledger, meta: linked, options, now: 103 }).status).toEqual({
      state: 'stalled',
      reason: 'merge_blocked',
      prUrl,
    });
    expect(deliver(ledger, 103)).toEqual([]);
  });

  const prUrls = [prUrl, 'https://github.com/owner/project/pull/43'];
  const pick = <A>(table: readonly A[], index: number) => required(table[index % table.length]);
  const prStatuses = ['open', 'open', 'open', 'open', 'open', 'draft', 'merged', 'closed'] as const;
  const ciStates = ['s', 's', 'f', 'f', 'p', 'e', 'x', null] as const;
  const mergeStates = ['c', 'c', 'd', 'd', 'u', 'b', 'h', null] as const;
  const afterTurn = {
    ci: ['f', 'f', 'f', 'f', 's', 's', 'p', null] as const,
    merge: ['c', 'c', 'c', 'c', 'd', 'd', 'd', null] as const,
  };
  const outcomes = [
    'settled',
    'settled',
    'settled',
    'settled',
    'failed',
    'cancelled',
    'superseded',
    'stop',
    'restore',
  ] as const;
  const selector = Schema.Literals([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  const settingsSchema = Schema.Struct({
    fixCi: Schema.Boolean,
    resolveConflicts: Schema.Boolean,
    merge: Schema.Boolean,
  });
  const kinds = [
    'turn',
    'turn',
    'turn',
    'observe',
    'observe',
    'agent',
    'link',
    'workspace',
    'wait',
  ] as const;
  const step = Schema.Struct({
    kind: selector,
    a: selector,
    b: selector,
    c: selector,
    d: selector,
    toggle: Schema.Boolean,
    settings: settingsSchema,
  });
  const terminal = ['settled', 'failed', 'cancelled', 'superseded'];

  effectIt.prop(
    'keeps its limits and request preconditions under any observation and outcome order',
    [Arbitrary.schema(settingsSchema), Arbitrary.array(Arbitrary.schema(step), { maxLength: 80 })],
    ([initial, steps]) => {
      const ledger = new AutomationLedger({ kind: 'memory' }, 'workspace', 'machine');
      try {
        const heads = ['a', 'b', 'c', 'd'].map((c) => c.repeat(40));
        let head = required(heads[0]);
        let pushes = 0;
        const observe = (
          url: string,
          sha: string,
          status: (typeof prStatuses)[number],
          ciState: (typeof ciStates)[number],
          mergeState: (typeof mergeStates)[number]
        ) =>
          observePullRequests(
            ledger,
            meta(),
            'owner/project',
            [
              {
                ...pr(sha, ciState, mergeState),
                number: 42 + prUrls.indexOf(url),
                url,
                status,
                updatedAt: new Date(providerClock).toISOString(),
              },
            ],
            now
          );
        const links = new Map<string, string>();
        const workspace = { workspaceDirty: false, workspaceUnpushed: false };
        const meta = () =>
          ({
            ...sessionMeta(
              [...links].map(([url, status]) => ({ url, status })) as SessionMeta['pullRequests']
            ),
            ...workspace,
          }) as SessionMeta;
        let now = 1_000;
        let providerClock = 1_000;
        let settings: typeof options | undefined = initial;
        links.set(prUrl, 'open');
        startDeliveryEpoch(ledger, 'session', now);
        configureSessionPolicies(ledger, 'session', 'user', { autoDeliver: initial }, now);
        let epoch: { fix: number; conflict: number; create: number; merges: Set<string> } = {
          fix: 0,
          conflict: 0,
          create: 0,
          merges: new Set(),
        };
        let boundIn: number | undefined;
        let ended: string | undefined;
        const receipts = () =>
          ledger.activities(500).filter((receipt) => receipt.event.source === 'lody/auto-delivery');
        const outstanding = () => receipts().filter((receipt) => !terminal.includes(receipt.state));
        const pass = () => {
          for (const receipt of outstanding())
            if (settings && deliveryStepCurrent(ledger, 'session', receipt.event.id).value === 'no')
              ledger.update(receipt.id, receipt.state, { state: 'superseded' }, now);
          if (!settings) return;
          const current = meta();
          const before = readDeliveryProgress(ledger, 'session');
          const decision = advanceDelivery({ ledger, meta: current, options: settings, now });
          const progress = required(readDeliveryProgress(ledger, 'session'));
          if (!before?.prUrl && progress.prUrl) {
            expect(links.get(progress.prUrl)).toMatch(/^(open|draft)$/);
            expect(
              readPullRequestSnapshot(ledger, 'session', progress.prUrl)?.status ?? 'open'
            ).toMatch(/^(open|draft)$/);
            boundIn = progress.epoch;
          }
          const created = deliver(ledger, now);
          expect(created.length).toBeLessThanOrEqual(1);
          for (const receipt of created) {
            expect(ended).toBeUndefined();
            const data = receipt.event.data;
            const pr = progress.prUrl
              ? readPullRequestSnapshot(ledger, 'session', progress.prUrl)
              : undefined;
            if (data.step === 'create_pr') {
              expect(++epoch.create).toBe(1);
              continue;
            }
            expect(pr).toMatchObject({ status: 'open', headSha: data.headSha });
            expect(current.workspaceDirty || current.workspaceUnpushed).toBe(false);
            if (data.step === 'fix_ci') {
              expect(settings.fixCi && ['f', 'e'].includes(String(pr?.ciState))).toBe(true);
              expect(++epoch.fix).toBeLessThanOrEqual(3);
            } else if (data.step === 'resolve_conflicts') {
              expect(settings.resolveConflicts && pr?.mergeState === 'd').toBe(true);
              expect(++epoch.conflict).toBeLessThanOrEqual(3);
            } else {
              expect(settings.merge && ['c', 'u'].includes(String(pr?.mergeState))).toBe(true);
              const graced =
                pr?.ciState === null &&
                progress.unreportedCi?.head === pr.headSha &&
                pr.observedAt - progress.unreportedCi.since >= DELIVERY_CI_REPORT_GRACE_MS;
              expect(pr?.ciState === 's' || graced).toBe(true);
              expect(epoch.merges.has(String(data.headSha))).toBe(false);
              epoch.merges.add(String(data.headSha));
            }
          }
          expect(
            outstanding().filter(
              (receipt) => deliveryStepCurrent(ledger, 'session', receipt.event.id).value !== 'no'
            ).length
          ).toBeLessThanOrEqual(1);
          const last = progress.lastStep;
          const lastReceipt = last && ledger.eventReceipts('lody/auto-delivery', last.eventId)[0];
          if (lastReceipt?.state === 'failed' || lastReceipt?.state === 'cancelled') {
            ended ??= lastReceipt.state === 'failed' ? 'request_failed' : 'stopped';
            expect(decision.status).toMatchObject({ state: 'stalled', reason: ended });
          }
          if (decision.finished) {
            expect(boundIn).toBe(progress.epoch);
            expect(
              readPullRequestSnapshot(ledger, 'session', required(progress.prUrl))?.status
            ).toBe('merged');
            configureSessionPolicies(ledger, 'session', 'user', { autoDeliver: false }, now);
            settings = undefined;
            return;
          }
          advanceDelivery({ ledger, meta: current, options: settings, now });
          expect(deliver(ledger, now)).toEqual([]);
        };
        for (const item of steps) {
          now += 1_000;
          const { a, b, c, d } = item;
          switch (item.toggle && a === 0 ? 'toggle' : pick(kinds, item.kind)) {
            case 'observe': {
              providerClock += d === 0 ? -500 : 1_000;
              head = pick(heads, b);
              observe(
                pick(prUrls, a === 8 ? 1 : 0),
                head,
                pick(prStatuses, c),
                pick(ciStates, d),
                pick(mergeStates, a + b)
              );
              break;
            }
            case 'link': {
              const url = pick(prUrls, a === 8 ? 1 : 0);
              links.delete(url);
              links.set(url, pick(prStatuses, b));
              break;
            }
            case 'workspace':
              workspace.workspaceDirty = a === 0;
              workspace.workspaceUnpushed = b === 0;
              break;
            case 'agent': {
              const receipt = outstanding().at(-1);
              if (!receipt) break;
              const outcome = pick(outcomes, a);
              const patch =
                outcome === 'stop'
                  ? { state: 'blocked' as const, reason: 'target_stopped' }
                  : outcome === 'restore'
                    ? { state: 'queued' as const, reason: undefined }
                    : { state: outcome };
              ledger.update(receipt.id, receipt.state, patch, now);
              break;
            }
            case 'turn': {
              const receipt = outstanding().at(-1);
              if (receipt) ledger.update(receipt.id, receipt.state, { state: 'settled' }, now);
              now += 1_000;
              providerClock += 1_000;
              if (a !== 0) head = `push-${++pushes}`.padEnd(40, '0');
              observe(prUrl, head, 'open', pick(afterTurn.ci, b), pick(afterTurn.merge, c));
              break;
            }
            case 'wait':
              now += pick([0, 1, 4, 6, 11], a) * 60_000;
              break;
            case 'toggle': {
              const on = b !== 0;
              const chosen = item.settings;
              if (on && !settings) {
                startDeliveryEpoch(ledger, 'session', now);
                epoch = { fix: 0, conflict: 0, create: 0, merges: new Set() };
                boundIn = undefined;
                ended = undefined;
              }
              configureSessionPolicies(
                ledger,
                'session',
                'user',
                { autoDeliver: on ? chosen : false },
                now
              );
              settings = on ? chosen : undefined;
              break;
            }
          }
          pass();
        }
      } finally {
        ledger.close();
      }
    },
    { arbitrary: { runs: 200, size: 80 } }
  );

  it('sends the Info Bar request text after its origin line, plus the merged head', () => {
    const values = { repoFullName: 'owner/project', prNumber: 42, prUrl, headSha: 'a'.repeat(40) };
    const button = (key: 'sessions.prompts.fixCiErrors' | 'sessions.prompts.resolveConflicts') =>
      en[key]
        .replace('{{repoFullName}}', values.repoFullName)
        .replace('{{prLabel}}', '#42')
        .replace('{{prUrl}}', prUrl);
    const origin =
      '(Sent by **Auto delivery** in Lody, which the user turned on for this pull request.)';
    expect(deliveryRequest('fix_ci', values)).toBe(
      `${origin}\n\n${button('sessions.prompts.fixCiErrors')}`
    );
    expect(deliveryRequest('resolve_conflicts', values)).toBe(
      `${origin}\n\n${button('sessions.prompts.resolveConflicts')}`
    );
    expect(deliveryRequest('merge', values)).toContain(`head commit ${values.headSha}`);
    expect(deliveryRequest('merge', { ...values, headSha: undefined })).toBeUndefined();
    expect(deliveryRequest('create_pr', {})).toContain(en['sessions.prompts.prBranchUpkeep']);
  });
});

describe('Ledger query columns', () => {
  const receiptPayload = (overrides: Record<string, unknown> = {}) => ({
    id: 'receipt-1',
    deliveryId: 'delivery-1',
    sessionId: 's1',
    turnId: 'turn-1',
    state: 'blocked',
    retryAt: 7,
    attempts: 0,
    intent: {
      key: 'invoke',
      action: {
        kind: 'agent.invoke',
        parameters: {
          target: { kind: 'existing', sessionId: 's1' },
          input: { kind: 'external_event', ref: 'e1' },
          ifBusy: 'enqueue',
        },
      },
    },
    rule: {
      id: 'rule-1',
      ownerUserId: 'user',
      ownerMachineId: 'machine',
      scope: { workspaceId: 'workspace', sessionId: 's1' },
      handler: { kind: 'policy', policy: 'recover-capacity', options: {} },
      revision: 1,
    },
    event: {
      id: 'e1',
      source: 'session/session',
      type: 'provider.quota.exhausted',
      correlationId: 'corr-1',
      data: { workId: 'work-1' },
    },
    ...overrides,
  });
  const deliveryPayload = {
    id: 'delivery-1',
    state: 'accepted',
    updatedAt: 9,
    rule: {
      id: 'rule-1',
      ownerUserId: 'user',
      ownerMachineId: 'machine',
      scope: { workspaceId: 'workspace', sessionId: 's1' },
      revision: 1,
    },
    event: { source: 'session/session', id: 'e1', data: { workId: 'work-1' } },
  };
  const waitPayload = {
    id: 'wait-1',
    sessionId: 's1',
    workspaceId: 'workspace',
    ownerUserId: 'user',
    ownerMachineId: 'machine',
    intervalMs: 30_000,
    state: 'waiting',
    createdAt: 5,
    updatedAt: 5,
    nextCheckAt: 5,
    checks: 0,
    consecutiveErrors: 0,
    reads: ['resource-1'],
  };
  const workPayload = {
    id: 'work-1',
    ownerUserId: 'user',
    updatedAt: 6,
    sessionId: 's1',
    turnId: 'turn-1',
    nativeSessionId: 'native',
    bindingId: 'account',
    fingerprint: 'config',
    inputRef: 'input',
    confirmedBoundary: 'assistant',
    unresolvedEffects: false,
    release: 'released',
    state: 'queued',
    attempts: 0,
    invocationId: 'other-invocation',
  };
  const stagedFact = (index: number): SessionAutomationObservation => ({
    sessionId: 's1' as SessionId,
    turnId: `input-${index}`,
    assistantTurnId: `assistant-${index}`,
    userId: 'user',
    inputConfig: {},
    outcome: 'completed',
    released: false,
    finalized: true,
    observedAt: index,
  });
  it('lifts predicates into columns when upgrading a v2 ledger', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'lody-automations-v2-'));
    roots.push(root);
    const filename = path.join(root, 'automations.sqlite');
    const database = new OrchestrationConnection({ kind: 'disk', path: filename });
    database.raw.exec(`
      CREATE TABLE rules (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL
      );
      CREATE TABLE sources (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE deliveries (id TEXT PRIMARY KEY, state TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX delivery_state ON deliveries(state);
      CREATE TABLE receipts (
        id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL, state TEXT NOT NULL,
        updated_at INTEGER NOT NULL, payload TEXT NOT NULL
      );
      CREATE INDEX receipt_state ON receipts(state, updated_at);
      CREATE INDEX receipt_delivery ON receipts(delivery_id);
      CREATE TABLE capacity (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE work (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE waits (
        id TEXT PRIMARY KEY, state TEXT NOT NULL, next_check_at INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX waits_due ON waits(state,next_check_at);
      CREATE TABLE turn_observations (
        id TEXT PRIMARY KEY, payload TEXT NOT NULL, retry_at INTEGER NOT NULL DEFAULT 0
      );
      PRAGMA user_version = 2;
    `);
    database.raw.prepare('INSERT INTO events (event_key,payload) VALUES (?,?)').run(
      'key-1',
      JSON.stringify({
        ...event,
        id: 'ev-1',
        scope: { workspaceId: 'workspace', sessionId: 's1' },
      })
    );
    database.raw
      .prepare('INSERT INTO waits VALUES (?,?,?,?)')
      .run('wait-1', 'waiting', 5, JSON.stringify(waitPayload));
    database.raw
      .prepare('INSERT INTO receipts VALUES (?,?,?,?,?)')
      .run('receipt-1', 'delivery-1', 'blocked', 5, JSON.stringify(receiptPayload()));
    database.raw
      .prepare('INSERT INTO deliveries VALUES (?,?,?)')
      .run('delivery-1', 'accepted', JSON.stringify(deliveryPayload));
    database.raw
      .prepare('INSERT INTO work VALUES (?,?)')
      .run('work-1', JSON.stringify(workPayload));
    database.raw
      .prepare('INSERT INTO turn_observations VALUES (?,?,?)')
      .run('turn-1', JSON.stringify({ ...stagedFact(1), observedAt: 8 }), 0);
    database.close();
    const ledger = new AutomationLedger({ kind: 'disk', path: filename }, 'workspace', 'machine');
    stores.push(ledger);
    expect(ledger.sessionEvents('s1', 0, 10).map((observed) => observed.id)).toEqual(['ev-1']);
    expect(ledger.dueWaits(10).map((item) => item.id)).toEqual(['wait-1']);
    expect(ledger.pending(10).map((item) => item.id)).toEqual(['receipt-1']);
    expect(ledger.hasSessionWork('s1')).toBe(true);
    expect(ledger.wantsRead('resource-1', 's1')).toBe(true);
    expect(ledger.deliveries().map((item) => item.id)).toEqual(['delivery-1']);
    expect(ledger.sessionWork('s1', 'user').map((item) => item.id)).toEqual(['work-1']);
    expect(ledger.nextDueAt(0)).toBe(0);
    expect(ledger.activityPage('user', undefined, 50).items).toHaveLength(4);
    expect(
      (rawDb(ledger).prepare('SELECT COUNT(*) AS n FROM wait_reads').get() as { n: number }).n
    ).toBe(1);
  });

  it('keeps query columns equal to their frozen payload values', () => {
    const { ledger } = fixture();
    ledger.publish(event);
    const delivery = required(ledger.deliveries()[0]);
    const receipt = ledger.accept(delivery, intent, 100);
    ledger.update(receipt.id, 'accepted', { retryAt: 1_000 }, 101);
    const wait = ledger.registerWait(
      { program: 'async () => false', intervalMs: 1_000 },
      'session',
      'user',
      200
    );
    ledger.updateWait(wait.id, 'waiting', { state: 'checking' }, 201);
    ledger.recordRead(wait.id, 'resource-1', [{ sourceId: 'source', revision: 'r1' }], 202);
    ledger.stageTurn({ ...stagedFact(2), sessionId: 'session' });
    ledger.putWork({ ...workPayload, id: 'work-2', sessionId: 'session' });
    const mismatches = (sql: string) =>
      (rawDb(ledger).prepare(`SELECT COUNT(*) AS n ${sql}`).get() as { n: number }).n;
    expect(
      mismatches(`FROM events
        WHERE type IS NOT json_extract(payload,'$.type')
        OR source IS NOT json_extract(payload,'$.source')
        OR session_id IS NOT json_extract(payload,'$.scope.sessionId')
        OR project_id IS NOT json_extract(payload,'$.scope.projectId')
        OR work_id IS NOT json_extract(payload,'$.data.workId')
        OR observed_at IS NOT json_extract(payload,'$.observedAt')`)
    ).toBe(0);
    expect(
      mismatches(`FROM receipts
        WHERE session_id IS NOT json_extract(payload,'$.sessionId')
        OR scope_session_id IS NOT COALESCE(json_extract(payload,'$.rule.scope.sessionId'),json_extract(payload,'$.sessionId'))
        OR owner_user_id IS NOT json_extract(payload,'$.rule.ownerUserId')
        OR rule_id IS NOT json_extract(payload,'$.rule.id')
        OR action_kind IS NOT json_extract(payload,'$.intent.action.kind')
        OR event_type IS NOT json_extract(payload,'$.event.type')
        OR event_source IS NOT json_extract(payload,'$.event.source')
        OR event_id IS NOT json_extract(payload,'$.event.id')
        OR correlation_key IS NOT COALESCE(json_extract(payload,'$.event.correlationId'),json_extract(payload,'$.deliveryId'))
        OR retry_at IS NOT COALESCE(json_extract(payload,'$.retryAt'),0)`)
    ).toBe(0);
    expect(
      mismatches(`FROM waits
        WHERE session_id IS NOT json_extract(payload,'$.sessionId')
        OR owner_user_id IS NOT json_extract(payload,'$.ownerUserId')
        OR invocation_id IS NOT json_extract(payload,'$.invocationId')
        OR created_at IS NOT json_extract(payload,'$.createdAt')
        OR due_at IS NOT MIN(next_check_at, COALESCE(json_extract(payload,'$.expiresAt'),9007199254740991))
        OR run_pending IS NOT (json_extract(payload,'$.run.startedAt') IS NOT NULL AND json_extract(payload,'$.run.exit') IS NULL)`)
    ).toBe(0);
    expect(
      mismatches(`FROM work
        WHERE session_id IS NOT json_extract(payload,'$.sessionId')
        OR owner_user_id IS NOT json_extract(payload,'$.ownerUserId')
        OR state IS NOT json_extract(payload,'$.state')
        OR turn_id IS NOT json_extract(payload,'$.turnId')
        OR invocation_id IS NOT json_extract(payload,'$.invocationId')
        OR updated_at IS NOT json_extract(payload,'$.updatedAt')`)
    ).toBe(0);
    expect(
      mismatches(`FROM deliveries
        WHERE rule_id IS NOT json_extract(payload,'$.rule.id')
        OR owner_user_id IS NOT json_extract(payload,'$.rule.ownerUserId')
        OR scope_session_id IS NOT json_extract(payload,'$.rule.scope.sessionId')
        OR event_source IS NOT json_extract(payload,'$.event.source')
        OR event_id IS NOT json_extract(payload,'$.event.id')
        OR event_work_id IS NOT json_extract(payload,'$.event.data.workId')
        OR updated_at IS NOT json_extract(payload,'$.updatedAt')`)
    ).toBe(0);
    expect(
      mismatches(`FROM turn_observations
        WHERE user_id IS NOT json_extract(payload,'$.userId')
        OR session_id IS NOT json_extract(payload,'$.sessionId')
        OR observed_at IS NOT json_extract(payload,'$.observedAt')`)
    ).toBe(0);
    expect(
      mismatches(`FROM wait_reads wr
        WHERE NOT EXISTS (
          SELECT 1 FROM waits w, json_each(w.payload,'$.reads') je
          WHERE w.id=wr.wait_id AND je.value=wr.resource)`)
    ).toBe(0);
    expect(
      mismatches(`FROM waits w, json_each(w.payload,'$.reads') je
        WHERE NOT EXISTS (
          SELECT 1 FROM wait_reads wr WHERE wr.wait_id=w.id AND wr.resource=je.value)`)
    ).toBe(0);
  });

  it('resolves every ledger query through an index, never an unindexed scan', () => {
    const { ledger } = fixture();
    const raw = rawDb(ledger);
    const original = raw.prepare;
    const captured: Array<{ sql: string; args: unknown[] }> = [];
    const wrap =
      (run: (...args: unknown[]) => unknown, sql: string) =>
      (...args: unknown[]) => {
        if (/^\s*select/i.test(sql)) captured.push({ sql, args });
        return run(...args);
      };
    raw.prepare = (sql: string) => {
      const statement = original.call(raw, sql);
      return {
        all: wrap(statement.all.bind(statement), sql),
        get: wrap(statement.get.bind(statement), sql),
        run: wrap(statement.run.bind(statement), sql),
      };
    };
    try {
      ledger.publish(event);
      const delivery = required(ledger.deliveries()[0]);
      const receipt = ledger.accept(delivery, intent, 100);
      ledger.update(receipt.id, 'accepted', { retryAt: 1_000 }, 101);
      ledger.finishDelivery(delivery);
      const wait = ledger.registerWait(
        { program: 'async () => false', intervalMs: 1_000 },
        'session',
        'user',
        200
      );
      ledger.updateWait(wait.id, 'waiting', { state: 'checking' }, 201);
      ledger.recordRead(wait.id, 'resource-1', [{ sourceId: 's', revision: 'r' }], 202);
      ledger.stageTurn({ ...stagedFact(3), sessionId: 'session' });
      ledger.putWork({ ...workPayload, id: 'work-2', sessionId: 'session' });
      ledger.recordCapacity(
        {
          bindingId: 'account',
          fingerprint: 'config',
          observedAt: 90,
          validUntil: 400,
          source: 'query',
          authentication: 'valid',
          billing: 'valid',
          windows: [{ id: 'quota', usedPercent: 0 }],
        },
        300
      );
      ledger.dueWaits(300);
      ledger.pending(300);
      ledger.sessionEvents('session', 0, 10);
      ledger.hasSessionWork('session');
      ledger.wantsRead('resource-1', 'session');
      ledger.wantsReadSessions('resource-1');
      ledger.invalidateReads('resource-1', 'session', 300);
      ledger.activityPage('user', 'session', 50);
      ledger.sessionWork('session', 'user');
      ledger.supersedeWork('session', 'other-turn', 'invocation', 300);
      ledger.eventReceipts('session/session', 'e1');
      ledger.hasEventDelivery('session/session', 'e1');
      ledger.nextDueAt(300);
      ledger.stagedTurns(300);
      ledger.orphanStartedRuns(300);
      ledger.rules();
      ledger.checkpoint('source');
      ledger.deliveries();
      ledger.activateCurrentCapacityFailure('session', 'user', 'turn-1', 300);
      ledger.wait(wait.id);
      ledger.receipt(receipt.id);
      ledger.work('work-2');
      ledger.delivery(delivery.id);
      ledger.rule(delivery.rule.id);
      ledger.capacity('account');
    } finally {
      raw.prepare = original;
    }
    expect(captured.length).toBeGreaterThan(0);
    for (const { sql, args } of captured) {
      const plan = original.call(raw, `EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{
        detail: string;
      }>;
      for (const step of plan)
        // No SCAN on hot tables — covering-index sweeps count; tiny list tables may SCAN.
        expect(step.detail, sql).not.toMatch(
          /^SCAN (receipts|waits|wait_reads|work|turn_observations|events)\b/
        );
    }
  });
});

describe('Engine scheduling', () => {
  const stagedFact = (index: number): SessionAutomationObservation => ({
    sessionId: 'session' as SessionId,
    turnId: `input-${index}`,
    assistantTurnId: `assistant-${index}`,
    userId: 'user',
    inputConfig: {},
    outcome: 'completed',
    released: false,
    finalized: true,
    observedAt: index,
  });

  it('reports the earliest durable deadline across waits, receipts, staged turns and deliveries', () => {
    const { ledger } = fixture();
    expect(ledger.nextDueAt(500)).toBeUndefined();
    ledger.publish(event);
    expect(ledger.nextDueAt(500)).toBe(500);
    const delivery = required(ledger.deliveries()[0]);
    const receipt = ledger.accept(delivery, intent, 100);
    ledger.finishDelivery(delivery, undefined, 101);
    expect(ledger.nextDueAt(500)).toBe(0);
    ledger.update(receipt.id, 'accepted', { retryAt: 30_000 }, 102);
    expect(ledger.nextDueAt(0)).toBe(30_000);
    const wait = ledger.registerWait(
      { program: 'async () => false', intervalMs: 60_000 },
      'session',
      'user',
      200
    );
    expect(ledger.nextDueAt(0)).toBe(200);
    ledger.updateWait(wait.id, 'waiting', { nextCheckAt: 40_000 }, 210);
    expect(ledger.nextDueAt(0)).toBe(30_000);
    ledger.stageTurn(stagedFact(9));
    expect(ledger.nextDueAt(0)).toBe(0);
  });

  it('runs passes at the earliest deadline and on wake signals, without spinning', async () => {
    // Fibers need real scheduling; only the clock surfaces are faked.
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    vi.setSystemTime(1_000_000);
    const { ledger } = fixture();
    ledger.publish(event);
    const delivery = required(ledger.deliveries()[0]);
    const receipt = ledger.accept(delivery, intent, 100);
    ledger.finishDelivery(delivery);
    let authorizeCalls = 0;
    const attempts = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    let arm: (() => void) | undefined;
    const nextPass = () => new Promise<void>((resolve) => void (arm = resolve));
    const host = Layer.succeed(AutomationHost, {
      authorize: () =>
        Effect.sync(() => {
          attempts[authorizeCalls]?.resolve();
          authorizeCalls += 1;
          return {
            value: 'no' as const,
            reason: 'hold',
            retryAt: authorizeCalls === 1 ? 1_060_000 : 1_120_000,
          };
        }),
      condition: () => Effect.succeed({ value: 'yes' as const, reason: 'current' }),
      prepare: () => Effect.succeed({ state: 'resolved' as const, prepared: {} }),
      submit: () => Effect.succeed({ state: 'settled' as const }),
      reconcile: () => Effect.succeed({ state: 'settled' as const }),
      cancel: () => Effect.succeed({ state: 'cancelled' as const }),
      observe: Effect.sync(() => {
        arm?.();
      }),
      report: () => Effect.void,
    });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* Automations;
          yield* Effect.promise(() => attempts[0].promise);
          expect(ledger.receipt(receipt.id)).toMatchObject({
            state: 'blocked',
            retryAt: 1_060_000,
          });
          // A parked receipt is not re-authorized before its durable deadline.
          const maintenance = nextPass();
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(15_000));
          yield* Effect.promise(() => maintenance);
          expect(authorizeCalls).toBe(1);
          const queued = nextPass();
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(15_000));
          yield* Effect.promise(() => queued);
          expect(authorizeCalls).toBe(1);
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(30_000));
          yield* Effect.promise(() => attempts[1].promise);
          expect(authorizeCalls).toBe(2);
          const signal = nextPass();
          yield* runtime.wake;
          yield* Effect.promise(() => signal);
        }).pipe(
          Effect.provide(Automations.layer(ledger).pipe(Layer.provide(host))),
          // Runs on the fake clock; must outlast this test's total fake advance.
          Effect.timeout('120 seconds')
        )
      )
    );
    vi.useRealTimers();
  });
});
