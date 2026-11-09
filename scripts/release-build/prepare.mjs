import { execFileSync } from 'node:child_process';
import { writeFileSync, appendFileSync } from 'node:fs';
import { canonical, validateRequest } from './contract.mjs';
import { fixtureRequest } from './fixture.mjs';

const event = process.env.GITHUB_EVENT_NAME;
const r =
  event === 'pull_request'
    ? fixtureRequest(process.env.PR_HEAD_SHA, `pr-${process.env.GITHUB_RUN_ID}`)
    : JSON.parse(process.env.REQUEST_JSON ?? '');
validateRequest(r);
if (
  event !== 'pull_request' &&
  (process.env.GITHUB_REF !== 'refs/heads/main' || r.requestId !== process.env.REQUEST_ID)
)
  throw new Error('Release builds require the trusted main workflow and matching request ID');
execFileSync('git', ['fetch', '--no-tags', 'origin', r.sourceSha]);
if (event !== 'pull_request')
  execFileSync('git', ['merge-base', '--is-ancestor', r.sourceSha, 'origin/main']);
writeFileSync('release-request.json', canonical(r) + '\n');
const os = {
  mac: 'macos-15',
  win: 'windows-2022',
  linux: 'ubuntu-latest',
  'linux-arm64': 'ubuntu-24.04-arm',
  cli: 'ubuntu-latest',
};
appendFileSync(
  process.env.GITHUB_OUTPUT,
  `source-sha=${r.sourceSha}\nrequest-id=${r.requestId}\nmatrix=${JSON.stringify({ include: r.targets.map((target) => ({ target, os: os[target] })) })}\n`
);
