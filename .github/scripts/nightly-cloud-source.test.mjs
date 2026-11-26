import assert from 'node:assert/strict';
import test from 'node:test';
import { admitCloudNightly } from './nightly-cloud-source.mjs';

const HEAD_SHA = 'a'.repeat(40);
const TESTED_SHA = 'b'.repeat(40);

function baseInput(overrides = {}) {
  return {
    context: {
      repository: 'LodyAI/Lody',
      ref: 'refs/heads/main',
      eventName: 'workflow_dispatch',
      sha: HEAD_SHA,
      runId: '12345',
      runNumber: '42',
      runAttempt: '1',
    },
    run: {
      id: 12345,
      run_number: 42,
      head_sha: HEAD_SHA,
      head_branch: 'main',
      event: 'workflow_dispatch',
      created_at: '2026-11-26T02:00:00Z',
    },
    latestTagSha: undefined,
    previous: undefined,
    buildOffset: '0',
    ...overrides,
  };
}

await test('verified mode freezes expected_sha when it is an ancestor of main and keeps validate enabled', () => {
  const result = admitCloudNightly(
    baseInput({
      releaseMode: 'verified',
      expectedSha: TESTED_SHA,
      isCommitOnMain: (sha) => sha === TESTED_SHA,
    })
  );
  assert.equal(result.publish, true);
  assert.equal(result.mode, 'verified');
  assert.equal(result.skipValidate, false);
  assert.equal(result.candidate.ossSha, TESTED_SHA);
  assert.equal(result.candidate.privateSha, TESTED_SHA);
});

await test('verified mode rejects expected_sha that is not on main', () => {
  assert.throws(
    () =>
      admitCloudNightly(
        baseInput({
          releaseMode: 'verified',
          expectedSha: TESTED_SHA,
          isCommitOnMain: () => false,
        })
      ),
    /not an ancestor of main/u
  );
});

await test('emergency mode skips validate, records audit reason, and rejects empty reason', () => {
  assert.throws(
    () => admitCloudNightly(baseInput({ releaseMode: 'emergency', reason: '   ' })),
    /requires a non-empty reason/u
  );
  const result = admitCloudNightly(
    baseInput({
      releaseMode: 'emergency',
      reason: 'hotfix desktop startup crash',
    })
  );
  assert.equal(result.publish, true);
  assert.equal(result.mode, 'emergency');
  assert.equal(result.skipValidate, true);
  assert.equal(result.candidate.releaseMode, 'emergency');
  assert.equal(result.candidate.releaseReason, 'hotfix desktop startup crash');
});
