import test from 'node:test';
import assert from 'node:assert/strict';
import {
  editableUserTurn,
  replacementInput,
} from '../../../../packages/cloud-runtime/src/runtime/edit-session.ts';
import { openTestSession } from '../helpers.mjs';

const meta = { machineId: 'm1', cliType: 'builtin', agentType: 'codex' };
const original = {
  id: 'original',
  role: 'user',
  status: 'completed',
  finished: true,
  inputConfig: {
    modelId: 'original-model',
    configOptionValues: { fast: true },
  },
  items: [
    { type: 'text', text: 'Original prompt' },
    { type: 'image', imageId: 'image-1', mimeType: 'image/png', sizeBytes: 10 },
    {
      type: 'file',
      fileId: 'file-1',
      fileName: 'original.txt',
      mimeType: 'text/plain',
      sizeBytes: 8,
      transport: 'r2',
      sha256: 'digest',
      textPreview: true,
      uploadedAt: 1,
    },
  ],
};

test('edit eligibility fences history, automation and provider boundaries; attachment edits preserve configuration', () => {
  assert.equal(editableUserTurn([original], meta), original);
  const preceding = {
    id: 'reply',
    role: 'assistant',
    finished: true,
    acpTurnId: 'provider-turn',
  };
  assert.equal(editableUserTurn([preceding, original], meta), undefined);
  assert.equal(
    editableUserTurn([preceding, original], meta, {
      provenance: 'runtime',
      sessionFork: true,
    }),
    original,
  );
  for (const invalid of [
    { isArchived: true },
    { autoReview: true },
    { agentType: 'grok' },
    { latestGoal: { status: 'active' } },
  ]) {
    assert.equal(
      editableUserTurn([original], { ...meta, ...invalid }),
      undefined,
    );
  }
  for (const status of ['pending_apply', 'delivery_unknown'])
    assert.equal(editableUserTurn([{ ...original, status }], meta), undefined);
  assert.equal(
    editableUserTurn(
      [{ ...original, inputConfig: { _lodyDeliveryKind: 'steer' } }],
      meta,
    ),
    undefined,
  );
  assert.equal(
    editableUserTurn([original, { ...original, id: 'newer' }], meta),
    undefined,
  );
  const added = {
    type: 'image',
    imageId: 'added',
    mimeType: 'image/png',
    sizeBytes: 12,
  };
  const input = replacementInput(original, 'Edited', ['original:1'], [added]);
  const historyWithMetadata = {
    ...original,
    items: original.items.map((item) => ({
      ...item,
      itemId: 'history-item',
      rev: 3,
    })),
  };
  assert.deepEqual(
    replacementInput(historyWithMetadata, 'Edited', ['original:1'], [added]),
    input,
    'history metadata must not invalidate strict input blocks and drop attachments',
  );
  assert.deepEqual(input.inputBlocks, [
    { type: 'text', text: 'Edited' },
    original.items[2],
    added,
  ]);
  assert.equal(input.modelId, 'original-model');
  assert.deepEqual(input.configOptionValues, { fast: true });
  assert.equal(
    replacementInput(original, '', ['original:0'], []).inputBlocks.length,
    1,
  );
  assert.throws(() => replacementInput(original, '', [], []));
  assert.throws(() => replacementInput(original, 'Edited', ['foreign-id'], []));
  assert.throws(() =>
    replacementInput(
      original,
      'Edited',
      [],
      [{ type: 'image', imageId: 'bad' }],
    ),
  );
  assert.equal(original.items.length, 3);
});

test('edit RPC leaves history server-owned, preserves failed drafts and never automatically replays uncertain writes', async () => {
  let result = {
    result: { success: false, error: { message: 'stale boundary' } },
  };
  const requests = [];
  const fixture = await openTestSession({
    onRpc: (request) => {
      requests.push(request);
      return result;
    },
  });
  try {
    fixture.server.getList('history').push(original);
    await fixture.pushUpdate();
    const base = {
      sessionId: 's1',
      userId: 'u1',
      expectedUserTurnId: 'original',
    };
    assert.equal(
      (await fixture.runtime.editSession({ ...base, action: 'read' }, meta))
        .state,
      'ready',
    );
    const args = {
      ...base,
      action: 'send',
      id: 'replacement',
      text: 'Changed',
      retainedIds: ['original:0'],
    };
    assert.equal(
      (await fixture.runtime.editSession(args, meta)).state,
      'not_sent',
    );
    assert.equal(requests[0].method, 'session/edit-and-resend');
    assert.equal(requests[0].params.expectedUserTurnId, 'original');
    assert.equal(requests[0].params.replacementUserTurnId, 'replacement');
    assert.deepEqual(requests[0].params.inputConfig.inputBlocks, [
      { type: 'text', text: 'Changed' },
      original.items[1],
    ]);
    assert.deepEqual(fixture.server.toJSON().history, [original]);
    result = { error: { message: 'lost response' } };
    assert.equal(
      (await fixture.runtime.editSession(args, meta)).state,
      'unknown',
    );
    assert.equal(requests.length, 2);
    assert.equal(
      (
        await fixture.runtime.editSession(
          { ...base, action: 'read', id: 'replacement' },
          meta,
        )
      ).state,
      'ready',
    );
    assert.equal(requests.length, 2);
    fixture.server.getList('history').delete(0, 1);
    fixture.server.getList('history').push({ ...original, id: 'replacement' });
    await fixture.pushUpdate();
    assert.equal(
      (
        await fixture.runtime.editSession(
          { ...base, action: 'read', id: 'replacement' },
          meta,
        )
      ).state,
      'accepted',
    );
    assert.equal(
      (await fixture.runtime.editSession({ ...args, id: 'another' }, meta))
        .state,
      'not_sent',
    );
    assert.equal(requests.length, 2);
  } finally {
    fixture.close();
  }
});
