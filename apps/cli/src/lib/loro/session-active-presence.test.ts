import { describe, expect, vi } from 'vitest';
import { it } from '@effect/vitest';
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Scope } from 'effect';
import { TestClock } from 'effect/testing';
import { type MachineId, type SessionId, type SessionStatus } from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { captureMessage, isErrorReportingEnabled } from '@/instrument';
import {
  makeSessionActivePresence,
  SessionPresenceHost,
  type SessionActivePresenceOptions,
  type SessionPresenceDiagnostic,
} from './session-active-presence';
import {
  SessionActivePresenceControllerLegacy,
  SessionPresenceLegacyFailure,
} from './session-active-presence-legacy';

vi.mock('../analytics/posthog', () => ({ captureCli: vi.fn() }));
vi.mock('@/instrument', () => ({
  captureMessage: vi.fn(async () => {}),
  isErrorReportingEnabled: vi.fn(() => false),
}));
const sessionId = 'session-active-presence-1' as SessionId;
const otherId = 'session-active-presence-2' as SessionId;
const machineId = 'machine-active-presence-1' as MachineId;
const logger = { debug: () => {}, warn: () => {} } as unknown as Logger;

const harness = Effect.fnUntraced(function* (options: SessionActivePresenceOptions = {}) {
  const entries = new Map<SessionId, SessionStatus>();
  const writes: Array<{ id: SessionId; status: SessionStatus }> = [];
  const events: SessionPresenceDiagnostic[] = [];
  let clearError: unknown;
  let publishError: unknown;
  const host = SessionPresenceHost.of({
    publish: (id, status) => {
      if (publishError) throw publishError;
      entries.set(id, status);
      writes.push({ id, status });
    },
    clear: (id) => {
      if (clearError) throw clearError;
      entries.delete(id);
    },
    report: (event) => {
      events.push(event);
    },
  });
  const owner = yield* makeSessionActivePresence({ intervalMs: 1_000, ...options }).pipe(
    Effect.provideService(SessionPresenceHost, host)
  );
  return {
    owner,
    entries,
    writes,
    events,
    failClear: (error?: unknown) => {
      clearError = error;
    },
    failPublish: (error?: unknown) => {
      publishError = error;
    },
  };
});

const close = (scope: Scope.Closeable) => Scope.close(scope, Exit.void);

