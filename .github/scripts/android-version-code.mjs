import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// One chronology across Stable, Nightly and manual builds, independent of workflow
// counters. Original run creation time is immutable across retries/recovery.
const ANDROID_EPOCH = Date.parse('2020-01-01T00:00:00.000Z');
export function androidVersionCode(createdAt) {
  assert.equal(typeof createdAt, 'string', 'Missing original run creation time');
  const timestamp = Date.parse(createdAt);
  assert.ok(Number.isFinite(timestamp), 'Invalid original run creation time');
  const code = Math.floor((timestamp - ANDROID_EPOCH) / 1000);
  assert.ok(
    Number.isSafeInteger(code) && code > 0 && code <= 2_100_000_000,
    'Android version code outside supported range'
  );
  return String(code);
}

export function androidVersionCodeForRun(run, expectedSha) {
  assert.equal(run.head_sha, expectedSha, 'Android source run does not match checkout');
  return androidVersionCode(run.created_at);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runId = process.env.ANDROID_SOURCE_RUN_ID;
  const repository = process.env.GITHUB_REPOSITORY;
  assert.match(runId ?? '', /^[1-9]\d*$/u);
  assert.match(repository ?? '', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
  const run = JSON.parse(
    execFileSync('gh', ['api', `repos/${repository}/actions/runs/${runId}`], { encoding: 'utf8' })
  );
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const code = androidVersionCodeForRun(run, sha);
  await appendFile(process.env.GITHUB_ENV, `MOBILE_VERSION_CODE=${code}\n`);
}
