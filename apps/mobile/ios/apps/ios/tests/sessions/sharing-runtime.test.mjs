import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSharingRuntime,
  shareCandidates,
} from '../../../../packages/cloud-runtime/src/runtime/sharing/runtime.ts';
import { verifyShareObject } from '../../../../packages/cloud-runtime/src/runtime/sharing/session-share-package.ts';
import { hashSessionShareSecret } from '../../../../packages/cloud-runtime/src/runtime/sharing/session-share-credentials.ts';

test('dismissal and duplicate taps cannot publish after a pending read', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  const run = createSharingRuntime({
    sessions: () => [{ id: 'root', title: 'Root' }],
    history: async () => {
      throw new Error('Must not capture after dismissal');
    },
    progress: () => {},
    broker: async (_, args) => {
      calls.push(args.method);
      await gate;
      return null;
    },
  });
  const args = {
    workspaceId: 'workspace',
    sessionId: 'root',
    editorId: 'editor',
    action: 'publish',
  };
  const pending = run(args);
  await assert.rejects(run(args), /share_busy/);
  await run({ ...args, action: 'close' });
  release();
  await assert.rejects(pending);
  assert.deepEqual(calls, ['getManagement']);
});

function fixture() {
  let entry = null,
    beginArgs,
    failUpload = false,
    loseCommit = false,
    failStorage = false;
  let captures = 0;
  const calls = [],
    secrets = new Map(),
    uploads = new Map();
  const sessions = [
    { id: 'root', title: 'Root' },
    { id: 'child', title: 'Child', openedBySessionId: 'root' },
    { id: 'tab', title: 'Tab', parentSessionId: 'child' },
    { id: 'other', title: 'Other' },
  ];
  const history = [
    {
      id: 'u1',
      role: 'user',
      userId: 'private-user',
      inputConfig: {
        model: 'private-config',
        inputBlocks: [
          {
            type: 'file',
            fileId: 'private-file',
            fileName: 'secret.txt',
            transport: 'r2',
          },
        ],
      },
      items: [
        {
          type: 'content',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'image', imageId: 'image1', mimeType: 'image/png' },
          ],
        },
      ],
    },
  ];
  const sourceHistory = structuredClone(history);
  const runtime = createSharingRuntime({
    sessions: () => sessions,
    history: async () => {
      captures++;
      return history;
    },
    progress: (p) => calls.push(p.phase),
    broker: async (operation, args) => {
      calls.push(operation === 'api' ? args.method : operation);
      const key = `${args.shareId}:${args.version}`;
      if (operation === 'saveSecret') {
        if (failStorage) throw new Error('keychain locked');
        secrets.set(key, args.secret);
        return true;
      }
      if (operation === 'readSecret') return secrets.get(key) ?? null;
      if (operation === 'image')
        return { base64: btoa('image-bytes'), mediaType: 'image/png' };
      if (args.method === 'getManagement') return entry;
      if (args.method === 'beginDeployment') {
        beginArgs = args.args;
        entry = {
          shareId: 'share1',
          rootSessionId: 'root',
          status: entry?.status === 'active' ? 'active' : 'draft',
          revision: entry?.revision ?? 1,
          credentialVersion: entry?.credentialVersion ?? 1,
          currentDeploymentId: entry?.currentDeploymentId,
          canManage: true,
          canRevoke: true,
          sourceIds: beginArgs.sourceIds,
          selectedSourceIds: beginArgs.sourceIds.map((s) => s.sourceId),
        };
        return {
          ...entry,
          deploymentId: `deployment${calls.filter((c) => c === 'beginDeployment').length}`,
        };
      }
      if (args.method === 'publishDeployment') {
        assert.ok(calls.includes('seal'));
        entry = {
          ...entry,
          status: 'active',
          currentDeploymentId: args.args.deploymentId,
          revision: entry.revision + 1,
        };
        if (loseCommit) {
          loseCommit = false;
          throw new Error('response lost');
        }
        return entry;
      }
      if (args.method === 'resetCredential') {
        assert.equal(args.args.shareId, entry.shareId, 'share_conflict');
        assert.equal(
          args.args.expectedRevision,
          entry.revision,
          'share_conflict',
        );
        entry = {
          ...entry,
          revision: entry.revision + 1,
          credentialVersion: entry.credentialVersion + 1,
        };
        return entry;
      }
      if (args.method === 'revoke') {
        assert.equal(args.args.shareId, entry.shareId, 'share_conflict');
        assert.equal(
          args.args.expectedRevision,
          entry.revision,
          'share_conflict',
        );
        entry = { ...entry, status: 'revoked', revision: entry.revision + 1 };
        return entry;
      }
      throw new Error('Unexpected request');
    },
    fetch: async (url, options) => {
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'error');
      if (failUpload) {
        failUpload = false;
        return new Response('', { status: 503 });
      }
      if (url.endsWith('/seal')) calls.push('seal');
      else uploads.set(url.split('/').at(-1), new Uint8Array(options.body));
      return new Response('', { status: 200 });
    },
  });
  const request = (action, extra = {}) =>
    runtime({
      workspaceId: 'workspace',
      sessionId: 'root',
      editorId: 'editor',
      action,
      selected: ['root'],
      ...extra,
    });
  return {
    request,
    calls,
    secrets,
    uploads,
    sourceHistory,
    history,
    get begin() {
      return beginArgs;
    },
    get captures() {
      return captures;
    },
    failUpload() {
      failUpload = true;
    },
    loseCommit() {
      loseCommit = true;
    },
    failStorage() {
      failStorage = true;
    },
    changeRemotely() {
      entry = { ...entry, revision: entry.revision + 1 };
    },
  };
}

