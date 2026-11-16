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
    merge: undefined,
  });
  assert.equal(refs[1].status, 'merged');
});

test('a Project group conversation lists every member with its own current PR, submodules under their parent', async () => {
  const { projectRows } =
    await import('../../../../packages/cloud-runtime/src/protocol/catalog.ts');
  const pr = (repo, number) => ({
    url: `https://github.com/${repo}/pull/${number}`,
    status: 'open',
  });
  const rows = [
    { key: ['e', 'session-s1'], value: true },
    {
      key: ['m', 'session-s1'],
      value: {
        id: 's1',
        machineId: 'm1',
        branchName: 'lody/first',
        pullRequests: [pr('acme/api', 1), pr('acme/web', 7), pr('Acme/API', 2)],
        pullRequestState: {
          'https://github.com/acme/web/pull/7': { s: 'f', m: 'd' },
        },
        projectRun: {
          id: 'g1',
          name: 'Platform',
          members: {
            proto: {
              o: 1,
              src: { kind: 'github', repoFullName: 'acme/proto' },
              placement: { kind: 'submodule', parent: 'api', path: 'proto' },
              path: 'api/proto',
              base: 'main',
              branch: 'lody/proto',
            },
            docs: {
              o: 2,
              src: { kind: 'local', machineId: 'm1', localProjectId: 'p1' },
              placement: { kind: 'root', dir: 'docs' },
              path: 'docs',
              base: 'main',
              access: 'additional',
            },
            api: {
              o: 0,
              src: { kind: 'github', repoFullName: 'acme/api' },
              placement: { kind: 'root', dir: 'api' },
              path: 'api',
              base: 'main',
              branch: 'lody/api',
              diff: { add: 4, del: 1 },
              dirty: true,
            },
            web: {
              o: 3,
              src: { kind: 'local', machineId: 'm1', localProjectId: 'p2' },
              placement: { kind: 'root', dir: 'web' },
              path: 'web',
              base: 'main',
              repoFullName: 'acme/web',
              branch: 'lody/web',
              unpushed: true,
            },
          },
        },
      },
    },
  ];
  const [session] = projectRows(rows, 'meta').sessions;
  assert.equal(session.projectId, 'group:g1');
  const run = session.projectRun;
  assert.equal(run.name, 'Platform');
  assert.deepEqual(
    run.members.map((m) => [m.id, m.depth, m.submodule]),
    [
      ['api', 0, false],
      ['proto', 1, true],
      ['docs', 0, false],
      ['web', 0, false],
    ],
  );
  const byId = Object.fromEntries(run.members.map((m) => [m.id, m]));
  // The last PR recorded for a repository is current, matched case-insensitively.
  assert.equal(byId.api.pullRequest.number, 2);
  assert.deepEqual(byId.api.diff, { add: 4, del: 1 });
  assert.equal(byId.api.dirty, true);
  assert.equal(byId.proto.pullRequest, undefined);
  // A local member learns its repository from the observed remote.
  assert.equal(byId.web.repoFullName, 'acme/web');
  assert.equal(byId.web.pullRequest.ci, 'f');
  assert.equal(byId.web.pullRequest.merge, 'd');
  assert.equal(byId.web.unpushed, true);
  assert.equal(byId.docs.access, 'additional');
  assert.equal(byId.docs.repoFullName, undefined);
  assert.equal(byId.docs.branch, undefined);

  // A single-repository conversation carries no group snapshot.
  const plain = projectRows(
    [
      { key: ['e', 'session-s2'], value: true },
      {
        key: ['m', 'session-s2'],
        value: { id: 's2', machineId: 'm1', repoFullName: 'acme/api' },
      },
    ],
    'meta',
  ).sessions[0];
  assert.equal(plain.projectRun, undefined);
});

test('catalog keeps changed-file counts for zero-line, mixed and legacy workspace summaries', async () => {
  const { projectRows } =
    await import('../../../../packages/cloud-runtime/src/protocol/catalog.ts');
  const read = (diff) =>
    projectRows(
      [
        { key: ['e', 'session-files'], value: true },
        {
          key: ['m', 'session-files'],
          value: {
            id: 'files',
            machineId: 'm',
            diffStats: { allChange: diff },
          },
        },
      ],
      'meta',
    ).sessions[0];
  assert.deepEqual(read({ add: 0, del: 0, files: 2 }).diff, {
    add: 0,
    del: 0,
    files: 2,
  });
  assert.deepEqual(read({ add: 3, del: 1, files: 2 }).diff, {
    add: 3,
    del: 1,
    files: 2,
  });
  assert.deepEqual(read({ add: 0, del: 0, files: 0 }).diff, {
    add: 0,
    del: 0,
    files: 0,
  });
  assert.deepEqual(read({ add: 3, del: 1 }).diff, { add: 3, del: 1 });
  assert.equal(read({ add: 0, del: 0 }).diff, undefined);
});
