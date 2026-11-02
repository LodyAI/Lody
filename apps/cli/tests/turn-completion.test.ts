import { describe, expect, it } from '@effect/vitest';
import { Cause, Deferred, Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { publishTurnCompletion } from '../src/session/turn-completion';

const fixture = () => {
  const published: string[] = [];
  return {
    published,
    ports: {
      persist: Effect.void,
      confirm: Effect.succeed(true),
      publishUnread: Effect.sync(() => {
        published.push('unread');
      }),
      notify: Effect.sync(() => {
        published.push('notification');
      }),
    },
  };
};

describe('released turn completion publication', () => {
  it.effect('waits for local durability and confirmed sync, then publishes once', () =>
    Effect.gen(function* () {
      const f = fixture();
      const persisted = yield* Deferred.make<void>();
      const confirming = yield* Deferred.make<void>();
      let synced = false;
      const fiber = yield* Effect.forkChild(
        publishTurnCompletion({
          ...f.ports,
          persist: Deferred.await(persisted),
          confirm: Effect.gen(function* () {
            yield* Deferred.succeed(confirming, undefined);
            return synced;
          }),
        })
      );
      expect(f.published).toEqual([]);
      yield* Deferred.succeed(persisted, undefined);
      yield* Deferred.await(confirming);
      expect(f.published).toEqual([]);
      synced = true;
      yield* TestClock.adjust('1 second');
      yield* Fiber.join(fiber);
      expect(f.published).toEqual(['unread', 'notification']);
    })
  );

  it.effect('bounds persistent unconfirmed sync without publishing success', () =>
    Effect.gen(function* () {
      const f = fixture();
      const confirming = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        publishTurnCompletion({
          ...f.ports,
          confirm: Deferred.succeed(confirming, undefined).pipe(Effect.as(false)),
        }).pipe(Effect.exit)
      );
      yield* Deferred.await(confirming);
      yield* TestClock.adjust('30 seconds');
      const exit = yield* Fiber.join(fiber);
      expect(exit._tag).toBe('Failure');
      if (exit._tag === 'Failure')
        expect(Cause.squash(exit.cause)).toMatchObject({ _tag: 'TurnCompletionUnconfirmed' });
      expect(f.published).toEqual([]);
    })
  );

  it.effect('a late confirmation after deadline cannot publish', () =>
    Effect.gen(function* () {
      const f = fixture();
      const confirming = yield* Deferred.make<void>();
      const sync = yield* Deferred.make<boolean>();
      const fiber = yield* Effect.forkChild(
        publishTurnCompletion({
          ...f.ports,
          confirm: Deferred.succeed(confirming, undefined).pipe(
            Effect.andThen(Deferred.await(sync))
          ),
        }).pipe(Effect.exit)
      );
      yield* Deferred.await(confirming);
      yield* TestClock.adjust('30 seconds');
      yield* Fiber.join(fiber);
      yield* Deferred.succeed(sync, true);
      expect(f.published).toEqual([]);
    })
  );

  it.effect('cancels the confirmation waiter without later publication', () =>
    Effect.gen(function* () {
      const f = fixture();
      const confirming = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        publishTurnCompletion({
          ...f.ports,
          confirm: Deferred.succeed(confirming, undefined).pipe(Effect.andThen(Effect.never)),
        })
      );
      yield* Deferred.await(confirming);
      yield* Fiber.interrupt(fiber);
      yield* TestClock.adjust('30 seconds');
      expect(f.published).toEqual([]);
    })
  );

  it.effect('local persistence failure cannot become completed delivery', () =>
    Effect.gen(function* () {
      const f = fixture();
      const exit = yield* Effect.exit(
        publishTurnCompletion({ ...f.ports, persist: Effect.fail(new Error('disk full')) })
      );
      expect(exit._tag).toBe('Failure');
      expect(f.published).toEqual([]);
    })
  );

  it.effect('unread failure does not suppress notification or retry it', () =>
    Effect.gen(function* () {
      const f = fixture();
      const exit = yield* Effect.exit(
        publishTurnCompletion({
          ...f.ports,
          publishUnread: Effect.fail(new Error('metadata unavailable')),
        })
      );
      expect(exit._tag).toBe('Failure');
      expect(f.published).toEqual(['notification']);
    })
  );
  it.effect(
    'retains started writes through interruption and preserves independent channel failures',
    () =>
      Effect.gen(function* () {
        const writing = yield* Deferred.make<void>();
        const notified = yield* Deferred.make<void>();
        const written = yield* Deferred.make<void>();
        const observed: string[] = [];
        const fiber = yield* Effect.forkChild(
          publishTurnCompletion({
            persist: Effect.void,
            confirm: Effect.succeed(true),
            publishUnread: Effect.gen(function* () {
              yield* Deferred.succeed(writing, undefined);
              yield* Deferred.await(written);
              observed.push('unread');
            }),
            notify: Effect.sync(() => {
              observed.push('notification');
            }).pipe(Effect.andThen(Deferred.succeed(notified, undefined))),
          })
        );
        yield* Deferred.await(writing);
        yield* Deferred.await(notified);
        yield* Effect.sync(() => fiber.interruptUnsafe());
        expect(fiber.pollUnsafe()).toBeUndefined();
        expect(observed).toEqual(['notification']);
        yield* Deferred.succeed(written, undefined);
        yield* Fiber.await(fiber);
        expect(observed).toEqual(['notification', 'unread']);

        const result = yield* Effect.exit(
          publishTurnCompletion({
            persist: Effect.void,
            confirm: Effect.succeed(true),
            publishUnread: Effect.fail('metadata unavailable'),
            notify: Effect.fail('notification unavailable'),
          })
        );
        expect(result._tag).toBe('Failure');
        if (result._tag === 'Failure') expect(result.cause.reasons).toHaveLength(2);
      })
  );
});
