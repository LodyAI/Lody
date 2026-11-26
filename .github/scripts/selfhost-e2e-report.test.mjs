import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractPrivateFailureDetails,
  formatPublicStatusLine,
} from './selfhost-e2e-report.mjs';

await test('public status line exposes only suite statuses and never private paths or reasons', () => {
  const report = {
    status: 'failed',
    suites: {
      cloud: {
        status: 'failed',
        reason: '/private/loro-dev/lody/convex/internalSecret.ts exploded',
        journeys: [{ id: 'TURN-001', name: 'Send turn', status: 'failed' }],
      },
      e2e: { status: 'passed', shards: [] },
    },
  };
  const publicLine = formatPublicStatusLine(report, 1);
  assert.equal(publicLine, '[selfhost-e2e] status=failed exitCode=1 suites=cloud:failed,e2e:passed');
  assert.doesNotMatch(publicLine, /convex|internalSecret|loro-dev/u);
});

await test('private failure details retain journey and shard breakdown for internal Feishu alerts', () => {
  const details = extractPrivateFailureDetails({
    status: 'failed',
    suites: {
      cloud: {
        status: 'failed',
        journeys: [{ id: 'TURN-001', name: 'Send turn', status: 'failed' }],
      },
      e2e: {
        status: 'failed',
        shards: [{ id: 'recovery', status: 'failed' }],
      },
    },
  });
  const text = details.join('\n');
  assert.match(text, /TURN-001/u);
  assert.match(text, /recovery/u);
});
