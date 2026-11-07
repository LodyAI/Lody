import { openTestSession } from '../helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { executionProjection } from '../../../../packages/cloud-runtime/src/runtime/execution.ts';

const user = (id, guide = false) => ({
  id,
  role: 'user',
  status: 'handled',
  inputConfig: guide ? { _lodyDeliveryKind: 'steer' } : {},
});
const reply = (id, userTurnId, acpTurnId = 'provider') => ({
  id,
  role: 'assistant',
  userTurnId,
  acpTurnId,
  finished: true,
  items: [],
});
const chain = () => [
  user('u'),
  reply('a', 'u'),
  user('s1', true),
  reply('a1', 's1'),
  user('s2', true),
  reply('a2', 's2'),
  user('s3', true),
  reply('a3', 's3'),
];

test('reloaded provider continuation groups all accepted guides and stops at an ordinary next turn', () => {
  const raw = [
    ...chain(),
    user('next'),
    reply('next-a', 'next', 'next-provider'),
  ];
  const projection = executionProjection(raw, true);
  for (const e of raw.slice(0, 8)) {
    assert.equal(projection.get(e.id).executionId, 'u');
    assert.equal(projection.get(e.id).executionFinished, true);
    assert.equal(projection.get(e.id).steerCount, 3);
  }
  assert.equal(projection.get('next-a'), undefined);
});
test('missing provider evidence, ordinary dispatch and failed execution never become successful steer groups', () => {
  for (const change of [
    (r) => {
      r[3].acpTurnId = 'other';
      r[5].acpTurnId = 'third';
      r[7].acpTurnId = 'fourth';
    },
    (r) => {
      r[2].inputConfig = {};
    },
  ]) {
    const raw = chain();
    change(raw);
    assert.equal(
      executionProjection(raw, true).get('a')?.executionId,
      undefined,
    );
  }
  const raw = chain();
  raw[7].items = [{ name: 'chat_failed' }];
  assert.equal(
    executionProjection(raw, true).get('a').executionFinished,
    false,
  );
  assert.equal(
    executionProjection(chain(), false).get('a').executionFinished,
    false,
  );
});
test('handoff gap and stale history cannot demote an accepted bubble or finish the source', () => {
  const raw = [
    user('u'),
    reply('a', 'u'),
    { ...user('s', true), status: 'pending_apply' },
  ];
  const receipts = new Map([['s', { targetId: 'a', state: 'accepted' }]]);
  let result = executionProjection(raw, true, receipts);
  assert.equal(result.get('s').delivery, 'accepted');
  assert.equal(result.get('a').holdOpen, true);
  raw[2].status = 'pending';
  result = executionProjection(raw, true, receipts);
  assert.equal(result.get('s').delivery, 'accepted');
  receipts.set('s', { targetId: 'a', state: 'unknown' });
  assert.equal(
    executionProjection(raw, true, receipts).get('s').delivery,
    'waiting',
  );
});

test('shared history bootstrap exports the same execution grouping to native consumers', async () => {
  const fixture = await openTestSession();
  try {
    for (const entry of chain()) fixture.server.getList('history').push(entry);
    fixture.server.commit();
    const entries = fixture.runtime.projectSession(
      fixture.server,
      'live',
    ).entries;
    assert.equal(entries.length, 8);
    assert.ok(
      entries.every((e) => e.executionId === 'u' && e.executionFinished),
    );
    assert.equal(entries.find((e) => e.id === 'a3').userTurnId, 's3');
  } finally {
    fixture.close();
  }
});

test('interrupt guidance survives bootstrap and requires both an explicit target and its cancellation', () => {
  const raw = chain();
  for (let index = 1; index < raw.length; index += 2) {
    raw[index].acpTurnId = 'provider-' + index;
    if (index < 7) raw[index - 1].status = 'canceled';
    if (index > 1)
      Object.assign(raw[index - 1].inputConfig, {
        _lodySteerTarget: raw[index - 2].id,
        _lodySteerMode: 'interrupt',
      });
  }
  const projected = executionProjection(raw, true);
  assert.ok(raw.every((e) => projected.get(e.id)?.executionId === 'u'));
  assert.equal(projected.get('a3').steerCount, 3);
  assert.equal(projected.get('a3').executionFinished, true);
  // A cancellation that did not occur must not associate a later ordinary run.
  raw[0].status = 'handled';
  assert.equal(executionProjection(raw, true).get('a')?.executionId, undefined);
});

test('interrupt grouping survives upstream input normalization and a new session bootstrap', async () => {
  const fixture = await openTestSession();
  try {
    const raw = chain();
    for (let i = 0; i < raw.length; i += 2) {
      raw[i].inputConfig = {};
      raw[i].status = i < 6 ? 'canceled' : 'handled';
      raw[i + 1].acpTurnId = 'provider-' + i;
      if (i > 0)
        fixture.server.getMap('lodySteerLinks').set(raw[i].id, {
          targetId: raw[i - 1].id,
          mode: 'interrupt',
        });
    }
    for (const e of raw) fixture.server.getList('history').push(e);
    fixture.server.commit();
    await fixture.pushUpdate();
    const result = fixture.runtime.projectSession(fixture.server, 'live');
    assert.ok(
      result.entries.every((e) => e.executionId === 'u' && e.executionFinished),
    );
    assert.equal(result.entries.at(-1).steerCount, 3);
  } finally {
    fixture.close();
  }
});
