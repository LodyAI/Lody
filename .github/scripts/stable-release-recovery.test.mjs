import assert from 'node:assert/strict';
import test from 'node:test';
import { validateRecovery } from './stable-release-recovery.mjs';

const sha = 'a'.repeat(40);
const workflowSha = sha;
const encode = (value) => ({
  encoding: 'base64',
  content: Buffer.from(JSON.stringify(value)).toString('base64'),
});

function fixture(component = 'cli') {
  const state = {
    main: workflowSha,
    release: sha,
    run: {
      id: 12,
      path: '.github/workflows/release-clients.yml',
      event: 'push',
      head_branch: 'release',
      head_sha: sha,
      status: 'completed',
      conclusion: 'failure',
      run_number: 42,
    },
    jobs: Object.entries({
      release: 'success',
      'validate-app-redirects (lint)': 'failure',
      'validate-app-redirects (typecheck-desktop-cli)': 'success',
      'validate-app-redirects (typecheck-mobile)': 'success',
      'publish-daemon': 'skipped',
      'verify-daemon-installation': 'skipped',
      'attach-electron-release': 'skipped',
      'publish-cli': 'skipped',
      'build-electron': 'skipped',
      'upload-electron-to-r2': 'skipped',
      'build-mobile-android': 'skipped',
      'upload-mobile-ios-to-app-store-connect': 'skipped',
    }).map(([name, conclusion]) => ({ name, conclusion, status: 'completed' })),
    refs: ['lody-cli', 'lody-electron', 'lody-mobile'].map((prefix) => ({
      ref: `refs/tags/${prefix}-v1.2.3`,
      object: { type: 'commit', sha },
    })),
    tagObject: { type: 'commit', sha },
    releaseRecord: { draft: false, prerelease: false },
    packageVersion: '1.2.3',
    manifest: { 'apps/cli': '1.2.3', 'apps/electron': '1.2.3', 'apps/mobile-capacitor': '1.2.3' },
    response: {
      status: component === 'cli' ? 404 : 200,
      ok: component !== 'cli',
      json: async () => ({ version: '1.2.2' }),
    },
    probes: [],
    latest: { ok: true, json: async () => ({ version: '1.2.2' }) },
  };
  const api = {
    getBranch: async ({ branch }) => ({ data: { commit: { sha: state[branch] } } }),
    getWorkflowRun: async () => ({ data: state.run }),
    listJobsForWorkflowRun: Symbol('jobs'),
    listMatchingRefs: Symbol('refs'),
    getTag: async () => ({ data: { object: state.tagObject } }),
    getReleaseByTag: async () => ({ data: state.releaseRecord }),
    getContent: async ({ path, ref }) => {
      assert.equal(ref, sha);
      return {
        data: encode(
          path === '.release-please-manifest.json'
            ? state.manifest
            : { version: state.packageVersion }
        ),
      };
    },
  };
  const args = {
    github: {
      rest: { repos: api, actions: api, git: api },
      paginate: async (endpoint) =>
        endpoint === api.listJobsForWorkflowRun ? state.jobs : state.refs,
    },
    context: {
      repo: { owner: 'example', repo: 'product' },
      eventName: 'workflow_dispatch',
      ref: 'refs/heads/release',
    },
    currentSha: workflowSha,
    inputs: { component, expected_sha: sha, expected_version: '1.2.3', source_run_id: '12' },
    fetchImpl: async (url, options) => {
      state.probes.push({ url, options });
      return url.endsWith('/latest') ? state.latest : state.response;
    },
  };
  return { state, args };
}

for (const [component, path] of [
  ['cli', 'apps/cli'],
  ['electron', 'apps/electron'],
  ['android', 'apps/mobile-capacitor'],
]) {
  await test(`${component}: pins original source/build number and selects only one component`, async () => {
    const { state, args } = fixture(component);
    assert.deepEqual(await validateRecovery(args), {
      checkout_sha: sha,
      build_number: '42',
      paths_released: JSON.stringify([path]),
    });
    assert.equal(state.probes.length, component === 'cli' ? 2 : 1);
    assert.equal(state.probes[0].options.redirect, 'error');
  });
}

