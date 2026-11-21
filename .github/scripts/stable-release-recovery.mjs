// Read-only preflight. No environment secrets or package installation may precede it.
const components = {
  cli: 'apps/cli',
  electron: 'apps/electron',
  android: 'apps/mobile-capacitor',
  ios: 'apps/mobile-capacitor',
};
const tags = ['lody-cli', 'lody-electron', 'lody-mobile'];
const stable = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

function requireCondition(value, message) {
  if (!value) throw new Error(message);
}

function compareVersions(a, b) {
  requireCondition(stable.test(a) && stable.test(b), 'Expected stable semantic versions');
  const left = a.split('.').map(BigInt);
  const right = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

export async function validateRecovery({ github, context, inputs, currentSha, fetchImpl = fetch }) {
  const {
    expected_sha: sha,
    expected_version: version,
    source_run_id: sourceRun,
    component,
  } = inputs;
  requireCondition(context.eventName === 'workflow_dispatch', 'Recovery requires manual dispatch');
  requireCondition(
    context.ref === 'refs/heads/release',
    'Dispatch the reviewed recovery workflow from release'
  );
  requireCondition(/^[0-9a-f]{40}$/.test(sha ?? ''), 'A full lowercase expected_sha is required');
  requireCondition(stable.test(version ?? ''), 'An exact stable expected_version is required');
  requireCondition(
    Object.hasOwn(components, component ?? ''),
    'Select cli, electron, android, or ios'
  );
  requireCondition(
    /^[1-9][0-9]*$/.test(sourceRun ?? '') && Number.isSafeInteger(Number(sourceRun)),
    'Invalid source_run_id'
  );
  const repo = context.repo;
  const release = (await github.rest.repos.getBranch({ ...repo, branch: 'release' })).data;
  requireCondition(
    release.commit.sha === currentSha,
    'Workflow release has moved; dispatch the reviewed current release'
  );
  requireCondition(release.commit.sha === sha, 'Recovery target is no longer the release tip');

  const run = (await github.rest.actions.getWorkflowRun({ ...repo, run_id: Number(sourceRun) }))
    .data;
  requireCondition(
    run.path === '.github/workflows/release-clients.yml' &&
      run.event === 'push' &&
      run.head_branch === 'release' &&
      run.head_sha === sha &&
      run.status === 'completed' &&
      run.conclusion === 'failure' &&
      Number.isSafeInteger(run.run_number) &&
      run.run_number > 0,
    'Source run is not the expected failed stable Release CLI push'
  );
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...repo,
    run_id: run.id,
    filter: 'latest',
    per_page: 100,
  });
  const expectedJobs = {
    release: 'success',
    'publish-daemon': 'skipped',
    'verify-daemon-installation': 'skipped',
    'attach-electron-release': 'skipped',
    'publish-cli': 'skipped',
    'build-electron': 'skipped',
    'upload-electron-to-r2': 'skipped',
    'build-mobile-android': 'skipped',
    'upload-mobile-ios-to-app-store-connect': 'skipped',
  };
  requireCondition(
    jobs.length === Object.keys(expectedJobs).length + 3 &&
      Object.entries(expectedJobs).every(([name, conclusion]) => {
        const matches = jobs.filter((job) => job.name === name);
        return (
          matches.length === 1 &&
          matches[0].status === 'completed' &&
          matches[0].conclusion === conclusion
        );
      }),
    'Source run must have only failed public validation and untouched publishers'
  );
  const validation = ['lint', 'typecheck-desktop-cli', 'typecheck-mobile'].map((check) => {
    const matches = jobs.filter((job) => job.name === `validate-app-redirects (${check})`);
    requireCondition(
      matches.length === 1 && matches[0].status === 'completed',
      'Incomplete public validation evidence'
    );
    requireCondition(
      ['success', 'failure'].includes(matches[0].conclusion),
      'Unknown public validation result'
    );
    return matches[0];
  });
  requireCondition(
    validation.some((job) => job.conclusion === 'failure'),
    'Source validation did not fail'
  );

  const refs = await github.paginate(github.rest.git.listMatchingRefs, {
    ...repo,
    ref: 'tags/lody-',
    per_page: 100,
  });
  for (const [index, prefix] of tags.entries()) {
    const tagName = `${prefix}-v${version}`;
    const ref = refs.find((item) => item.ref === `refs/tags/${tagName}`);
    requireCondition(ref, `Missing release tag ${tagName}`);
    let object = ref.object;
    for (let depth = 0; object.type === 'tag' && depth < 5; depth++) {
      object = (await github.rest.git.getTag({ ...repo, tag_sha: object.sha })).data.object;
    }
    requireCondition(object.type === 'commit' && object.sha === sha, `Wrong commit for ${tagName}`);
    for (const item of refs) {
      const candidate = item.ref.slice(`refs/tags/${prefix}-v`.length);
      if (item.ref.startsWith(`refs/tags/${prefix}-v`) && stable.test(candidate)) {
        requireCondition(
          compareVersions(candidate, version) <= 0,
          `A newer ${prefix} release exists`
        );
      }
    }
    const published = (await github.rest.repos.getReleaseByTag({ ...repo, tag: tagName })).data;
    requireCondition(
      !published.draft && !published.prerelease,
      `Not a published stable release: ${tagName}`
    );
    const path = ['apps/cli', 'apps/electron', 'apps/mobile-capacitor'][index];
    const file = (
      await github.rest.repos.getContent({ ...repo, path: `${path}/package.json`, ref: sha })
    ).data;
    requireCondition(
      file.encoding === 'base64' && typeof file.content === 'string',
      'Invalid package response'
    );
    requireCondition(
      JSON.parse(Buffer.from(file.content, 'base64').toString()).version === version,
      `${path} version mismatch`
    );
  }
  const manifest = (
    await github.rest.repos.getContent({ ...repo, path: '.release-please-manifest.json', ref: sha })
  ).data;
  requireCondition(manifest.encoding === 'base64', 'Invalid stable manifest response');
  const versions = JSON.parse(Buffer.from(manifest.content, 'base64').toString());
  requireCondition(
    Object.values(components).every((path) => versions[path] === version),
    'Stable manifest version mismatch'
  );

  // App Store Connect needs production credentials. Its separate admission check
  // runs before iOS dependencies/build and again immediately before upload.
  if (component === 'ios')
    return {
      checkout_sha: sha,
      build_number: String(run.run_number),
      paths_released: JSON.stringify([components[component]]),
    };

  // Refuse already-published or newer targets; do not silently overwrite aliases.
  const url =
    component === 'cli'
      ? `https://registry.npmjs.org/lody/${version}`
      : component === 'electron'
        ? 'https://updates.lody.ai/production/version.json'
        : 'https://updates.lody.ai/mobile/production/version.json';
  const response = await fetchImpl(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
    headers: { 'Cache-Control': 'no-cache' },
  });
  if (component === 'cli') {
    requireCondition(
      response.status === 404,
      'npm version exists or registry state cannot be verified'
    );
    const latest = await fetchImpl('https://registry.npmjs.org/lody/latest', {
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
      headers: { 'Cache-Control': 'no-cache' },
    });
    requireCondition(latest.ok, 'npm latest cannot be verified');
    requireCondition(
      compareVersions((await latest.json()).version, version) < 0,
      'npm latest is already at or beyond the recovery target'
    );
  } else {
    requireCondition(response.ok, 'Production update metadata cannot be verified');
    const metadata = await response.json();
    requireCondition(
      compareVersions(metadata.version, version) < 0,
      'Platform is already published or newer; audit instead of rebuilding'
    );
  }
  return {
    checkout_sha: sha,
    build_number: String(run.run_number),
    paths_released: JSON.stringify([components[component]]),
  };
}
