import assert from 'node:assert/strict';
import test from 'node:test';
import { pullRequestReferences } from '../../../../packages/cloud-runtime/src/protocol/pull-request.ts';

test('PR associations use OSS URL/status and separate CI rollups; invalid targets never become requests', () => {
  const url = 'https://github.com/LodyAI/Lody/pull/31';
  const refs = pullRequestReferences(
    [
      { url, status: 'open', number: 999, repository: 'attacker/repo' },
      { url, status: 'draft' },
      { url: 'https://evil.example/LodyAI/Lody/pull/1', status: 'open' },
      { url: 'https://github.com/LodyAI/../pull/1', status: 'open' },
      { url: `${url}?token=secret`, status: 'open' },
      { url: 'https://github.com/LodyAI/Lody/pull/32', status: 'merged' },
    ],
    { [url]: { s: 'f', t: 1 } },
  );
  assert.equal(refs.length, 2);
  assert.deepEqual(refs[0], {
    url,
    status: 'open',
    number: 31,
    repository: 'LodyAI/Lody',
    ci: 'f',
  });
  assert.equal(refs[1].status, 'merged');
});
