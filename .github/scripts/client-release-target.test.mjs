import assert from 'node:assert/strict';
import test from 'node:test';
import { validateManualTarget } from './client-release-target.mjs';
import { admitCloudNightly } from './nightly-cloud-source.mjs';
import { androidVersionCodeForRun } from './android-version-code.mjs';

const sha = 'a'.repeat(40);
function manual(production = true) {
  const state = {
    branch: sha,
    version: production ? '1.2.3' : '1.2.4-next.0',
    jobs: [
      { name: 'release', conclusion: 'success', status: 'completed' },
      { name: 'build-mobile-android', conclusion: 'failure', status: 'completed' },
    ],
    run: {
      id: 42,
      path: '.github/workflows/release-clients.yml',
      event: 'push',
      head_branch: 'release',
      head_sha: sha,
      status: 'completed',
      conclusion: 'failure',
      run_number: 78,
    },
  };
  const args = {
    component: 'android',
    context: {
      repo: { owner: 'LodyAI', repo: 'Lody' },
      eventName: 'workflow_dispatch',
      ref: production ? 'refs/heads/release' : 'refs/heads/main',
      sha,
      runNumber: 123,
    },
    inputs: {
      expected_sha: sha,
      expected_version: state.version,
      ...(production ? { source_run_id: '42' } : {}),
    },
    github: {
      rest: {
        repos: {
          getBranch: async () => ({ data: { commit: { sha: state.branch } } }),
          getContent: async () => ({
            data: {
              encoding: 'base64',
              content: Buffer.from(JSON.stringify({ version: state.version })).toString('base64'),
            },
          }),
        },
        actions: {
          getWorkflowRun: async () => ({ data: state.run }),
          listJobsForWorkflowRun: Symbol('jobs'),
        },
      },
      paginate: async () => state.jobs,
    },
  };
  return { state, args };
}
await test('production recovery freezes the failed source and original build; staging stays separate', async () => {
  assert.deepEqual(await validateManualTarget(manual().args), {
    checkout_sha: sha,
    build_number: '78',
    target_environment: 'cloud-production',
  });
  assert.deepEqual(await validateManualTarget(manual(false).args), {
    checkout_sha: sha,
    build_number: '123',
    target_environment: 'cloud-staging',
  });
});
for (const [name, change] of Object.entries({
  'untrusted branch': (f) => (f.args.context.ref = 'refs/heads/feature'),
  'unpinned workflow': (f) => (f.args.inputs.expected_sha = 'b'.repeat(40)),
  'advanced tip': (f) => (f.state.branch = 'b'.repeat(40)),
  'version mismatch': (f) => (f.state.version = '1.2.4'),
  'missing source run': (f) => delete f.args.inputs.source_run_id,
  'foreign source workflow': (f) => (f.state.run.path = '.github/workflows/deploy.yml'),
  'different source commit': (f) => (f.state.run.head_sha = 'b'.repeat(40)),
  'unfinished source run': (f) => (f.state.run.status = 'in_progress'),
  'source release never created': (f) => (f.state.jobs[0].conclusion = 'failure'),
  'publisher succeeded': (f) => (f.state.jobs[1].conclusion = 'success'),
  'no publisher evidence': (f) => f.state.jobs.pop(),
  'running publisher': (f) => (f.state.jobs[1].status = 'in_progress'),
  'prototype component': (f) => (f.args.component = '__proto__'),
  'prerelease to production': (f) => (f.args.inputs.expected_version = '1.2.3-next.0'),
}))
  await test(`manual admission rejects ${name}`, async () => {
    const f = manual();
    change(f);
    await assert.rejects(validateManualTarget(f.args));
  });

function nightly() {
  return {
    context: {
      repository: 'LodyAI/Lody',
      ref: 'refs/heads/main',
      eventName: 'schedule',
      sha,
      runId: '42',
      runNumber: '3',
      runAttempt: '1',
    },
    run: {
      id: 42,
      run_number: 3,
      head_sha: sha,
      event: 'schedule',
      head_branch: 'main',
      created_at: '2026-11-21T18:00:00Z',
    },
    buildOffset: '10000',
  };
}
await test('scheduled unchanged main is skipped; a manual dispatch can retry the same source', () => {
  const f = nightly();
  f.latestTagSha = sha;
  assert.deepEqual(admitCloudNightly(f), { publish: false });
  f.context.eventName = f.run.event = 'workflow_dispatch';
  const result = admitCloudNightly(f);
  assert.equal(result.publish, true);
  assert.equal(result.candidate.privateSha, sha);
  assert.equal(result.candidate.ossSha, sha);
  assert.equal(result.candidate.buildNumber, '10003');
});
await test('retry keeps original candidate and original Android chronology', () => {
  const f = nightly();
  const original = admitCloudNightly(f).candidate;
  f.previous = original;
  f.context.runAttempt = '2';
  f.buildOffset = '99999999';
  assert.equal(admitCloudNightly(f).candidate, original);
  const run = { head_sha: sha, created_at: original.builtAt };
  assert.equal(androidVersionCodeForRun(run, sha), '217447200');
});
for (const [name, change] of Object.entries({
  'other repository': (f) => (f.context.repository = 'loro-dev/lody'),
  'other branch': (f) => (f.context.ref = 'refs/heads/release'),
  'pull request event': (f) => (f.context.eventName = 'pull_request'),
  'source changed': (f) => (f.run.head_sha = 'b'.repeat(40)),
  'foreign run': (f) => (f.run.id = 43),
  'missing retry artifact': (f) => (f.context.runAttempt = '2'),
  'missing cutover offset': (f) => delete f.buildOffset,
  'overflowed native version': (f) => (f.buildOffset = '99989999'),
  'corrupt timestamp': (f) => (f.run.created_at = 'not a date'),
  'changed retry candidate': (f) => {
    f.previous = admitCloudNightly(f).candidate;
    f.previous.ossSha = 'b'.repeat(40);
    f.context.runAttempt = '2';
  },
}))
  await test(`nightly admission rejects ${name}`, () => {
    const f = nightly();
    change(f);
    assert.throws(() => admitCloudNightly(f));
  });

