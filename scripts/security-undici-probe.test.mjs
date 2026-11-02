import assert from 'node:assert/strict';
import { test } from 'node:test';
import { probeUndici } from './security-undici-probe.mjs';

test('npm undici rejects excessive encodings without crashing after fetch catch', async () => {
  const result = await probeUndici();
  assert.equal(result.requests, 1);
  assert.equal(result.signal, null);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { rejected: 'fetch failed' });
});

test('the same isolated client still reads a valid response', async () => {
  const result = await probeUndici(undefined, false);
  assert.equal(result.requests, 1);
  assert.equal(result.signal, null);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { body: 'ok' });
});