test('stale editors cannot update, reset or revoke a newer share revision', async () => {
  for (const action of ['publish', 'reset', 'revoke']) {
    const f = fixture();
    await f.request('publish');
    f.changeRemotely();
    await assert.rejects(f.request(action), /share_conflict/);
    assert.equal(f.captures, 1);
    assert.equal((await f.request('read')).entry.status, 'active');
  }
});

test('publishes an independent package before exposing a link, preserves source and excludes files and internal data', async () => {
  const f = fixture();
  assert.equal((await f.request('read')).url, null);
  const state = await f.request('publish');
  assert.match(
    state.url,
    /^https:\/\/share\.lody\.ai\/s\/share1#access=v1\.[a-f0-9]{64}$/,
  );
  assert.deepEqual(state.selected, ['root']);
  assert.equal(f.captures, 1);
  assert.equal(f.begin.manifest.conversations.length, 1);
  assert.equal(f.begin.manifest.attachments.length, 1);
  for (const object of f.begin.manifest.objects)
    await verifyShareObject(f.uploads.get(object.id), object);
  const exported = new TextDecoder().decode(
    f.uploads.get(f.begin.manifest.conversations[0].historyObjectId),
  );
  assert.ok(exported.includes('Hello'));
  assert.doesNotMatch(
    exported,
    /private-user|private-config|private-file|secret\.txt/,
  );
  assert.deepEqual(f.history, f.sourceHistory);
  assert.ok(
    f.calls.indexOf('saveSecret') < f.calls.indexOf('publishDeployment'),
  );
  assert.equal(
    await hashSessionShareSecret(state.url.split('v1.')[1]),
    f.begin.credentialHash,
  );
});

test('failed upload retains selection and retries the same frozen deployment without exposing a link', async () => {
  const f = fixture();
  f.failUpload();
  await assert.rejects(f.request('publish', { selected: ['root', 'child'] }));
  const failed = await f.request('read');
  assert.equal(failed.url, null);
  assert.equal(failed.pending, true);
  assert.deepEqual(failed.selected, ['root', 'child']);
  assert.ok(!f.calls.includes('publishDeployment'));
  const requestId = f.begin.requestId;
  const state = await f.request('publish');
  assert.ok(state.url);
  assert.equal(f.begin.requestId, requestId);
  assert.equal(f.captures, 2);
  assert.equal(f.calls.filter((c) => c === 'beginDeployment').length, 1);
});

test('lost publication response is reconciled without uploading or publishing twice', async () => {
  const f = fixture();
  f.loseCommit();
  await assert.rejects(f.request('publish'));
  const state = await f.request('publish');
  assert.ok(state.url);
  assert.equal(state.pending, false);
  assert.equal(f.calls.filter((c) => c === 'publishDeployment').length, 1);
});

test('updating freezes new history while preserving the existing reader link', async () => {
  const f = fixture();
  const original = await f.request('publish');
  f.history[0].items[0].content[0].text = 'Updated history';
  const updated = await f.request('publish');
  assert.equal(updated.url, original.url);
  assert.notEqual(
    updated.entry.currentDeploymentId,
    original.entry.currentDeploymentId,
  );
  assert.equal(f.begin.expectedRevision, original.entry.revision);
  assert.equal(f.begin.credentialHash, undefined);
  const exported = new TextDecoder().decode(
    f.uploads.get(f.begin.manifest.conversations[0].historyObjectId),
  );
  assert.match(exported, /Updated history/);
});

test('storage failure prevents publishing; reset rotates the credential and revoke removes the link', async () => {
  const broken = fixture();
  broken.failStorage();
  await assert.rejects(broken.request('publish'));
  assert.ok(!broken.calls.includes('seal'));
  assert.ok(!broken.calls.includes('publishDeployment'));
  const f = fixture();
  const first = await f.request('publish');
  const reset = await f.request('reset');
  assert.notEqual(reset.url, first.url);
  assert.equal(reset.entry.credentialVersion, 2);
  const revoked = await f.request('revoke');
  assert.equal(revoked.url, null);
  assert.equal(revoked.entry.status, 'revoked');
});

test('selection includes explicit descendants and rejects unrelated sessions before capture', async () => {
  const sessions = [
    { id: 'a', parentSessionId: 'b' },
    { id: 'b', openedBySessionId: 'a' },
    { id: 'c' },
  ];
  assert.deepEqual(
    shareCandidates('a', sessions).map((s) => s.id),
    ['b'],
  );
  const f = fixture();
  await assert.rejects(f.request('publish', { selected: ['root', 'other'] }));
  assert.equal(f.captures, 0);
  assert.ok(!f.calls.includes('beginDeployment'));
});