await test('GitHub release retries preserve existing installer bytes and original release', async () => {
  const { attachReleaseAssets } = await import('./github-release-assets.mjs');
  const { createHash } = await import('node:crypto');
  const bytes = Buffer.from('synthetic signed Lody installer');
  const assets = [];
  const github = {
    rest: {
      repos: {
        getReleaseByTag: async () => ({ data: { id: 42, draft: false } }),
        listReleaseAssets: Symbol('assets'),
        uploadReleaseAsset: async ({ name, data }) =>
          assets.push({
            name,
            size: data.length,
            digest: `sha256:${createHash('sha256').update(data).digest('hex')}`,
          }),
      },
    },
    paginate: async () => assets,
  };
  const args = {
    github,
    repo: { owner: 'LodyAI', repo: 'Lody' },
    version: '1.2.3',
    assets: [{ name: 'Lody-1.2.3-arm64.dmg', read: async () => bytes }],
  };
  await attachReleaseAssets(args);
  await attachReleaseAssets(args);
  assert.deepEqual(
    assets.map((asset) => asset.name),
    ['Lody-1.2.3-arm64.dmg']
  );
  args.assets[0].read = async () => Buffer.from('different installer');
  await assert.rejects(attachReleaseAssets(args), /different or unverifiable/);
  assert.equal(assets[0].digest, `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
});

await test('iOS archives can finish before SEA; publication waits for that exact same-run verification', async () => {
  const { waitForReleaseGate } = await import('./wait-release-gate.mjs');
  let clock = 0;
  let state = [];
  const observed = [];
  const job = {
    name: 'verify-daemon-installation',
    head_sha: sha,
    status: 'in_progress',
    conclusion: null,
  };
  await waitForReleaseGate({
    expectedSha: sha,
    now: () => clock,
    timeoutMs: 100,
    intervalMs: 10,
    getJobs: async () => state,
    sleep: async (ms) => {
      clock += ms;
      observed.push(clock);
      state = clock === 10 ? [job] : [{ ...job, status: 'completed', conclusion: 'success' }];
    },
  });
  assert.deepEqual(observed, [10, 20]);
  assert.equal(clock, 20);
});
for (const conclusion of ['failure', 'cancelled', 'skipped', 'timed_out', 'neutral', null]) {
  await test(`iOS upload remains blocked after SEA conclusion ${conclusion}`, async () => {
    const { waitForReleaseGate } = await import('./wait-release-gate.mjs');
    await assert.rejects(
      waitForReleaseGate({
        expectedSha: sha,
        getJobs: async () => [
          { name: 'verify-daemon-installation', head_sha: sha, status: 'completed', conclusion },
        ],
      }),
      /did not succeed/
    );
  });
}
await test('missing SEA verification has a bounded wait; source mismatch and ambiguous verification fail closed', async () => {
  const { waitForReleaseGate } = await import('./wait-release-gate.mjs');
  let clock = 0;
  await assert.rejects(
    waitForReleaseGate({
      expectedSha: sha,
      now: () => clock,
      timeoutMs: 15,
      intervalMs: 10,
      getJobs: async () => [],
      sleep: async (ms) => {
        clock += ms;
      },
    }),
    /Timed out/
  );
  assert.equal(clock, 15);
  const job = {
    name: 'verify-daemon-installation',
    head_sha: sha,
    status: 'completed',
    conclusion: 'success',
  };
  await assert.rejects(
    waitForReleaseGate({
      expectedSha: sha,
      getJobs: async () => [{ ...job, head_sha: 'b'.repeat(40) }],
    }),
    /different source/
  );
  await assert.rejects(
    waitForReleaseGate({ expectedSha: sha, getJobs: async () => [job, job] }),
    /Ambiguous/
  );
});
await test('an unreadable SEA verification response never admits iOS publication', async () => {
  const { waitForReleaseGate } = await import('./wait-release-gate.mjs');
  await assert.rejects(
    waitForReleaseGate({
      expectedSha: sha,
      getJobs: async () => {
        throw new Error('API unavailable');
      },
    }),
    /API unavailable/
  );
  await assert.rejects(
    waitForReleaseGate({ expectedSha: sha, getJobs: async () => ({ jobs: [] }) }),
    /Invalid/
  );
});
