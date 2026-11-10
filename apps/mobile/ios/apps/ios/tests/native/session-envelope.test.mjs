import test from 'node:test';
import assert from 'node:assert/strict';
import { LoroMap, LoroList } from 'loro-crdt/base64';
import { openTestSession } from '../helpers.mjs';

test('权限作答：过期 / 非法 option / 已有 outcome / 重复同答', async () => {
  const { runtime, server, pushUpdate, close } = await openTestSession();
  const entry = server.getList('history').pushContainer(new LoroMap());
  entry.set('id', 'e1');
  entry.set('role', 'assistant');
  const items = entry.setContainer('items', new LoroList());
  const call = items.pushContainer(new LoroMap());
  call.set('type', 'tool_call');
  call.set('toolCallId', 'tc_1');
  call.set('kind', 'execute');
  call.set('status', 'pending');
  call.set('permissionRequest', {
    requestId: 'r1',
    options: [
      { optionId: 'once', name: '本次允许', kind: 'allow_once' },
      { optionId: 'no', name: '拒绝', kind: 'reject_once' },
    ],
  });
  server.commit();
  await pushUpdate();

  const args = { sessionId: 's1', entryId: 'e1', itemId: 'tc_1' };
  const outcomeOf = () =>
    runtime.docSnapshot().history[0].items[0].permissionRequest.outcome;

  const stale = await runtime.respondPermission({
    ...args,
    requestId: 'gone',
    optionId: 'once',
  });
  assert.equal(stale.state, 'stale');
  assert.equal(outcomeOf(), undefined);

  await assert.rejects(
    runtime.respondPermission({ ...args, requestId: 'r1', optionId: 'bogus' }),
    /invalid_option/,
  );
  assert.equal(outcomeOf(), undefined);

  const first = await runtime.respondPermission({
    ...args,
    requestId: 'r1',
    optionId: 'once',
  });
  assert.equal(first.state, 'accepted');
  assert.equal(outcomeOf().optionId, 'once');
  assert.equal(
    server.toJSON().history[0].items[0].permissionRequest.outcome.optionId,
    'once',
  );

  const again = await runtime.respondPermission({
    ...args,
    requestId: 'r1',
    optionId: 'once',
  });
  assert.equal(again.state, 'accepted');
  assert.equal(outcomeOf().optionId, 'once');

  const conflict = await runtime.respondPermission({
    ...args,
    requestId: 'r1',
    optionId: 'no',
  });
  assert.equal(conflict.state, 'conflict');
  assert.equal(outcomeOf().optionId, 'once');
  close();
});

test('权限作答上传失败时抛 upload_failed，用户重试后再次上传', async () => {
  let fail = true;
  const { runtime, server, pushUpdate, appends, close } = await openTestSession(
    { failAppend: () => fail },
  );
  const entry = server.getList('history').pushContainer(new LoroMap());
  entry.set('id', 'e1');
  entry.set('role', 'assistant');
  const items = entry.setContainer('items', new LoroList());
  const call = items.pushContainer(new LoroMap());
  call.set('type', 'tool_call');
  call.set('toolCallId', 'tc_1');
  call.set('permissionRequest', {
    requestId: 'r1',
    options: [{ optionId: 'once', name: '本次允许', kind: 'allow_once' }],
  });
  server.commit();
  await pushUpdate();
  const args = {
    sessionId: 's1',
    entryId: 'e1',
    itemId: 'tc_1',
    requestId: 'r1',
    optionId: 'once',
  };
  await assert.rejects(runtime.respondPermission(args), /upload_failed/);
  assert.equal(
    server.toJSON().history[0].items[0].permissionRequest.outcome,
    undefined,
  );
  fail = false;
  const retried = await runtime.respondPermission(args);
  assert.equal(retried.state, 'accepted');
  assert.equal(appends.length, 2);
  assert.equal(
    server.toJSON().history[0].items[0].permissionRequest.outcome.optionId,
    'once',
  );
  close();
});

test('reopening within one native generation accepts the fresh session', async () => {
  const { runtime, events, close } = await openTestSession();
  const before = events.at(-1);
  const fresh = await new Promise((resolve) => {
    void runtime.openSession(
      's1',
      'w1',
      async () => ({ token: 'synthetic', gatewayBaseUrl: 'https://x.invalid' }),
      (event) => {
        const data = JSON.parse(event.session);
        if (data.status === 'live') resolve(data);
      },
      async () => {},
    );
  });
  assert.equal(fresh.v, 1);
  assert.ok(fresh.revision > before.revision);
  close();
});