describe('native session presence leases', () => {
  it.effect(
    'publishes immediately, heartbeats and removes the entry only when its lease closes',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          const lease = yield* Scope.make();
          const clock = yield* Clock.Clock;
          let sleeping = 0;
          const trackingClock: Clock.Clock = {
            monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
            monotonicTimeNanos: clock.monotonicTimeNanos,
            currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
            currentTimeMillis: clock.currentTimeMillis,
            currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
            currentTimeNanos: clock.currentTimeNanos,
            sleep: (duration: Parameters<typeof clock.sleep>[0]) =>
              Effect.acquireUseRelease(
                Effect.sync(() => {
                  sleeping += 1;
                }),
                () => clock.sleep(duration),
                () =>
                  Effect.sync(() => {
                    sleeping -= 1;
                  })
              ),
          };
          yield* Scope.provide(
            h.owner.hold(sessionId).pipe(Effect.provideService(Clock.Clock, trackingClock)),
            lease
          );
          expect(sleeping).toBe(1);
          expect(h.entries.get(sessionId)).toEqual({ type: 'running' });
          yield* TestClock.adjust(1_000);
          expect(h.writes.map((write) => write.status)).toEqual([
            { type: 'running' },
            { type: 'running' },
          ]);
          yield* close(lease);
          expect(h.entries.has(sessionId)).toBe(false);
          expect(h.owner.has(sessionId)).toBe(false);
          expect(sleeping).toBe(0);
          yield* TestClock.adjust(3_000);
          expect(h.writes).toHaveLength(2);
        })
      )
  );

  it.effect('releases the lease on owner interruption after explicit admission', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        const ready = yield* Deferred.make<void>();
        const worker = yield* Effect.forkChild(
          Effect.scoped(
            Effect.gen(function* () {
              yield* h.owner.hold(sessionId);
              yield* Deferred.succeed(ready, undefined);
              yield* Effect.never;
            })
          )
        );
        yield* Deferred.await(ready);
        expect(h.entries.has(sessionId)).toBe(true);
        yield* Fiber.interrupt(worker);
        expect(h.entries.has(sessionId)).toBe(false);
        yield* TestClock.adjust(2_000);
        expect(h.writes).toHaveLength(1);
      })
    )
  );

  it.effect('latches a deadline detected before the Turn installs its waiter', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness({ stallBudgetsMs: { initializing: 0 } });
        const leaseScope = yield* Scope.make();
        const lease = yield* Scope.provide(h.owner.hold(sessionId, 'initializing'), leaseScope);
        const stalled = yield* lease.awaitInitializationStall;
        expect(stalled).toEqual({
          stage: 'initializing',
          description: 'initializing',
          stalledMs: 0,
          budgetMs: 0,
        });
        expect(h.writes).toEqual([]);
        expect(h.owner.has(sessionId)).toBe(true);
        yield* close(leaseScope);
      })
    )
  );

  it.effect(
    'updates phase and detail without clearing, dedupes unchanged status and retains finalizing',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          const lease = yield* Scope.make();
          yield* Scope.provide(h.owner.hold(sessionId, 'initializing'), lease);
          h.owner.setPhase(sessionId, 'acp');
          h.owner.setPhase(sessionId, 'managed-runtime', 'Downloading Codex runtime 42%');
          h.owner.setPhase(sessionId, 'managed-runtime', 'Downloading Codex runtime 42%');
          expect(h.writes).toHaveLength(3);
          expect(h.entries.get(sessionId)).toEqual({
            type: 'initializing',
            stage: 'managed-runtime',
            detail: 'Downloading Codex runtime 42%',
          });
          h.owner.setPhase(sessionId, 'requestPermission');
          expect(h.entries.get(sessionId)).toEqual({ type: 'requestPermission' });
          h.owner.setPhase(sessionId, 'image_generation');
          expect(h.entries.get(sessionId)).toEqual({
            type: 'running',
            activity: 'image_generation',
          });
          h.owner.setPhase(sessionId, 'finalizing');
          expect(h.owner.getStatus(sessionId)).toEqual({ type: 'running', phase: 'finalizing' });
          expect(h.owner.activeSessionCount()).toBe(1);
          yield* close(lease);
          expect(h.owner.getStatus(sessionId)).toBeNull();
        })
      )
  );

  it.effect(
    'fires a silent-stage deadline once, stops heartbeats and retains presence until turn cleanup',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness({ stallBudgetsMs: { initializing: 3_000 } });
          const lease = yield* Scope.make();
          yield* Scope.provide(h.owner.hold(sessionId, 'initializing'), lease);
          yield* TestClock.adjust(3_000);
          expect(h.events).toEqual([
            {
              kind: 'stall',
              sessionId,
              stall: {
                stage: 'initializing',
                description: 'initializing',
                stalledMs: 3_000,
                budgetMs: 3_000,
              },
            },
          ]);
          expect(h.entries.has(sessionId)).toBe(true);
          const writes = h.writes.length;
          h.owner.setPhase(sessionId, 'thinking');
          yield* TestClock.adjust(10_000);
          expect(h.events).toHaveLength(1);
          expect(h.writes).toHaveLength(writes);
          yield* close(lease);
          expect(h.entries.has(sessionId)).toBe(false);
        })
      )
  );

  it.effect(
    'resets deadline on changed detail while duplicate progress keeps the old deadline',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness({ stallBudgetsMs: { 'managed-runtime': 3_000 } });
          const lease = yield* Scope.make();
          yield* Scope.provide(h.owner.hold(sessionId, 'managed-runtime', '42%'), lease);
          yield* TestClock.adjust(2_000);
          h.owner.setPhase(sessionId, 'managed-runtime', '43%');
          yield* TestClock.adjust(2_000);
          expect(h.events.filter((event) => event.kind === 'stall')).toEqual([]);
          h.owner.setPhase(sessionId, 'managed-runtime', '43%');
          yield* TestClock.adjust(1_000);
          expect(h.events).toContainEqual({
            kind: 'stall',
            sessionId,
            stall: {
              stage: 'managed-runtime',
              description: '43%',
              stalledMs: 3_000,
              budgetMs: 3_000,
            },
          });
          yield* close(lease);
        })
      )
  );

  it.effect('keeps one generation and prevents an old release from clearing its successor', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        const first = yield* Scope.make();
        const second = yield* Scope.make();
        yield* Scope.provide(h.owner.hold(sessionId), first);
        const duplicate = yield* Scope.provide(h.owner.hold(sessionId), second).pipe(Effect.exit);
        expect(Exit.isFailure(duplicate)).toBe(true);
        yield* close(first);
        yield* Scope.provide(h.owner.hold(sessionId, 'requestPermission'), second);
        yield* close(first);
        expect(h.entries.get(sessionId)).toEqual({ type: 'requestPermission' });
        yield* close(second);
        expect(h.entries.size).toBe(0);
      })
    )
  );

  it.effect('retains a failed clear and blocks replacement until explicit recovery', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        const first = yield* Scope.make();
        const second = yield* Scope.make();
        yield* Scope.provide(h.owner.hold(sessionId), first);
        const error = new Error('Synthetic clear failure');
        h.failClear(error);
        const released = yield* close(first).pipe(Effect.exit);
        expect(
          Exit.isFailure(released) &&
            released.cause.reasons.some(
              (reason) => Cause.isDieReason(reason) && reason.defect === error
            )
        ).toBe(true);
        expect(h.entries.has(sessionId)).toBe(true);
        expect(h.owner.has(sessionId)).toBe(true);
        expect(
          Exit.isFailure(yield* Scope.provide(h.owner.hold(sessionId), second).pipe(Effect.exit))
        ).toBe(true);
        const writes = h.writes.length;
        yield* TestClock.adjust(2_000);
        expect(h.writes).toHaveLength(writes);
        h.failClear();
        yield* h.owner.retryRelease(sessionId);
        expect(h.entries.has(sessionId)).toBe(false);
        yield* Scope.provide(h.owner.hold(sessionId), second);
        yield* close(second);
      })
    )
  );

  it.effect(
    'cleans an initial publish failure and keeps subsequent heartbeat failures observable and retryable',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          const error = new Error('Synthetic publish failure');
          h.failPublish(error);
          const failed = yield* Effect.scoped(h.owner.hold(sessionId)).pipe(Effect.exit);
          expect(Exit.isFailure(failed)).toBe(true);
          expect(h.owner.activeSessionCount()).toBe(0);
          h.failPublish();
          const lease = yield* Scope.make();
          yield* Scope.provide(h.owner.hold(sessionId), lease);
          h.failPublish(error);
          yield* TestClock.adjust(1_000);
          expect(
            h.events.some(
              (event) =>
                event.kind === 'heartbeat-failed' &&
                event.cause.reasons.some(
                  (reason) => Cause.isDieReason(reason) && reason.defect === error
                )
            )
          ).toBe(true);
          h.failPublish();
          yield* TestClock.adjust(1_000);
          expect(h.writes).toHaveLength(2);
          yield* close(lease);
        })
      )
  );

  it.effect(
    'bounds idle observation without releasing any active lease, and retires new admission',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness();
          const first = yield* Scope.make();
          const second = yield* Scope.make();
          yield* Scope.provide(h.owner.hold(sessionId), first);
          yield* Scope.provide(h.owner.hold(otherId), second);
          h.owner.retire();
          const rejected = yield* Effect.scoped(h.owner.hold('new' as SessionId)).pipe(Effect.exit);
          expect(Exit.isFailure(rejected)).toBe(true);
          const waiter = yield* Effect.forkChild(h.owner.awaitIdle(2_000).pipe(Effect.exit));
          yield* TestClock.adjust(2_000);
          const exit = yield* Fiber.join(waiter);
          expect(Exit.isFailure(exit)).toBe(true);
          expect(h.entries.size).toBe(2);
          yield* close(first);
          expect(h.owner.activeSessionCount()).toBe(1);
          yield* close(second);
          yield* h.owner.awaitIdle(0);
          expect(h.entries.size).toBe(0);
        })
      )
  );

  it.effect('emits bounded active-ping and one slow diagnostic per initialization stage', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness({ slowThresholdMs: 2_000 });
        const first = yield* Scope.make();
        yield* Scope.provide(h.owner.hold(sessionId), first);
        yield* TestClock.adjust(59_000);
        expect(h.events).toEqual([]);
        yield* TestClock.adjust(1_000);
        expect(h.events).toEqual([{ kind: 'active-ping', sessionId }]);
        yield* close(first);
        const second = yield* Scope.make();
        yield* Scope.provide(h.owner.hold(sessionId, 'acp'), second);
        yield* TestClock.adjust(3_000);
        expect(h.events.filter((event) => event.kind === 'slow')).toEqual([
          expect.objectContaining({
            kind: 'slow',
            sessionId,
            elapsedMs: 2_000,
            status: { type: 'initializing', stage: 'acp' },
          }),
        ]);
        yield* close(second);
      })
    )
  );
});

