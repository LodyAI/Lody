import { describe, expect } from 'vitest';
import { it } from '@effect/vitest';
import { Deferred, Effect, Exit, Fiber, Scope } from 'effect';
import { TestClock } from 'effect/testing';
import {
  makeSessionResidency,
  SessionResidencyClosed,
  type SessionResidencyOptions,
} from './session-residency';

type Doc = { id: number; generation: number; closed: boolean };

type OpenOptions = { label: string };
type CloseOptions = { preserveStatus: boolean };

const harness = (
  overrides: Partial<SessionResidencyOptions<string, Doc, OpenOptions, CloseOptions>> = {}
) => {
  const log: string[] = [];
  let nextId = 0;
  const live = new Set<Doc>();
  let closeFailure: unknown;
  const residency = makeSessionResidency<string, Doc, OpenOptions, CloseOptions>({
    open: (key, retained, openOptions) =>
      Effect.sync(() => {
        if (openOptions) log.push(`open-options ${openOptions.label}`);
        if (retained) {
          log.push(`reopen ${key}#${retained.id}`);
          retained.closed = false;
          live.add(retained);
          return retained;
        }
        const doc = { id: ++nextId, generation: nextId, closed: false };
        log.push(`open ${key}#${doc.id}`);
        live.add(doc);
        return doc;
      }),
    close: (key, doc, closeOptions) =>
      Effect.suspend(() => {
        if (closeOptions) log.push(`close-options preserveStatus=${closeOptions.preserveStatus}`);
        if (closeFailure) {
          log.push(`close-failed ${key}#${doc.id}`);
          return Effect.fail(closeFailure);
        }
        log.push(`close ${key}#${doc.id}`);
        doc.closed = true;
        live.delete(doc);
        return Effect.void;
      }),
    ...overrides,
  });
  return {
    residency,
    log,
    live,
    failClose: (error: unknown) => {
      closeFailure = error;
    },
  };
};

const withLease = <A>(
  residency: ReturnType<typeof harness>['residency'],
  key: string,
  use: (doc: Doc) => Effect.Effect<A, unknown>
) => Effect.scoped(Effect.flatMap(residency.acquire(key), use));

