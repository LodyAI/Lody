import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { LoroMap } from 'loro-crdt/base64';
import { openTestSession } from '../helpers.mjs';

test('Free quota counts user and queued turns, counts archived sessions, and fails open when plan is unknown', async () => {
  const bundle = await build({
    entryPoints: [
      new URL(
        '../../../../packages/cloud-runtime/src/runtime/billing.ts',
        import.meta.url,
      ).pathname,
    ],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
  });
  const billing = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
  );
  assert.equal(
    billing.billableTurnCount({
      history: [{ role: 'user' }, { role: 'assistant' }],
      mq: [{ task: 'queued' }],
    }),
    2,
  );
  assert.equal(
    billing.workspaceSessionCount([
      { key: ['e', 'session-archived'], value: true },
      { key: ['e', 'session-comment-1'], value: true },
      { key: ['e', 'session-deleted'], value: false },
    ]),
    1,
  );
  const free = { effectivePlanTier: 'free', checkoutPending: false };
  assert.equal(billing.quotaReason('turn', free, 29), undefined);
  assert.equal(
    billing.quotaReason('turn', free, 30),
    'free_session_turn_limit_reached',
  );
  assert.equal(
    billing.quotaReason('turn', { effectivePlanTier: 'plus' }, 30),
    undefined,
  );
  assert.equal(billing.quotaReason('turn', null, 30), undefined);
  assert.equal(billing.quotaReason('session', free, null), undefined);
  assert.equal(
    billing.quotaReason('session', { checkoutPending: true }, null),
    'workspace_payment_required',
  );
});

test('a Free session at 30 user turns rejects the next send before a durable write', async () => {
  const fixture = await openTestSession();
  try {
    const history = fixture.server.getList('history');
    for (let index = 0; index < 30; index++)
      history.push({ id: `existing-${index}`, role: 'user', items: [] });
    fixture.server.commit();
    await fixture.pushUpdate();
    const before = fixture.appends.length;
    const result = await fixture.runtime.sendTurn({
      sessionId: 's1',
      machineId: 'm1',
      userId: 'u1',
      cliType: 'builtin',
      agentType: 'codex',
      text: 'next turn',
      billingEntitlement: {
        effectivePlanTier: 'free',
        checkoutPending: false,
      },
    });
    assert.deepEqual(result, {
      state: 'not_sent',
      reason: 'free_session_turn_limit_reached',
    });
    assert.equal(fixture.appends.length, before);
  } finally {
    fixture.close();
  }
});

test('the live session projection exposes the quota count including queued turns', async () => {
  const fixture = await openTestSession();
  try {
    const history = fixture.server.getList('history');
    for (let index = 0; index < 24; index++)
      history.push({ id: `existing-${index}`, role: 'user', items: [] });
    const queued = fixture.server
      .getMovableList('mq')
      .pushContainer(new LoroMap());
    queued.set('userTurnId', 'queued-25');
    queued.set('task', 'next message');
    fixture.server.commit();
    assert.equal(
      fixture.runtime.projectSession(fixture.server, 'live').billableTurnCount,
      25,
    );
  } finally {
    fixture.close();
  }
});