describe('Legacy entry ownership', () => {
  it('allows phase updates but refuses incidental clear of an active native Turn', async () => {
    const entries = new Map<SessionId, SessionStatus>();
    const controller = new SessionActivePresenceControllerLegacy(
      {
        publishSessionPresence: (id, _machine, status) => {
          entries.set(id, status);
        },
        clearSessionPresence: (id) => {
          entries.delete(id);
        },
      },
      machineId,
      logger
    );
    const lease = Effect.runSync(Scope.make());
    await Effect.runPromise(Scope.provide(controller.native.hold(sessionId), lease));
    controller.clearUnleased(sessionId);
    expect(entries.get(sessionId)).toEqual({ type: 'running' });
    controller.setPhase(sessionId, 'finalizing');
    expect(entries.get(sessionId)).toEqual({ type: 'running', phase: 'finalizing' });
    await Effect.runPromise(close(lease));
    expect(entries.size).toBe(0);
    const first = controller.close();
    expect(controller.close()).toBe(first);
    await first;
  });

  it('keeps the owner after bounded close fails and recovers only after the actual lease releases', async () => {
    vi.useFakeTimers();
    try {
      const entries = new Map<SessionId, SessionStatus>();
      const controller = new SessionActivePresenceControllerLegacy(
        {
          publishSessionPresence: (id, _machine, status) => {
            entries.set(id, status);
          },
          clearSessionPresence: (id) => {
            entries.delete(id);
          },
        },
        machineId,
        logger
      );
      const lease = Effect.runSync(Scope.make());
      await Effect.runPromise(Scope.provide(controller.native.hold(sessionId), lease));
      const release = controller.close().then(
        () => undefined,
        (error) => error
      );
      await vi.advanceTimersByTimeAsync(5_000);
      const failure = await release;
      expect(failure).toBeInstanceOf(SessionPresenceLegacyFailure);
      expect(entries.has(sessionId)).toBe(true);
      expect(controller.has(sessionId)).toBe(true);
      await Effect.runPromise(close(lease));
      await controller.close();
      expect(entries.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains an actual Legacy monitoring flush after close timeout and joins its later settlement', async () => {
    vi.useFakeTimers();
    vi.mocked(isErrorReportingEnabled).mockReturnValue(true);
    let finish: () => void = () => {};
    const flushing = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.mocked(captureMessage).mockReturnValueOnce(flushing);
    const entries = new Map<SessionId, SessionStatus>();
    const controller = new SessionActivePresenceControllerLegacy(
      {
        publishSessionPresence: (id, _machine, status) => {
          entries.set(id, status);
        },
        clearSessionPresence: (id) => {
          entries.delete(id);
        },
      },
      machineId,
      logger,
      { slowThresholdMs: 0 }
    );
    try {
      controller.start(sessionId, 'acp');
      expect(entries.get(sessionId)).toEqual({ type: 'initializing', stage: 'acp' });
      const release = controller.close().then(
        () => undefined,
        (error) => error
      );
      await vi.advanceTimersByTimeAsync(5_000);
      const failure = await release;
      expect(failure).toBeInstanceOf(SessionPresenceLegacyFailure);
      expect(entries.size).toBe(0);
      finish();
      await controller.close();
      expect(
        Exit.isFailure(await Effect.runPromiseExit(Effect.scoped(controller.native.hold(otherId))))
      ).toBe(true);
    } finally {
      finish();
      vi.mocked(isErrorReportingEnabled).mockReturnValue(false);
      vi.useRealTimers();
    }
  });

  it('joins synchronous Legacy starts and closes its application owner', async () => {
    const entries = new Map<SessionId, SessionStatus>();
    const controller = new SessionActivePresenceControllerLegacy(
      {
        publishSessionPresence: (id, _machine, status) => {
          entries.set(id, status);
        },
        clearSessionPresence: (id) => {
          entries.delete(id);
        },
      },
      machineId,
      logger
    );
    controller.start(sessionId, 'acp');
    controller.start(sessionId, 'thinking');
    expect(entries.get(sessionId)).toEqual({ type: 'running' });
    controller.clearUnleased(sessionId);
    expect(entries.size).toBe(0);
    await controller.close();
  });
});