describe('makeSessionResidency', () => {
  it.effect('shares one open across leases and keeps it resident after the last release', () =>
    Effect.gen(function* () {
      const { residency, log } = harness();
      const scope = yield* Scope.make();
      const first = yield* Scope.provide(residency.acquire('s'), scope);
      const second = yield* withLease(residency, 's', (doc) => Effect.succeed(doc));
      expect(second).toBe(first);
      expect(residency.holders('s')).toBe(1);
      yield* Scope.close(scope, Exit.void);

      // Releasing is not a teardown: the value stays resident for reuse.
      expect(residency.holders('s')).toBe(0);
      expect(residency.isResident('s')).toBe(true);
      expect(first.closed).toBe(false);
      expect(log).toEqual(['open s#1']);
    })
  );

  it.effect('refuses to retire a leased Session and touches nothing', () =>
    Effect.gen(function* () {
      const { residency, log } = harness();
      const scope = yield* Scope.make();
      const doc = yield* Scope.provide(residency.acquire('s'), scope);
      let tornDown = false;
      const outcome = yield* residency.retire('s', {
        teardown: () =>
          Effect.sync(() => {
            tornDown = true;
          }),
      });
      expect(outcome).toBe('in-use');
      expect(tornDown).toBe(false);
      expect(doc.closed).toBe(false);
      yield* Scope.close(scope, Exit.void);
      expect(log).toEqual(['open s#1']);
    })
  );

  it.effect('retires only after the minimum idle time since the last release', () =>
    Effect.gen(function* () {
      const { residency, log } = harness();
      yield* withLease(residency, 's', () => Effect.void);
      yield* TestClock.adjust('19 minutes');
      expect(yield* residency.retire('s', { minIdleMs: 20 * 60_000 })).toBe('recently-used');
      yield* TestClock.adjust('1 minute');
      expect(yield* residency.retire('s', { minIdleMs: 20 * 60_000 })).toBe('retired');
      expect(residency.isResident('s')).toBe(false);

      const reopened = yield* withLease(residency, 's', (doc) => Effect.succeed(doc));
      expect(reopened.id).toBe(2);
      expect(log).toEqual(['open s#1', 'close s#1', 'open s#2']);
    })
  );

  it.effect('makes an acquire that arrives during retirement wait for a fresh generation', () =>
    Effect.gen(function* () {
      const { residency, log, live } = harness();
      yield* withLease(residency, 's', () => Effect.void);
      const teardownStarted = yield* Deferred.make<void>();
      const teardownMayFinish = yield* Deferred.make<void>();
      const retirement = yield* Effect.forkChild(
        residency.retire('s', {
          teardown: (doc) =>
            Deferred.succeed(teardownStarted, undefined).pipe(
              Effect.andThen(Deferred.await(teardownMayFinish)),
              // The teardown finishes its writes on the resident value it is handed.
              Effect.andThen(Effect.sync(() => log.push(`teardown s#${doc?.id}`)))
            ),
        })
      );
      yield* Deferred.await(teardownStarted);

      // Like the Inbox turn that arrived 2 ms into GC: it must not get the doomed value.
      const arrival = yield* Effect.forkChild(
        withLease(residency, 's', (doc) =>
          Effect.sync(() => {
            log.push(`use s#${doc.id}`);
            return { doc, liveWhileUsed: live.size };
          })
        )
      );
      yield* Effect.yieldNow;
      expect(log).toEqual(['open s#1']);

      yield* Deferred.succeed(teardownMayFinish, undefined);
      expect(yield* Fiber.join(retirement)).toBe('retired');
      const used = yield* Fiber.join(arrival);
      expect(used.doc.id).toBe(2);
      expect(used.doc.closed).toBe(false);
      expect(used.liveWhileUsed).toBe(1);
      expect(log).toEqual(['open s#1', 'teardown s#1', 'close s#1', 'open s#2', 'use s#2']);
    })
  );

  it.effect('keeps the Session resident when its teardown fails', () =>
    Effect.gen(function* () {
      const { residency, log } = harness();
      const doc = yield* withLease(residency, 's', (value) => Effect.succeed(value));
      const result = yield* Effect.exit(
        residency.retire('s', { teardown: () => Effect.fail(new Error('terminate failed')) })
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(doc.closed).toBe(false);
      const again = yield* withLease(residency, 's', (value) => Effect.succeed(value));
      expect(again).toBe(doc);
      expect(log).toEqual(['open s#1']);
    })
  );

  it.effect('reinitializes a value retained by a failed close instead of opening a second', () =>
    Effect.gen(function* () {
      const { residency, log, failClose } = harness();
      yield* withLease(residency, 's', () => Effect.void);
      failClose(new Error('persist failed'));
      expect(Exit.isFailure(yield* Effect.exit(residency.retire('s')))).toBe(true);
      expect(residency.isResident('s')).toBe(true);
      expect(residency.peek('s')).toBeUndefined();

      // The fault clears; the next normal acquire recovers the same value.
      failClose(undefined);
      const recovered = yield* withLease(residency, 's', (doc) => Effect.succeed(doc));
      expect(recovered.id).toBe(1);
      expect(yield* residency.retire('s')).toBe('retired');
      expect(log).toEqual(['open s#1', 'close-failed s#1', 'reopen s#1', 'close s#1']);
    })
  );

  it.effect('evaluates a veto under the gate and keeps a vetoed Session', () =>
    Effect.gen(function* () {
      const { residency, log } = harness();
      yield* withLease(residency, 's', () => Effect.void);
      expect(yield* residency.retire('s', { veto: Effect.succeed(true) })).toBe('vetoed');
      expect(residency.isResident('s')).toBe(true);
      expect(log).toEqual(['open s#1']);
    })
  );

  it.effect('defers a retirement requested while leased until the last release', () =>
    Effect.gen(function* () {
      const { residency, log } = harness();
      const scope = yield* Scope.make();
      const doc = yield* Scope.provide(residency.acquire('s'), scope);
      expect(yield* residency.retire('s', { deferWhileInUse: true })).toBe('deferred');
      expect(doc.closed).toBe(false);
      yield* Scope.close(scope, Exit.void);
      expect(doc.closed).toBe(true);
      expect(residency.isResident('s')).toBe(false);
      expect(log).toEqual(['open s#1', 'close s#1']);
    })
  );

  it.effect('leaves nothing behind when an open fails, so the next acquire retries', () =>
    Effect.gen(function* () {
      let fail = true;
      const { residency } = harness({
        open: () =>
          fail
            ? Effect.fail(new Error('join failed'))
            : Effect.succeed({ id: 9, generation: 9, closed: false }),
      });
      expect(Exit.isFailure(yield* Effect.exit(withLease(residency, 's', () => Effect.void)))).toBe(
        true
      );
      expect(residency.isResident('s')).toBe(false);
      expect(residency.keys()).toEqual([]);
      fail = false;
      const doc = yield* withLease(residency, 's', (value) => Effect.succeed(value));
      expect(doc.id).toBe(9);
    })
  );

  it.effect('retires an unopened Session by running only its teardown', () =>
    Effect.gen(function* () {
      const { residency, log } = harness();
      const outcome = yield* residency.retire('idle-process-only', {
        teardown: (doc) => Effect.sync(() => log.push(`teardown idle-process-only ${doc}`)),
      });
      expect(outcome).toBe('retired');
      expect(residency.keys()).toEqual([]);
      expect(log).toEqual(['teardown idle-process-only undefined']);
    })
  );

  it.effect('passes the triggering acquire and retire options to open and close', () =>
    Effect.gen(function* () {
      const { residency, log } = harness();
      yield* Effect.scoped(residency.acquire('s', { label: 'observe' }));
      yield* Effect.scoped(residency.acquire('s', { label: 'ignored-while-open' }));
      expect(yield* residency.retire('s', { close: { preserveStatus: true } })).toBe('retired');
      expect(log).toEqual([
        'open-options observe',
        'open s#1',
        'close-options preserveStatus=true',
        'close s#1',
      ]);
    })
  );

  it.effect('closes every value at shutdown, leased or not, and refuses later acquires', () =>
    Effect.gen(function* () {
      const { residency, log } = harness();
      const scope = yield* Scope.make();
      const leased = yield* Scope.provide(residency.acquire('leased'), scope);
      yield* Effect.scoped(residency.acquire('idle'));
      yield* residency.shutdown();
      expect(leased.closed).toBe(true);
      expect(residency.keys()).toEqual([]);
      const late = yield* Effect.flip(Effect.scoped(residency.acquire('idle')));
      expect(late).toBeInstanceOf(SessionResidencyClosed);
      // A lease released after shutdown is a no-op.
      yield* Scope.close(scope, Exit.void);
      expect(log).toEqual(['open leased#1', 'open idle#2', 'close leased#1', 'close idle#2']);
    })
  );

  it.effect('lets an observation lease protect a value without postponing its retirement', () =>
    Effect.gen(function* () {
      const { residency } = harness();
      yield* withLease(residency, 's', () => Effect.void);
      yield* TestClock.adjust('21 minutes');

      // Like GC's goal check: it holds the value while reading it...
      const scope = yield* Scope.make();
      yield* Scope.provide(residency.acquire('s', undefined, 'observe'), scope);
      expect(yield* residency.retire('s', { minIdleMs: 20 * 60_000 })).toBe('in-use');
      yield* Scope.close(scope, Exit.void);

      // ...but does not count as use once released.
      expect(residency.idleSinceMs('s')).toBe(0);
      expect(yield* residency.retire('s', { minIdleMs: 20 * 60_000 })).toBe('retired');
    })
  );

  it.effect('restarts the idle clock when a use overlaps an observation', () =>
    Effect.gen(function* () {
      const { residency } = harness();
      yield* withLease(residency, 's', () => Effect.void);
      yield* TestClock.adjust('21 minutes');
      const observing = yield* Scope.make();
      yield* Scope.provide(residency.acquire('s', undefined, 'observe'), observing);
      yield* withLease(residency, 's', () => Effect.void);
      yield* Scope.close(observing, Exit.void);
      expect(yield* residency.retire('s', { minIdleMs: 20 * 60_000 })).toBe('recently-used');
    })
  );

  it.effect('keeps a value opened only for observation immediately retirable', () =>
    Effect.gen(function* () {
      const { residency, log } = harness();
      yield* Effect.scoped(residency.acquire('s', undefined, 'observe'));
      expect(residency.idleSinceMs('s')).toBeUndefined();
      expect(yield* residency.retire('s', { minIdleMs: 20 * 60_000 })).toBe('retired');
      expect(log).toEqual(['open s#1', 'close s#1']);
    })
  );
});
