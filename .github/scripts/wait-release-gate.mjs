import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

// iOS can archive in parallel with SEA. Only its externally visible upload waits.
// Keep the existing iOS lock throughout so another build cannot reserve the same train/build.
export async function waitForReleaseGate({
  getJobs,
  expectedSha,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  timeoutMs = 60 * 60 * 1000,
  intervalMs = 30_000,
}) {
  assert.match(expectedSha, /^[a-f0-9]{40}$/u);
  assert.ok(timeoutMs > 0 && intervalMs > 0);
  const deadline = now() + timeoutMs;
  for (;;) {
    const jobs = await getJobs();
    assert.ok(Array.isArray(jobs), 'Invalid same-run jobs response');
    const gates = jobs.filter((job) => job.name === 'verify-daemon-installation');
    assert.ok(gates.length <= 1, 'Ambiguous SEA verification job');
    const gate = gates[0];
    if (gate) {
      assert.equal(gate.head_sha, expectedSha, 'SEA verification belongs to a different source');
      if (gate.status === 'completed') {
        assert.equal(
          gate.conclusion,
          'success',
          'SEA verification did not succeed; refusing iOS publication'
        );
        return;
      }
      assert.ok(
        ['queued', 'in_progress', 'waiting', 'pending'].includes(gate.status),
        'Unknown SEA verification state'
      );
    }
    const remaining = deadline - now();
    assert.ok(remaining > 0, 'Timed out waiting for SEA verification; refusing iOS publication');
    await sleep(Math.min(intervalMs, remaining));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const {
    GITHUB_REPOSITORY: repository,
    GITHUB_RUN_ID: runId,
    GITHUB_SHA: expectedSha,
    GH_TOKEN: token,
  } = process.env;
  assert.equal(repository, 'LodyAI/Lody');
  assert.match(runId ?? '', /^[1-9]\d*$/u);
  assert.ok(token, 'GitHub read token is required');
  await waitForReleaseGate({
    expectedSha,
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
