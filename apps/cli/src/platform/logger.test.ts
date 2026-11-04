import { describe, expect, it } from '@effect/vitest';
import { Cause, Clock, Effect } from 'effect';
import { TestClock } from 'effect/testing';
import type { Logger } from '@/utils/logger';
import { formatSafeLogFields, lodyLoggerLayer } from './logger';

const captureLogger = () => {
  const records: Array<{ level: string; text: string }> = [];
  const sink =
    (level: string) =>
    (...args: unknown[]) =>
      records.push({ level, text: args.join(' ') });
  const logger: Logger = {
    trace: sink('trace'),
    debug: sink('debug'),
    info: sink('info'),
    warn: sink('warn'),
    error: sink('error'),
    success: sink('info'),
    setLevel() {},
    setDebug() {},
    child: () => logger,
    close: async () => {},
  };
  return { logger, records };
};

describe('Effect daemon log projection', () => {
  it.effect(
    'forwards scoped annotations and trace to the existing sink without exposing untrusted fields',
    () =>
      Effect.gen(function* () {
        const { logger, records } = captureLogger();
        const start = yield* Clock.currentTimeMillis;
        yield* TestClock.adjust(250);
        const now = yield* Clock.currentTimeMillis;
        yield* Effect.logTrace('presence boundary').pipe(
          Effect.annotateLogs({
            generation: 2,
            stage: 'post_response',
            elapsedMs: now - start,
            httpStatus: 204,
            token: 'secret-token',
            payload: { secret: 'secret-payload' },
            url: 'https://secret.invalid',
            room: 'secret-room',
            attempt: Infinity,
            seq: -1,
            toString: 'secret-prototype-key',
          }),
          Effect.provide(lodyLoggerLayer(logger, '[owner]'))
        );
        yield* Effect.logDebug('outside scope').pipe(Effect.provide(lodyLoggerLayer(logger)));
        expect(
          formatSafeLogFields({
            stage: 'post',
            code: 'network_error',
            ageMs: 100,
            physicalEntries: 2,
            queuedBytes: 64,
            releasePending: 1,
            token: 'secret',
            url: 'https://secret.invalid',
            payload: { secret: true },
          })
        ).toBe(
          ' {"stage":"post","code":"network_error","ageMs":100,"physicalEntries":2,"queuedBytes":64,"releasePending":1}'
        );
        expect(
          formatSafeLogFields({
            stage: 'secret',
            code: 'secret-token',
            ageMs: Infinity,
            physicalEntries: -1,
            queuedBytes: 'secret',
            releasePending: NaN,
          })
        ).toBe('');
        expect(records).toEqual([
          {
            level: 'trace',
            text: '[owner] presence boundary {"generation":2,"stage":"post_response","elapsedMs":250,"httpStatus":204}',
          },
          { level: 'debug', text: 'outside scope' },
        ]);
      })
  );

  it.effect(
    'preserves severity and failure categories without serializing arbitrary Cause or message objects',
    () =>
      Effect.gen(function* () {
        const { logger, records } = captureLogger();
        const cause = Cause.combine(
          Cause.fail(new Error('secret-token https://secret.invalid')),
          Cause.die({ payload: 'secret' })
        );
        yield* Effect.gen(function* () {
          yield* Effect.logWarning('failed', cause);
          yield* Effect.logError({ token: 'secret-object' });
          yield* Effect.logInfo('ready');
          const failure = yield* Effect.failCause(cause).pipe(Effect.exit);
          expect(failure._tag).toBe('Failure');
          if (failure._tag === 'Failure') expect(failure.cause.reasons).toEqual(cause.reasons);
        }).pipe(Effect.provide(lodyLoggerLayer(logger)));
        expect(records).toEqual([
          { level: 'warn', text: 'failed {"cause":["Fail","Die"]}' },
          { level: 'error', text: '[structured value omitted]' },
          { level: 'info', text: 'ready' },
        ]);
      })
  );
});
