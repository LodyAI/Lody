import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

// iOS can archive in parallel with SEA. Only its externally visible upload waits.
// Keep the existing iOS lock throughout so another build cannot reserve the same train/build.
export async function waitForReleaseGate({
  getJobs,
  expectedSha,
  gateJobName = 'verify-daemon-installation',
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  timeoutMs = 60 * 60 * 1000,
  intervalMs = 30_000,
}) {
  assert.match(expectedSha, /^[a-f0-9]{40}$/u);
  assert.ok(gateJobName.length > 0, 'Gate job name is required');
  assert.ok(timeoutMs > 0 && intervalMs > 0);
  const deadline = now() + timeoutMs;
  for (;;) {
    const jobs = await getJobs();
    assert.ok(Array.isArray(jobs), 'Invalid same-run jobs response');
    const gates = jobs.filter((job) => job.name === gateJobName);
    assert.ok(gates.length <= 1, `Ambiguous release gate job: ${gateJobName}`);
    const gate = gates[0];
    if (gate) {
      assert.equal(gate.head_sha, expectedSha, `Gate job ${gateJobName} belongs to a different source`);
      if (gate.status === 'completed') {
        assert.equal(
          gate.conclusion,
          'success',
          `Gate job ${gateJobName} did not succeed (${gate.conclusion}); refusing publication`
        );
        return;
      }
      assert.ok(
        ['queued', 'in_progress', 'waiting', 'pending'].includes(gate.status),
        `Unknown release gate state for ${gateJobName}: ${gate.status}`
      );
    }
    const remaining = deadline - now();
    assert.ok(remaining > 0, `Timed out waiting for ${gateJobName}; refusing publication`);
    await sleep(Math.min(intervalMs, remaining));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const {
    GITHUB_REPOSITORY: repository,
    GITHUB_RUN_ID: runId,
    GITHUB_SHA: expectedSha,
    GH_TOKEN: token,
    RELEASE_GATE_JOB_NAME: gateJobName = 'verify-daemon-installation',
  } = process.env;
  assert.equal(repository, 'LodyAI/Lody');
  assert.match(runId ?? '', /^[1-9]\d*$/u);
  assert.ok(token, 'GitHub read token is required');
  await waitForReleaseGate({
    expectedSha,
    gateJobName,
    getJobs: async () => {
      const jobs = [];
      for (let page = 1; ; page++) {
        const response = await fetch(
          `https://api.github.com/repos/${repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
            },
            redirect: 'error',
            signal: AbortSignal.timeout(30_000),
          }
        );
        assert.ok(response.ok, `GitHub release gate query failed (HTTP ${response.status})`);
        const body = await response.json();
        assert.ok(
          Array.isArray(body.jobs) && Number.isSafeInteger(body.total_count),
          'Invalid same-run jobs response'
        );
        jobs.push(...body.jobs);
        if (body.jobs.length < 100) {
          return jobs;
        }
      }
    },
  });
  console.log('Same-run SEA verification succeeded; iOS upload may proceed.');
}
