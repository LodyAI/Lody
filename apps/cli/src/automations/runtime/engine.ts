import { Cause, Clock, Context, Deferred, Effect, Layer, Queue, Semaphore } from 'effect';
import type {
  AutomationCondition,
  AutomationWait,
  AutomationResult,
  AutomationReceipt,
  ConditionObservation,
} from '@lody/shared/automations';
import { AutomationLedger, type Delivery } from '../storage/ledger';
import { internalPolicy } from '../policies/session';

export type ActionAuthorization = ConditionObservation & {
  terminalState?: 'failed' | 'superseded';
};
export type ActionResult = Pick<AutomationReceipt, 'state'> &
  Partial<Pick<AutomationReceipt, 'reason' | 'retryAt' | 'sessionId' | 'prepared'>>;

/** Resource adapters own authorization, final admission and reconciliation of their effects. */
export class AutomationHost extends Context.Service<
  AutomationHost,
  {
    authorize(receipt: AutomationReceipt): Effect.Effect<ActionAuthorization, unknown>;
    condition(
      condition: AutomationCondition,
      receipt: AutomationReceipt
    ): Effect.Effect<ConditionObservation, unknown>;
    prepare(receipt: AutomationReceipt): Effect.Effect<ActionResult, unknown>;
    submit(receipt: AutomationReceipt): Effect.Effect<ActionResult, unknown>;
    reconcile(receipt: AutomationReceipt): Effect.Effect<ActionResult, unknown>;
    cancel(receipt: AutomationReceipt): Effect.Effect<ActionResult, unknown>;
    evaluate?(wait: AutomationWait): Effect.Effect<AutomationResult, unknown>;
    observe?: Effect.Effect<void, unknown>;
    report(cause: unknown): Effect.Effect<void>;
  }
>()('lody/automations/Host') {}

export class Automations extends Context.Service<
  Automations,
  {
    wake: Effect.Effect<void>;
    pass: Effect.Effect<void, unknown>;
    cancel(id: string): Effect.Effect<void, unknown>;
  }
