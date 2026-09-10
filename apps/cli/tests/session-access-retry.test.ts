import { describe, expect, it, vi } from 'vitest';
import { Cause, Duration, Effect, Exit, Fiber, Option, TestClock, TestContext } from 'effect';
import {
  AccessDenied,
  MachineAccessVerificationError,
  readMachineAccessWithBoundedRetry,
  verifyMachineAccessWithRetry,
  type MachineAccessVerification,
} from '../src/session/session-access-retry';

const allowed: MachineAccessVerification = { outcome: 'allowed' };
const denied = (
  reason: Extract<MachineAccessVerification, { outcome: 'denied' }>['reason']
): MachineAccessVerification => ({ outcome: 'denied', reason });
const indeterminate = (cause: 'network' | 'auth'): MachineAccessVerification => ({
  outcome: 'indeterminate',
  cause,
  error: `${cause} failure`,
});

// Runs `program` under a virtual clock, advancing time and returning the final Exit.
const runWithClock = <A, E>(
  program: Effect.Effect<A, E>,
  drive: (fiber: Fiber.RuntimeFiber<A, E>) => Effect.Effect<unknown>
): Promise<Exit.Exit<A, E>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(program);
      yield* drive(fiber);
      return yield* Fiber.await(fiber);
    }).pipe(Effect.provide(TestContext.TestContext))
  );

