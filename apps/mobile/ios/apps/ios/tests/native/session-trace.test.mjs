import test from 'node:test';
import assert from 'node:assert/strict';
import { LoroDoc } from 'loro-crdt/base64';
import { loadRuntime } from '../helpers.mjs';

test('session reads report retries, status changes and the in-flight read on resume', async () => {
  const server = new LoroDoc();
  let reads = 0;
  globalThis.__sessionClient = class {
    async bootstrap() {
      return {
        ok: true,
        result: {
          snapshotOffset: '1',
          nextOffset: '1',
          upToDate: true,
          snapshot: { body: server.export({ mode: 'snapshot' }) },
          updates: [],
        },
      };
    }
    async readOnce() {
      reads += 1;
      if (reads === 1) return { ok: false, result: { code: 'timeout' } };
      return new Promise(() => {});
    }
  };
  const runtime = await loadRuntime();
  const traces = [];
  runtime.setSessionTraceSink((event) => traces.push(event));
  try {
    await runtime.openSession(
      's1',
      'w1',
      async () => ({ token: 'synthetic', gatewayBaseUrl: 'https://x.invalid' }),
      () => {},
      async () => {},
    );
    const deadline = Date.now() + 3000;
    while (reads < 2 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(reads, 2, 'The failed long-poll is retried');
    runtime.traceSessionResume();
    runtime.traceStalledReads(Date.now() + 49_000);
    assert.ok(
      !traces.some((trace) => trace.event === 'stalled'),
      'A long-poll inside its timeout is not stalled',
    );
    runtime.traceStalledReads(Date.now() + 51_000);
    runtime.traceStalledReads(Date.now() + 90_000);
    const stalled = traces.filter((trace) => trace.event === 'stalled');
    assert.equal(stalled.length, 1, 'A stalled read is reported once');
    assert.equal(stalled[0].stage, 'poll');
    assert.equal(stalled[0].status, 'syncing');
    const retry = traces.find((trace) => trace.event === 'retry');
    assert.equal(retry.sessionId, 's1');
    assert.equal(retry.stage, 'poll');
    assert.equal(retry.code, 'timeout');
    assert.equal(retry.attempts, 1);
    assert.equal(typeof retry.ageMs, 'number');
    assert.deepEqual(
      traces
        .filter((trace) => trace.event === 'status')
        .map((trace) => [trace.status, trace.code]),
      [
        ['live', undefined],
        ['syncing', 'timeout'],
      ],
    );
    const resume = traces.find((trace) => trace.event === 'resume');
    assert.equal(resume.status, 'syncing');
    assert.equal(resume.stage, 'poll');
    assert.equal(typeof resume.ageMs, 'number');
    for (const trace of traces)
      assert.ok(
        !JSON.stringify(trace).includes('synthetic'),
        'Traces never carry grants',
      );
  } finally {
    runtime.stopSessions();
    delete globalThis.__sessionClient;
  }
});