const invalid = {
  'non-dispatch': (f) => {
    f.args.context.eventName = 'push';
  },
  'unreviewed branch': (f) => {
    f.args.context.ref = 'refs/heads/task';
  },
  'main branch dispatch': (f) => {
    f.args.context.ref = 'refs/heads/main';
  },
  'short SHA': (f) => {
    f.args.inputs.expected_sha = 'abc';
  },
  'prerelease version': (f) => {
    f.args.inputs.expected_version = '1.2.3-next.1';
  },
  'invalid version': (f) => {
    f.args.inputs.expected_version = '01.2.3';
  },
  'unsafe run ID': (f) => {
    f.args.inputs.source_run_id = '9007199254740992';
  },
  'unknown component': (f) => {
    f.args.inputs.component = 'watchos';
  },
  'prototype component': (f) => {
    f.args.inputs.component = '__proto__';
  },
  'stale workflow': (f) => {
    f.args.currentSha = 'c'.repeat(40);
  },
  'advanced release': (f) => {
    f.state.release = 'c'.repeat(40);
  },
  'wrong source workflow': (f) => {
    f.state.run.path = '.github/workflows/other.yml';
  },
  'manual source': (f) => {
    f.state.run.event = 'workflow_dispatch';
  },
  'staging source': (f) => {
    f.state.run.head_branch = 'main';
  },
  'wrong source SHA': (f) => {
    f.state.run.head_sha = 'c'.repeat(40);
  },
  'running source': (f) => {
    f.state.run.status = 'in_progress';
  },
  'successful source': (f) => {
    f.state.run.conclusion = 'success';
  },
  'invalid build number': (f) => {
    f.state.run.run_number = 0;
  },
  'missing job': (f) => {
    f.state.jobs.pop();
  },
  'duplicate job': (f) => {
    f.state.jobs.push(f.state.jobs[0]);
  },
  'unknown job': (f) => {
    f.state.jobs[0].name = 'other';
  },
  'failed tag creation': (f) => {
    f.state.jobs[0].conclusion = 'failure';
  },
  'publisher already ran': (f) => {
    f.state.jobs.find((job) => job.name === 'publish-cli').conclusion = 'success';
  },
  'missing tag': (f) => {
    f.state.refs.pop();
  },
  'wrong tag target': (f) => {
    f.state.refs[0].object.sha = 'c'.repeat(40);
  },
  'newer stable tag': (f) => {
    f.state.refs.push({ ref: 'refs/tags/lody-cli-v1.10.0', object: { type: 'commit', sha } });
  },
  'draft release': (f) => {
    f.state.releaseRecord.draft = true;
  },
  'prerelease record': (f) => {
    f.state.releaseRecord.prerelease = true;
  },
  'package mismatch': (f) => {
    f.state.packageVersion = '1.2.4';
  },
  'manifest mismatch': (f) => {
    f.state.manifest['apps/mobile-capacitor'] = '1.2.4';
  },
};
for (const [name, mutate] of Object.entries(invalid)) {
  await test(`rejects ${name} before publication probes`, async () => {
    const f = fixture();
    mutate(f);
    await assert.rejects(validateRecovery(f.args));
    assert.equal(f.state.probes.length, 0);
  });
}
await test('resolves annotated tags and compares stable versions numerically', async () => {
  const { state, args } = fixture();
  state.refs[0].object = { type: 'tag', sha: 'd'.repeat(40) };
  state.refs.push({ ref: 'refs/tags/lody-cli-v1.2.3-next.99', object: { type: 'commit', sha } });
  assert.equal((await validateRecovery(args)).checkout_sha, sha);
});
for (const status of [200, 401, 429, 500]) {
  await test(`npm ${status} is not permission to publish`, async () => {
    const { state, args } = fixture();
    state.response.status = status;
    await assert.rejects(validateRecovery(args), /npm version exists or registry/);
  });
}
for (const component of ['electron', 'android']) {
  for (const version of ['1.2.3', '1.2.4', 'invalid']) {
    await test(`${component}: refuses already published/newer/invalid metadata ${version}`, async () => {
      const { state, args } = fixture(component);
      state.response.json = async () => ({ version });
      await assert.rejects(validateRecovery(args));
    });
  }
  await test(`${component}: fails closed on inaccessible metadata`, async () => {
    const { state, args } = fixture(component);
    state.response.ok = false;
    await assert.rejects(validateRecovery(args));
  });
}
await test('network errors do not become missing artifacts', async () => {
  const { args } = fixture();
  args.fetchImpl = async () => {
    throw new Error('offline');
  };
  await assert.rejects(validateRecovery(args), /offline/);
});

for (const version of ['1.2.3', '1.2.4', '1.3.0-next.1']) {
  await test(`npm latest ${version} cannot be overwritten by recovery`, async () => {
    const { state, args } = fixture();
    state.latest.json = async () => ({ version });
    await assert.rejects(validateRecovery(args));
  });
}

await test('iOS pins original source without confusing Android metadata with App Store state', async () => {
  const { state, args } = fixture('ios');
  assert.deepEqual(await validateRecovery(args), {
    checkout_sha: sha,
    build_number: '42',
    paths_released: '["apps/mobile-capacitor"]',
  });
  assert.equal(state.probes.length, 0);
});

await test('public validation recovery requires a failed matrix lane and complete results for every lane', async () => {
  for (const mutate of [
    (jobs) => {
      jobs.find((job) => job.name === 'validate-app-redirects (lint)').conclusion = 'success';
    },
    (jobs) => {
      jobs.find((job) => job.name === 'validate-app-redirects (typecheck-mobile)').status =
        'in_progress';
    },
    (jobs) => {
      jobs.find((job) => job.name === 'validate-app-redirects (typecheck-desktop-cli)').conclusion =
        'cancelled';
    },
    (jobs) => {
      jobs.find((job) => job.name === 'validate-app-redirects (typecheck-mobile)').name =
        'unexpected validation';
    },
  ]) {
    const { state, args } = fixture();
    mutate(state.jobs);
    await assert.rejects(validateRecovery(args));
    assert.deepEqual(state.probes, []);
  }
});
