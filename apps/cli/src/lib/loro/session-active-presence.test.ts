import { describe, expect, vi } from 'vitest';
import { it } from '@effect/vitest';
import { Effect, Exit, Scope } from 'effect';
import { TestClock } from 'effect/testing';
import {
  encodeProjectPreparationProgress,
  type MachineId,
  type SessionId,
  type SessionStatus,
} from '@lody/shared';
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
  it.effect('hands presence between native work and a turn without releasing the turn early', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness({ intervalMs: 3_000 });
        h.owner.setNativeWork(sessionId, 'background');
        yield* TestClock.adjust(1_000);
        expect(h.entries.get(sessionId)).toEqual({ type: 'running' });
        expect(h.owner.has(sessionId)).toBe(false);

        const turn = yield* Scope.make();
        yield* Scope.provide(h.owner.hold(sessionId, 'requestPermission'), turn);
        expect(h.entries.get(sessionId)).toEqual({ type: 'requestPermission' });
        h.owner.setNativeWork(sessionId, null);
        yield* TestClock.adjust(1_000);
        expect(h.entries.get(sessionId)).toEqual({ type: 'requestPermission' });
        h.owner.setNativeWork(sessionId, 'running');
        yield* close(turn);
        expect(h.entries.get(sessionId)).toEqual({ type: 'running' });
        yield* TestClock.adjust(3_000);
        expect(h.entries.get(sessionId)).toEqual({ type: 'running' });
        h.owner.setNativeWork(sessionId, null);
        yield* TestClock.adjust(1_000);
        expect(h.entries.has(sessionId)).toBe(false);
      })
    )
  );

  it.effect('coalesces rapid native changes and retires native presence', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        h.owner.setNativeWork(sessionId, 'running');
        h.owner.setNativeWork(sessionId, null);
        yield* TestClock.adjust(1_000);
        expect(h.entries.has(sessionId)).toBe(false);
        expect(h.writes).toEqual([]);
        h.owner.setNativeWork(sessionId, 'background');
        yield* TestClock.adjust(1_000);
        expect(h.entries.get(sessionId)).toEqual({ type: 'running' });
        h.owner.retire();
        expect(h.entries.has(sessionId)).toBe(false);
        h.owner.setNativeWork(sessionId, 'running');
        yield* TestClock.adjust(2_000);
        expect(h.entries.has(sessionId)).toBe(false);
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

  it.effect(
    'gives Project Git preparation its own silence budget and renews on member completion',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness({ intervalMs: 30_000 });
          const lease = yield* Scope.make();
          yield* Scope.provide(h.owner.hold(sessionId, 'initializing'), lease);
          yield* Scope.provide(h.owner.hold(otherId, 'initializing'), lease);
          h.owner.setPhase(
            sessionId,
            'git-clone',
            encodeProjectPreparationProgress({ step: 'resolve' })
          );
          yield* TestClock.adjust(180_000);
          expect(h.events.filter((event) => event.kind === 'stall')).toMatchObject([
            { sessionId: otherId, stall: { stage: 'initializing', budgetMs: 180_000 } },
          ]);
          yield* TestClock.adjust(1_590_000);
          h.owner.setPhase(
            sessionId,
            'git-clone',
            encodeProjectPreparationProgress({ step: 'member', done: 1, total: 5, path: 'web' })
          );
          yield* TestClock.adjust(60_000);
          expect(
            h.events.filter((event) => event.kind === 'stall' && event.sessionId === sessionId)
          ).toEqual([]);
          yield* TestClock.adjust(1_740_000);
          expect(
            h.events.filter((event) => event.kind === 'stall' && event.sessionId === sessionId)
          ).toMatchObject([{ stall: { stage: 'git-clone', budgetMs: 1_800_000 } }]);
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
});
