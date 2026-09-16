import { performance } from 'perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startTraceSpan } from './trace-span';
import type { Logger } from './logger';

type RecordedLogger = Logger & { records: Array<{ sink: 'debug' | 'trace'; line: string }> };

const createRecordingLogger = (): RecordedLogger => {
  const records: Array<{ sink: 'debug' | 'trace'; line: string }> = [];
  const logger: RecordedLogger = {
    records,
    debug: (...args) => records.push({ sink: 'debug', line: String(args[0]) }),
    trace: (...args) => records.push({ sink: 'trace', line: String(args[0]) }),
    info: () => {},
    warn: () => {},
    error: () => {},
    success: () => {},
    setLevel: () => {},
    setDebug: () => {},
    child: () => logger,
    close: async () => {},
  };
  return logger;
};

/** Drives span durations without a real clock: each `now()` call reads the next value. */
const scriptClock = (...valuesMs: number[]): void => {
  const queue = [...valuesMs];
  vi.spyOn(performance, 'now').mockImplementation(() => queue.shift() ?? 0);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('startTraceSpan', () => {
  it('sends ordinary spans to the debug sink', () => {
    const logger = createRecordingLogger();
    scriptClock(0, 5);

    startTraceSpan(logger, 'dispatch.read_meta', { sessionId: 's1' }).end();

    expect(logger.records.map((record) => record.sink)).toEqual(['debug', 'debug']);
  });

  it('keeps a healthy hot span out of the debug sink', () => {
    const logger = createRecordingLogger();
    scriptClock(0, 12);

    startTraceSpan(logger, 'acp.flush_updates_batch', undefined, { hot: true }).end();

    expect(logger.records.map((record) => record.sink)).toEqual(['trace', 'trace']);
  });

  it('reports a hot span that runs past its slow threshold on the debug sink', () => {
    const logger = createRecordingLogger();
    scriptClock(0, 750);

    startTraceSpan(logger, 'acp.flush_updates_batch', undefined, {
      hot: true,
      slowMs: 500,
    }).end();

    expect(logger.records.map((record) => record.sink)).toEqual(['trace', 'debug']);
    expect(logger.records[1]?.line).toContain('durationMs=750');
  });

  it('reports a failed hot span on the debug sink', () => {
    const logger = createRecordingLogger();
    scriptClock(0, 3);

    startTraceSpan(logger, 'acp.flush_updates_batch', undefined, { hot: true }).fail(
      new Error('flush exploded')
    );

    expect(logger.records.map((record) => record.sink)).toEqual(['trace', 'debug']);
    expect(logger.records[1]?.line).toContain('status=error');
  });

  it('closes a span once, so a late end after fail adds no record', () => {
    const logger = createRecordingLogger();
    scriptClock(0, 1, 2);

    const span = startTraceSpan(logger, 'acp.flush_updates_batch', undefined, { hot: true });
    span.fail(new Error('boom'));
    span.end();

    expect(logger.records).toHaveLength(2);
  });
});
