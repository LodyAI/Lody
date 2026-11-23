import assert from 'node:assert/strict';

const packages = {
  cli: 'apps/cli',
  daemon: 'apps/cli',
  electron: 'apps/electron',
  android: 'apps/mobile-capacitor',
  ios: 'apps/mobile-capacitor',
};
const publisherJobs = {
  cli: ['publish-cli'],
  daemon: ['publish-daemon'],
  electron: ['build-electron', 'upload-electron-to-r2'],
  android: ['build-mobile-android'],
  ios: ['upload-mobile-ios-to-app-store-connect'],
};

// Runs before selecting an environment. A dispatch cannot select arbitrary source or credentials.
export async function validateManualTarget({ github, context, inputs, component }) {
  assert.equal(context.eventName, 'workflow_dispatch');
  assert.ok(Object.hasOwn(packages, component));
  assert.ok(['refs/heads/main', 'refs/heads/release'].includes(context.ref));
  if (component === 'ios') assert.equal(context.ref, 'refs/heads/release');
  assert.match(inputs.expected_sha ?? '', /^[a-f0-9]{40}$/u);
  assert.match(
    inputs.expected_version ?? '',
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-next\.(0|[1-9]\d*))?$/u
  );
  assert.equal(inputs.expected_sha, context.sha, 'Dispatch must pin the selected workflow commit');
  const production = context.ref === 'refs/heads/release';
  assert.equal(production, !inputs.expected_version.includes('-'), 'Version must match channel');
  const branch = (
    await github.rest.repos.getBranch({ ...context.repo, branch: production ? 'release' : 'main' })
  ).data;
  assert.equal(
    branch.commit.sha,
    inputs.expected_sha,
    'Branch advanced; dispatch its current reviewed tip'
  );
  const file = (
    await github.rest.repos.getContent({
      ...context.repo,
      path: `${packages[component]}/package.json`,
      ref: inputs.expected_sha,
    })
  ).data;
  assert.equal(file.encoding, 'base64');
  assert.equal(JSON.parse(Buffer.from(file.content, 'base64')).version, inputs.expected_version);
  let buildNumber = String(context.runNumber);
  if (production) {
    assert.match(
      inputs.source_run_id ?? '',
      /^[1-9]\d*$/u,
      'Production requires an original failed release run'
    );
    const run = (
      await github.rest.actions.getWorkflowRun({ ...context.repo, run_id: inputs.source_run_id })
    ).data;
    assert.equal(run.path, '.github/workflows/release-clients.yml');
    assert.equal(run.event, 'push');
    assert.equal(run.head_branch, 'release');
    assert.equal(run.head_sha, inputs.expected_sha);
    assert.equal(run.status, 'completed');
    assert.equal(run.conclusion, 'failure');
    assert.ok(Number.isSafeInteger(run.run_number) && run.run_number > 0);
    const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
      ...context.repo,
      run_id: run.id,
      filter: 'latest',
      per_page: 100,
    });
    assert.equal(
      jobs.filter((job) => job.name === 'release' && job.conclusion === 'success').length,
      1
    );
    const targets = jobs.filter((job) =>
      publisherJobs[component].some(
        (name) =>
          job.name === name || job.name.startsWith(`${name} `) || job.name.startsWith(`${name} /`)
      )
    );
    assert.ok(
      targets.length > 0 && targets.every((job) => job.status === 'completed'),
      'Incomplete publisher evidence'
    );
    assert.ok(
      targets.some((job) => job.conclusion === 'failure'),
      'Only a failed publisher can be recovered here'
    );
    buildNumber = String(run.run_number);
  } else {
    assert.ok(!inputs.source_run_id, 'Staging builds use their own frozen run timestamp');
  }
  return {
    checkout_sha: inputs.expected_sha,
    build_number: buildNumber,
    target_environment: production ? 'cloud-production' : 'cloud-staging',
  };
}