>()('lody/automations/Runtime') {
  static layer(ledger: AutomationLedger) {
    return Layer.effect(
      Automations,
      Effect.gen(function* () {
        const host = yield* AutomationHost;
        const signal = yield* Queue.dropping<void>(1);
        const gate = Semaphore.makeUnsafe(1);
        const active = new Map<string, Deferred.Deferred<void>>();
        const checking = new Map<
          string,
          { stop: Deferred.Deferred<void>; done: Deferred.Deferred<void> }
        >();
        const evaluate = Effect.fn('Automations.checkCondition')(function* (wait: AutomationWait) {
          if (!host.evaluate) return;
          const now = yield* Clock.currentTimeMillis;
          if (wait.expiresAt !== undefined && wait.expiresAt <= now) {
            ledger.updateWait(wait.id, wait.state, { state: 'expired' }, now);
            return;
          }
          const claimed = ledger.updateWait(
            wait.id,
            wait.state,
            { state: 'checking', checks: wait.checks + 1, evidence: [] },
            now
          );
          if (!claimed) return;
          const owned = { stop: Deferred.makeUnsafe<void>(), done: Deferred.makeUnsafe<void>() };
          checking.set(wait.id, owned);
          const evaluation = host.evaluate(claimed);
          yield* (
            claimed.expiresAt === undefined
              ? evaluation
              : evaluation.pipe(Effect.timeout(Math.max(1, claimed.expiresAt - now)))
          ).pipe(
            Effect.flatMap((result) =>
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((at) => Effect.try(() => ledger.finishWait(claimed, result, at)))
              )
            ),
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.failCause(cause)
                : Clock.currentTimeMillis.pipe(
                    Effect.flatMap((at) =>
                      Effect.try(() => {
                        const errors = claimed.consecutiveErrors + 1;
                        ledger.updateWait(
                          claimed.id,
                          'checking',
                          {
                            state:
                              claimed.expiresAt !== undefined && claimed.expiresAt <= at
                                ? 'expired'
                                : errors >= 5
                                  ? 'failed'
                                  : 'waiting',
                            consecutiveErrors: errors,
                            lastError: Cause.pretty(cause).slice(0, 2000),
                            nextCheckAt:
                              at +
                              Math.max(claimed.intervalMs, Math.min(300_000, 1000 * 2 ** errors)),
                          },
                          at
                        );
                      })
                    ),
                    Effect.andThen(host.report(cause))
                  )
            ),
            Effect.raceFirst(Deferred.await(owned.stop)),
            Effect.ensuring(
              Effect.sync(() => checking.delete(wait.id)).pipe(
                Effect.andThen(Deferred.succeed(owned.done, undefined))
              )
            )
          );
        });
        const wake = Queue.offer(signal, undefined).pipe(Effect.asVoid);
        const persist = Effect.fn('Automations.persist')(function* (
          receipt: AutomationReceipt,
          result: ActionResult
        ) {
          const now = yield* Clock.currentTimeMillis;
          return yield* Effect.try(() => ledger.update(receipt.id, receipt.state, result, now));
        });
        const check = Effect.fn('Automations.check')(function* (receipt: AutomationReceipt) {
          const current = ledger.rule(receipt.rule.id);
          if (!current?.enabled)
            return { value: 'no', reason: 'rule_disabled' } as ConditionObservation;
          if (!current.grants.actions.includes(receipt.intent.action.kind))
            return { value: 'no', reason: 'grant_revoked' } as ConditionObservation;
          const authorization = yield* host.authorize(receipt);
          if (authorization.value !== 'yes') return authorization;
          if (receipt.intent.guard) {
            const guard = yield* host.condition(receipt.intent.guard, receipt);
            if (guard.value !== 'yes') return { ...guard, reason: `guard:${guard.reason}` };
          }
          if (receipt.intent.condition)
            return yield* host.condition(receipt.intent.condition, receipt);
          return { value: 'yes', reason: 'eligible' } as ConditionObservation;
        });
        const advance = Effect.fn('Automations.advance')(function* (receipt: AutomationReceipt) {
          const now = yield* Clock.currentTimeMillis;
          if (receipt.state === 'cancelling') {
            const result = yield* host.cancel(receipt);
            yield* persist(receipt, {
              ...result,
              state: ['cancelled', 'settled', 'failed'].includes(result.state)
                ? result.state
                : 'cancelling',
              retryAt: now + 15_000,
            });
            return;
          }
          if (['submitting', 'queued', 'running', 'unknown'].includes(receipt.state)) {
            // A lost acknowledgement is a reconciliation problem, never permission to resubmit.
            const result = yield* host.reconcile(receipt);
            yield* persist(receipt, { retryAt: now + 15_000, ...result });
            return;
          }
          if (receipt.intent.notBefore !== undefined && receipt.intent.notBefore > now) {
            yield* persist(receipt, {
              state: 'waiting',
              reason: 'not_before',
              retryAt: receipt.intent.notBefore,
            });
            return;
          }
          yield* Effect.try(() => ledger.recordDeadline(receipt, now));
          const observation = yield* check(receipt);
          if (observation.value !== 'yes') {
            yield* persist(receipt, {
              state:
                'terminalState' in observation &&
                (observation.terminalState === 'failed' ||
                  observation.terminalState === 'superseded')
                  ? observation.terminalState
                  : observation.reason.startsWith('guard:') && observation.value === 'no'
                    ? 'superseded'
                    : 'blocked',
              reason: observation.reason,
              retryAt: observation.retryAt ?? now + 15_000,
            });
            return;
          }
          if (!receipt.prepared) {
            const prepared = yield* host.prepare(receipt);
            const resolved = yield* persist(receipt, { retryAt: now + 15_000, ...prepared });
            if (!resolved || resolved.state !== 'resolved') return;
            receipt = resolved;
          }
          // Preparation may yield to a user command, grant edit or a new source observation.
          const rechecked = yield* check(receipt);
          if (rechecked.value !== 'yes') {
            yield* persist(receipt, {
              state: 'blocked',
              reason: rechecked.reason,
              retryAt: rechecked.retryAt ?? now + 15_000,
            });
            return;
          }
          const claimed = yield* Effect.try(() =>
            ledger.update(
              receipt.id,
              receipt.state,
              { state: 'submitting', attempts: receipt.attempts + 1, retryAt: undefined },
              now
            )
          );
          if (!claimed) return;
          // The adapter repeats guards at resource admission. Persist the fence before entering it.
          yield* host.submit(claimed).pipe(
            Effect.flatMap((result) => persist(claimed, { retryAt: now + 15_000, ...result })),
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.failCause(cause)
                : persist(claimed, {
                    state: 'unknown',
                    reason: 'submission_outcome_unknown',
                    retryAt: now + 15_000,
                  }).pipe(Effect.andThen(host.report(cause)))
            )
          );
        });
        const advanceOwned = Effect.fn('Automations.advanceOwned')(function* (
          receipt: AutomationReceipt
        ) {
          const prior = active.get(receipt.id);
          if (prior) {
            yield* Deferred.await(prior);
            return;
          }
          const done = Deferred.makeUnsafe<void>();
          active.set(receipt.id, done);
          yield* advance(receipt).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                active.delete(receipt.id);
              }).pipe(Effect.andThen(Deferred.succeed(done, undefined)))
            )
          );
        });
        const deliver = Effect.fn('Automations.deliver')(function* (delivery: Delivery) {
          const now = yield* Clock.currentTimeMillis;
          if (!ledger.rule(delivery.rule.id)?.enabled) {
            yield* Effect.try(() => ledger.finishDelivery(delivery, 'rule_disabled', now));
            return;
          }
          const handler = delivery.rule.handler;
          if (handler.kind === 'agent') {
            yield* Effect.try(() =>
              ledger.accept(
                delivery,
                {
                  key: 'invoke',
                  guard: handler.guard,
                  action: { kind: 'agent.invoke', parameters: handler.invocation },
                },
                now
              )
            );
          } else {
            for (const intent of internalPolicy(delivery)) {
              yield* Effect.try(() => ledger.accept(delivery, intent, now));
            }
          }
          yield* Effect.try(() => ledger.finishDelivery(delivery, undefined, now));
        });
        const pass = gate.withPermit(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            if (host.observe) yield* host.observe;
            const waits = yield* Effect.try(() => ledger.dueWaits(now));
            yield* Effect.forEach(waits, evaluate, { concurrency: 4, discard: true });
            const deliveries = yield* Effect.try(() => ledger.deliveries(4));
            yield* Effect.forEach(
              deliveries,
              (delivery) =>
                deliver(delivery).pipe(
                  Effect.catchCause((cause) =>
                    Cause.hasInterrupts(cause)
                      ? Effect.failCause(cause)
                      : Effect.try(() =>
                          ledger.finishDelivery(delivery, 'handler_failed', now)
                        ).pipe(Effect.andThen(host.report(cause)))
                  )
                ),
              { concurrency: 4, discard: true }
            );
            const receipts = yield* Effect.try(() => ledger.pending(now, 8));
            yield* Effect.forEach(
              receipts,
              (receipt) =>
                advanceOwned(receipt).pipe(
                  Effect.catchCause((cause) =>
                    Cause.hasInterrupts(cause)
                      ? Effect.failCause(cause)
                      : persist(receipt, {
                          state: receipt.state === 'submitting' ? 'unknown' : receipt.state,
                          reason: 'adapter_unavailable',
                          retryAt: now + 15_000,
                        }).pipe(Effect.andThen(host.report(cause)))
                  )
                ),
              { concurrency: 4, discard: true }
            );
            const after = yield* Clock.currentTimeMillis;
            if (
              ledger.dueWaits(after, 1).length ||
              ledger.deliveries(1).length ||
              ledger.pending(after, 1).length
            )
              yield* wake;
          })
        );
        yield* Effect.forever(
          Queue.take(signal).pipe(
            Effect.andThen(pass),
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause) ? Effect.failCause(cause) : host.report(cause)
            )
          )
        ).pipe(Effect.forkScoped);
        let lastMaintenance = 0;
        yield* Effect.forever(
          Effect.sleep('1 second').pipe(
            Effect.andThen(
              Effect.gen(function* () {
                const now = yield* Clock.currentTimeMillis;
                if (now - lastMaintenance >= 15_000 || ledger.dueWaits(now, 1).length) {
                  lastMaintenance = now;
                  yield* wake;
                }
              })
            )
          )
        ).pipe(Effect.forkScoped);
        yield* wake;
        return {
          wake,
          pass,
          cancel: Effect.fn('Automations.cancel')(function* (id: string) {
            const wait = ledger.wait(id);
            if (wait) {
              const now = yield* Clock.currentTimeMillis;
              const cancelled = ledger.cancelWait(id, now);
              const running = checking.get(id);
              if (running) {
                yield* Deferred.succeed(running.stop, undefined);
                yield* Deferred.await(running.done);
              }
              if (!cancelled?.invocationId) {
                yield* wake;
                return;
              }
              id = cancelled.invocationId;
            }
            const receipt = yield* Effect.try(() => ledger.receipt(id));
            if (!receipt) return;
            if (
              ['submitting', 'queued', 'running', 'unknown', 'cancelling'].includes(receipt.state)
            ) {
              // Revoke admission before awaiting the resource owner. A racing submit
              // cannot overwrite this fence; restart continues exact-input cancellation.
              const fenced = yield* persist(receipt, {
                state: 'cancelling',
                reason: 'user_cancel_requested',
              });
              if (fenced) {
                // Join this invocation only; an unrelated provider read cannot delay Stop.
                const running = active.get(id);
                if (running) yield* Deferred.await(running);
                const current = ledger.receipt(id);
                if (current?.state === 'cancelling') yield* advanceOwned(current);
              }
            } else {
              const now = yield* Clock.currentTimeMillis;
              yield* Effect.try(() => ledger.cancel(id, now));
            }
            yield* wake;
          }),
        };
      })
    );
  }
}
