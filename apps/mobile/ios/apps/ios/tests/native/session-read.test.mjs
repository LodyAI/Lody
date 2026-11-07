import assert from 'node:assert/strict';
import test from 'node:test';
import { retrySessionRead } from '../../../../packages/cloud-runtime/src/runtime/session-read.ts';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('session reads reconnect automatically with capped backoff', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  let attempts = 0;
  const failures = [];
  const result = retrySessionRead(
    controller.signal,
    async () => {
      attempts++;
      if (attempts <= 7) throw new Error('network unavailable');
      return 'fresh history';
    },
    (error) => failures.push(error),
  );
  await tick();
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    const before = attempts;
    t.mock.timers.tick(delay - 1);
    await tick();
    assert.equal(attempts, before);
    t.mock.timers.tick(1);
    await tick();
    assert.equal(attempts, before + 1);
  }
  assert.equal(await result, 'fresh history');
  assert.equal(failures.length, 7);
});

test('stopping a session cancels a pending retry and ignores late reads', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  let attempts = 0;
  const result = retrySessionRead(
    controller.signal,
    async () => {
      attempts++;
      throw new Error('offline');
    },
    () => {},
  );
  const rejected = assert.rejects(result, { name: 'AbortError' });
  await tick();
  controller.abort();
  await rejected;
  t.mock.timers.tick(60000);
  await tick();
  assert.equal(attempts, 1);

  const late = new AbortController();
  let resolve;
  const pending = retrySessionRead(
    late.signal,
    () =>
      new Promise((done) => {
        resolve = done;
      }),
    () => assert.fail('cancelled reads must not retry'),
  );
  late.abort();
  resolve('stale history');
  await assert.rejects(pending, { name: 'AbortError' });
});
