import test from 'node:test';
import assert from 'node:assert/strict';
import { forkableTurn } from '../../../../packages/cloud-runtime/src/runtime/fork-session.ts';
const turn = {
  id: 'answer',
  role: 'assistant',
  finished: true,
  acpTurnId: 'provider-turn',
};
const meta = {
  machineId: 'm',
  agentConfigId: 'a',
  cliType: 'builtin',
  agentType: 'codex',
};
const cap = { provenance: 'runtime', sessionFork: true };
test('fork selects an exact completed provider turn', () =>
  assert.equal(forkableTurn([turn], meta, cap, 'answer'), true));
test('fork refuses unavailable providers and invalid targets', () => {
  for (const [history, m, c, id] of [
    [[{ ...turn, finished: false }], meta, cap, 'answer'],
    [[turn], { ...meta, isArchived: true }, cap, 'answer'],
    [[turn], meta, {}, 'answer'],
    [[turn], meta, cap, 'missing'],
    [[{ ...turn, acpTurnId: '' }], meta, cap, 'answer'],
  ])
    assert.equal(forkableTurn(history, m, c, id), false);
});

test('uncertain and concurrent forks never replay the machine write', async () => {
  const { forkOnce } =
    await import('../../../../packages/cloud-runtime/src/runtime/fork-session.ts');
  const attempts = new Map();
  let calls = 0;
  const request = { sourceSessionId: 'source', targetSessionId: 'target' };
  const send = async () => {
    calls++;
    throw Error('lost response');
  };
  assert.deepEqual(
    await forkOnce(attempts, 'workspace:target', request, send),
    { state: 'unknown' },
  );
  assert.deepEqual(
    await forkOnce(attempts, 'workspace:target', request, send),
    { state: 'unknown' },
  );
  assert.equal(calls, 1);
});
test('fork accepts only a reply for its exact source and target', async () => {
  const { forkOnce } =
    await import('../../../../packages/cloud-runtime/src/runtime/fork-session.ts');
  const request = { sourceSessionId: 'source', targetSessionId: 'target' };
  assert.deepEqual(
    await forkOnce(new Map(), 'a', request, async () => ({
      result: { ...request, success: true },
    })),
    { state: 'created' },
  );
  assert.deepEqual(
    await forkOnce(new Map(), 'b', request, async () => ({
      result: { ...request, targetSessionId: 'other', success: true },
    })),
    { state: 'unknown' },
  );
});

test('session action metadata merges field rows and honors deletion', async () => {
  const { sessionActionMeta } =
    await import('../../../../packages/cloud-runtime/src/runtime/fork-session.ts');
  const rows = [
    { key: ['m', 'session-s', 'machineId'], value: 'm' },
    { key: ['m', 'session-s', 'agentConfigId'], value: 'a' },
  ];
  assert.deepEqual(sessionActionMeta(undefined, rows, true), {
    machineId: 'm',
    agentConfigId: 'a',
  });
  assert.deepEqual(
    sessionActionMeta({ machineId: 'old', agentType: 'codex' }, rows, true),
    { machineId: 'm', agentType: 'codex', agentConfigId: 'a' },
  );
  assert.equal(sessionActionMeta({ machineId: 'old' }, rows, false), undefined);
});
