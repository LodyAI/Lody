import { Effect, FiberSet, Scope, Exit } from 'effect';
import { expect, it } from 'vitest';
import { handoffOwnedResult } from '../src/handoff';

it.each(['producer', 'transfer'] as const)(
  'canceled %s consumer never abandons owned output',
  async (stage) => {
    const scope = Effect.runSync(Scope.make());
    const tasks = await Effect.runPromise(Scope.provide(FiberSet.make(), scope));
    const body = new Uint8Array(32).fill(0x37);
    let enter!: () => void,
      release!: () => void,
      checks = 0;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const producer =
      stage === 'producer'
        ? Effect.uninterruptible(
            Effect.promise(async () => {
              enter();
              await released;
              return body;
            })
          )
        : Effect.succeed(body);
    const guard = Effect.suspend(() => {
      if (++checks === 2 && stage === 'transfer')
        return Effect.uninterruptible(
          Effect.promise(async () => {
            enter();
            await released;
          })
        );
      return Effect.void;
    });
    const abort = new AbortController();
    const outcome = Effect.runPromise(
      handoffOwnedResult(tasks, producer, guard, (value) => value.fill(0)),
      { signal: abort.signal }
    ).then(
      () => 'success',
      () => 'interrupted'
    );
    try {
      await entered;
      abort.abort();
      expect(await outcome).toBe('interrupted');
      if (stage === 'producer') expect(body.some((byte) => byte !== 0)).toBe(true);
      release();
      await Effect.runPromise(FiberSet.awaitEmpty(tasks));
      expect(body.every((byte) => byte === 0)).toBe(true);
    } finally {
      release();
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  }
);

it('successful output transfers intact to the caller', async () => {
  const body = new Uint8Array(32).fill(0x38);
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const tasks = yield* FiberSet.make();
        return yield* handoffOwnedResult(tasks, Effect.succeed(body), Effect.void, (value) =>
          value.fill(0)
        );
      })
    )
  );
  expect(result).toBe(body);
  expect(result.every((byte) => byte === 0x38)).toBe(true);
  result.fill(0);
});
