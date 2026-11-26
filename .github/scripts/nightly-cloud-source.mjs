import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const SHA_PATTERN = /^[a-f0-9]{40}$/u;

// Keep the existing reservation schema during cutover. Both legacy SHA fields now identify public source.
export function admitCloudNightly({
  context,
  run,
  latestTagSha,
  previous,
  buildOffset,
  releaseMode = 'verified',
  expectedSha = '',
  reason = '',
  isCommitOnMain = (sha) => sha === context.sha,
}) {
  assert.equal(context.repository, 'LodyAI/Lody');
  assert.equal(context.ref, 'refs/heads/main');
  assert.ok(['schedule', 'workflow_dispatch'].includes(context.eventName));
  assert.match(context.sha, SHA_PATTERN);
  assert.equal(run.head_sha, context.sha);
  assert.equal(String(run.id), context.runId);
  assert.equal(String(run.run_number), context.runNumber);
  assert.equal(run.event, context.eventName);
  assert.equal(run.head_branch, 'main');
  assert.ok(Number.isSafeInteger(Number(context.runNumber)) && Number(context.runNumber) > 0);
  const mode = releaseMode || 'verified';
  assert.ok(['verified', 'emergency'].includes(mode), `Unsupported release mode: ${mode}`);
  const trimmedReason = String(reason ?? '').trim();
  if (mode === 'emergency') {
    assert.ok(trimmedReason.length > 0, 'Emergency release requires a non-empty reason');
  }
  const trimmedExpected = String(expectedSha ?? '').trim();
  let targetSha = context.sha;
  if (trimmedExpected.length > 0) {
    assert.match(trimmedExpected, SHA_PATTERN, 'expected_sha must be a 40-char lowercase hex SHA');
    assert.ok(
      isCommitOnMain(trimmedExpected),
      `expected_sha ${trimmedExpected} is not an ancestor of main (${context.sha})`
    );
    targetSha = trimmedExpected;
  }
  const skipValidate = mode === 'emergency';
  const builtAt = new Date(run.created_at).toISOString();
  if (previous) {
    assert.equal(previous.schema, 1);
    assert.equal(previous.privateSha, targetSha);
    assert.equal(previous.ossSha, targetSha);
    assert.equal(previous.runId, context.runId);
    assert.equal(previous.builtAt, builtAt);
    assert.deepEqual(previous.trigger, { repository: context.repository, sha: context.sha });
    assert.ok(
      /^[1-9]\d*$/u.test(previous.buildNumber) && Number(previous.buildNumber) <= 99_989_999
    );
    return {
      publish: true,
      mode: previous.releaseMode ?? mode,
      skipValidate: (previous.releaseMode ?? mode) === 'emergency',
      candidate: previous,
    };
  }
  assert.equal(context.runAttempt, '1', 'Retry requires the immutable original candidate artifact');
  if (context.eventName === 'schedule' && latestTagSha === targetSha) {
    return { publish: false, mode, skipValidate };
  }
  assert.match(
    buildOffset ?? '',
    /^(0|[1-9]\d*)$/u,
    'Configure an explicit cutover build-number offset'
  );
  const buildNumber = Number(buildOffset) + Number(context.runNumber);
  assert.ok(Number.isSafeInteger(buildNumber) && buildNumber > 0 && buildNumber <= 99_989_999);
  return {
    publish: true,
    mode,
    skipValidate,
    candidate: {
      schema: 1,
      privateSha: targetSha,
      ossSha: targetSha,
      buildNumber: String(buildNumber),
      runId: context.runId,
      builtAt,
      releaseMode: mode,
      ...(trimmedReason ? { releaseReason: trimmedReason } : {}),
      trigger: { repository: context.repository, sha: context.sha },
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const filename = process.argv[2];
  assert.ok(filename);
  const env = process.env;
  const context = {
    repository: env.GITHUB_REPOSITORY,
    ref: env.GITHUB_REF,
    eventName: env.GITHUB_EVENT_NAME,
    sha: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID,
    runNumber: env.GITHUB_RUN_NUMBER,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
  };
  // Validate the repository before constructing an API path.
  assert.equal(context.repository, 'LodyAI/Lody');
  assert.match(context.runId, /^[1-9]\d*$/u);
  const run = JSON.parse(
    execFileSync('gh', ['api', `repos/${context.repository}/actions/runs/${context.runId}`], {
      encoding: 'utf8',
    })
  );
  const tag = execFileSync('git', ['tag', '--list', 'nightly-*', '--sort=-version:refname'], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .find((tag) => /^nightly-\d+\.\d+\.0-nightly\.\d+$/u.test(tag));
  const latestTagSha = tag
    ? execFileSync('git', ['rev-list', '-n', '1', tag], { encoding: 'utf8' }).trim()
    : undefined;
  let previous;
  try {
    previous = JSON.parse(await readFile(filename, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const isCommitOnMain = (sha) => {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', sha, context.sha], {
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  };
  const { publish, mode, skipValidate, candidate } = admitCloudNightly({
    context,
    run,
    latestTagSha,
    previous,
    buildOffset: env.NIGHTLY_BUILD_NUMBER_OFFSET,
    releaseMode: env.NIGHTLY_RELEASE_MODE || 'verified',
    expectedSha: env.NIGHTLY_EXPECTED_SHA || '',
    reason: env.NIGHTLY_RELEASE_REASON || '',
    isCommitOnMain,
  });
  const targetSha = candidate?.ossSha ?? context.sha;
  if (candidate && !previous)
    await writeFile(filename, `${JSON.stringify(candidate, null, 2)}\n`, { flag: 'wx' });
  await appendFile(
    env.GITHUB_OUTPUT,
    `publish=${publish}\nmode=${mode}\nskip-validate=${skipValidate}\nprivate-sha=${targetSha}\noss-sha=${targetSha}\n`
  );
}
