import { Cause, Deferred, Effect, Exit, Fiber, Layer, Scope } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'vitest';
import {
  makeOwnedPersonalDeviceHost,
  PersonalCloseIncomplete,
  type PersonalHostPorts,
  type PersonalCloseOwner,
} from '../src/owned-host';

it('failed port acquisition preserves the original failure and releases its actual resources', async () => {
  const failure = new Error('synthetic startup failure');
  const resource = { open: false };
  const ports: Layer.Layer<PersonalHostPorts, Error> = Layer.effectContext(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          resource.open = true;
        }),
        () =>
          Effect.sync(() => {
            resource.open = false;
          })
      );
      return yield* Effect.fail(failure);
    })
  );
  const result = await Effect.runPromiseExit(Effect.scoped(makeOwnedPersonalDeviceHost(ports)));
  expect(Exit.isFailure(result)).toBe(true);
  if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toBe(failure);
  expect(resource.open).toBe(false);
});

it('startup and parent-scope failure retain an unfinished resource owner past the close budget', async () => {
  const failure = new Error('synthetic startup failure');
  const resource = { open: false };
  let retained: PersonalCloseOwner | undefined;
  await Effect.runPromise(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>();
      const ports: Layer.Layer<PersonalHostPorts, Error> = Layer.effectContext(
        Effect.gen(function* () {
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              resource.open = true;
            }),
            () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
                resource.open = false;
              })
          );
          return yield* Effect.fail(failure);
        })
      );
      yield* Effect.gen(function* () {
        const parent = yield* Scope.make();
        const acquiring = yield* Effect.forkChild(
          Effect.exit(makeOwnedPersonalDeviceHost(ports).pipe(Scope.provide(parent)))
        );
        yield* Deferred.await(entered);
        const closing = yield* Effect.forkChild(Effect.exit(Scope.close(parent, Exit.void)));
        yield* TestClock.adjust(5000);
        const outcome = yield* Fiber.join(closing);
        expect(Exit.isFailure(outcome)).toBe(true);
        if (Exit.isSuccess(outcome)) throw new Error('parent close should report incomplete');
        const incomplete = outcome.cause.reasons.flatMap((reason) => {
          const error = Cause.isFailReason(reason)
            ? reason.error
            : Cause.isDieReason(reason)
              ? reason.defect
              : undefined;
          return error instanceof PersonalCloseIncomplete ? [error] : [];
        });
        expect(incomplete.length).toBeGreaterThan(0);
        retained = incomplete[0]!.owner;
        expect(yield* retained.settled()).toBe(false);
        expect(resource.open).toBe(true);
        yield* Fiber.interrupt(acquiring);
        yield* Deferred.succeed(release, undefined);
        yield* retained.awaitSettled();
        expect(resource.open).toBe(false);
        expect(yield* retained.settled()).toBe(true);
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* Deferred.succeed(release, undefined);
            if (retained) yield* retained.awaitSettled().pipe(Effect.orDie);
          })
        )
      );
    }).pipe(Effect.provide(TestClock.layer({ warningDelay: '1 hour' })))
  );
});