describe('verifyMachineAccessWithRetry', () => {
  it('succeeds immediately when access is allowed', async () => {
    const verify = vi.fn(async () => allowed);

    const exit = await runWithClock(
      verifyMachineAccessWithRetry({ verify, onAuthEscalation: () => {}, jitter: false }),
      () => Effect.void
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('retries on indeterminate and succeeds once access recovers', async () => {
    const verify = vi
      .fn<() => Promise<MachineAccessVerification>>()
      .mockResolvedValueOnce(indeterminate('network'))
      .mockResolvedValueOnce(indeterminate('network'))
      .mockResolvedValue(allowed);

    // Over-advancing is safe: success terminates the retry, so the count is exact.
    const exit = await runWithClock(
      verifyMachineAccessWithRetry({
        verify,
        onAuthEscalation: () => {},
        jitter: false,
        baseDelay: Duration.seconds(2),
      }),
      () => TestClock.adjust(Duration.minutes(5))
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(verify).toHaveBeenCalledTimes(3); // attempts at t=0, +2s, +6s
  });

  it('stops retrying and fails with AccessDenied on a definitive denial', async () => {
    const verify = vi
      .fn<() => Promise<MachineAccessVerification>>()
      .mockResolvedValueOnce(indeterminate('network'))
      .mockResolvedValue(denied('not_visible'));

    const exit = await runWithClock(
      verifyMachineAccessWithRetry({ verify, onAuthEscalation: () => {}, jitter: false }),
      () => TestClock.adjust(Duration.minutes(5))
    );

    // A definitive deny must propagate (so the caller can fail the turn) — the
    // `whileInput` predicate stops the schedule on a non-indeterminate error.
    expect(Exit.isFailure(exit)).toBe(true);
    const error = Exit.isFailure(exit) ? Option.getOrNull(Cause.failureOption(exit.cause)) : null;
    expect(error).toBeInstanceOf(AccessDenied);
    expect((error as AccessDenied | null)?.reason).toBe('not_visible');
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('escalates exactly once after sustained auth failures, then keeps retrying', async () => {
    const verify = vi.fn(async () => indeterminate('auth'));
    const onAuthEscalation = vi.fn();

    const exit = await runWithClock(
      verifyMachineAccessWithRetry({
        verify,
        onAuthEscalation,
        jitter: false,
        escalateAfter: 3,
        baseDelay: Duration.seconds(2),
      }),
      (fiber) =>
        Effect.gen(function* () {
          // delays 2,4,8 → attempts at t=0,2,6,14; escalation at the 3rd failure
          yield* TestClock.adjust(Duration.seconds(20));
          yield* Fiber.interrupt(fiber); // retries forever — stop it ourselves
        })
    );

    expect(onAuthEscalation).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(Exit.isInterrupted(exit)).toBe(true);
  });

  it('treats a hung verify call as transient and retries after the timeout', async () => {
    const verify = vi
      .fn<() => Promise<MachineAccessVerification>>()
      .mockImplementationOnce(() => new Promise<MachineAccessVerification>(() => {})) // never resolves
      .mockResolvedValue(allowed);

    const exit = await runWithClock(
      verifyMachineAccessWithRetry({
        verify,
        onAuthEscalation: () => {},
        jitter: false,
        baseDelay: Duration.seconds(2),
        verifyTimeout: Duration.seconds(10),
      }),
      () => TestClock.adjust(Duration.minutes(5))
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(verify).toHaveBeenCalledTimes(2); // hung attempt times out, second succeeds
  });

  it('caps the backoff so retries keep flowing during a long outage', async () => {
    const verify = vi.fn(async () => indeterminate('network'));

    await runWithClock(
      verifyMachineAccessWithRetry({
        verify,
        onAuthEscalation: () => {},
        jitter: false,
        baseDelay: Duration.seconds(2),
        maxDelay: Duration.seconds(10),
      }),
      (fiber) =>
        Effect.gen(function* () {
          yield* TestClock.adjust(Duration.seconds(60));
          yield* Fiber.interrupt(fiber);
        })
    );

    // Capped delays (2,4,8,10,10,10,…) fire ~8 attempts within 60s. An uncapped
    // exponential (2,4,8,16,32,64) would manage only ~5 — so >=7 proves the cap.
    expect(verify.mock.calls.length).toBeGreaterThanOrEqual(7);
  });

  it('interruption mid-backoff fires no escalation and no failure', async () => {
    const verify = vi.fn(async () => indeterminate('auth'));
    const onAuthEscalation = vi.fn();

    const exit = await runWithClock(
      verifyMachineAccessWithRetry({
        verify,
        onAuthEscalation,
        jitter: false,
        escalateAfter: 5,
        baseDelay: Duration.seconds(2),
      }),
      (fiber) =>
        Effect.gen(function* () {
          yield* TestClock.adjust(Duration.seconds(2)); // only ~2 attempts (<5 threshold)
          yield* Fiber.interrupt(fiber);
        })
    );

    expect(Exit.isInterrupted(exit)).toBe(true);
    expect(onAuthEscalation).not.toHaveBeenCalled();
  });
});

describe('readMachineAccessWithBoundedRetry', () => {
  it('retries transient fetch failures and returns the definitive result', async () => {
    const verify = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(Object.assign(new Error('connect reset'), { code: 'ECONNRESET' }))
      .mockResolvedValue({ allowed: true });
    const sleep = vi.fn(async () => undefined);

    await expect(
      readMachineAccessWithBoundedRetry({
        verify,
        retryDelaysMs: [10, 20],
        sleep,
      })
    ).resolves.toEqual({ allowed: true });

    expect(verify).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[10], [20]]);
  });

  it('does not retry a non-transport failure', async () => {
    const verify = vi.fn(async () => {
      throw new Error('Authenticated CLI user does not match the session requester.');
    });
    const sleep = vi.fn(async () => undefined);

    const error = await readMachineAccessWithBoundedRetry({ verify, sleep }).catch(
      (cause: unknown) => cause
    );

    expect(error).toBeInstanceOf(MachineAccessVerificationError);
    expect(error).toMatchObject({
      attempts: 1,
      code: 'MACHINE_ACCESS_CHECK_FAILED',
      retryable: false,
    });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('preserves the nested network cause when bounded retries are exhausted', async () => {
    const lowLevel = Object.assign(new Error('socket closed'), { code: 'ECONNRESET' });
    const verify = vi.fn(async () => {
      throw new TypeError('fetch failed', {
        cause: new AggregateError([lowLevel], 'connection attempts failed'),
      });
    });

    const error = await readMachineAccessWithBoundedRetry({
      verify,
      retryDelaysMs: [10, 20],
      sleep: async () => undefined,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(MachineAccessVerificationError);
    expect(error).toMatchObject({
      attempts: 3,
      code: 'MACHINE_ACCESS_UNAVAILABLE',
      retryable: true,
    });
    expect((error as Error).message).toContain('after 3 attempts');
    expect((error as Error).message).toContain('ECONNRESET');
    expect((error as Error).message).toContain('socket closed');
    expect(verify).toHaveBeenCalledTimes(3);
  });
});
