import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapabilityRefresh } from '../vendor/cloud-runtime/src/runtime/capability-refresh.ts';

test('missing config is probed once even when another provider has capabilities', async () => {
  const calls = [];
  let changes = 0;
  const refresh = createCapabilityRefresh(
    async (w, a) => calls.push([w, a.id]),
    () => 'workspace',
    () => changes++,
  );
  const options = {
    agents: [
      { id: 'grok', machineId: 'mac', cliType: 'builtin', agentType: 'grok' },
    ],
    capabilities: [
      {
        agentConfigId: 'other',
        machineId: 'mac',
        cliType: 'builtin',
        agentType: 'grok',
      },
    ],
  };
  refresh('workspace', options);
  refresh('workspace', options);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [['workspace', 'grok']]);
  assert.equal(changes, 1);
  refresh('workspace', options);
  assert.equal(calls.length, 1);
});
test('selecting a config revalidates an existing empty capability snapshot', async () => {
  const agent = {
    id: 'a',
    machineId: 'm',
    cliType: 'builtin',
    agentType: 'codex',
  };
  const refresh = createCapabilityRefresh(
    async () => ({
      result: {
        success: true,
        machineId: 'm',
        configId: 'a',
        cliType: 'builtin',
        agentType: 'codex',
        capability: { models: [{ modelId: 'fresh', name: 'Fresh' }] },
      },
    }),
    () => 'w',
    () => {},
  );
  refresh('w', {
    agents: [agent],
    capabilities: [{ ...agent, agentConfigId: 'a', models: [] }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refresh.rows('w')[0]?.value.models[0].modelId, 'fresh');
});
test('a failed probe can recover on a later selection without an immediate retry loop', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  let attempts = 0;
  const agent = {
    id: 'a',
    machineId: 'm',
    cliType: 'builtin',
    agentType: 'codex',
  };
  const refresh = createCapabilityRefresh(
    async () => {
      if (++attempts === 1) throw new Error('temporary network failure');
      return {
        result: {
          success: true,
          machineId: 'm',
          configId: 'a',
          cliType: 'builtin',
          agentType: 'codex',
          capability: { models: [{ modelId: 'recovered', name: 'Recovered' }] },
        },
      };
    },
    () => 'w',
    () => {},
  );
  const options = { agents: [agent], capabilities: [] };
  refresh('w', options);
  await new Promise((resolve) => setImmediate(resolve));
  refresh('w', options);
  assert.equal(attempts, 1);
  t.mock.timers.tick(30_000);
  refresh('w', options);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refresh.rows('w')[0]?.value.models[0].modelId, 'recovered');
});
test('validated RPC capability is available immediately before catalog sync', async () => {
  const agent = {
    id: 'g',
    machineId: 'mac',
    cliType: 'builtin',
    agentType: 'grok',
  };
  const refresh = createCapabilityRefresh(
    async () => ({
      result: {
        success: true,
        machineId: 'mac',
        configId: 'g',
        cliType: 'builtin',
        agentType: 'grok',
        capability: { models: [{ modelId: 'grok-4.7', name: 'Grok 4.7' }] },
      },
    }),
    () => 'w',
    () => {},
  );
  refresh('w', { agents: [agent], capabilities: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refresh.rows('w')[0].value.models[0].modelId, 'grok-4.7');
  assert.deepEqual(refresh.rows('other'), []);
});
test('queued probes are fenced when the workspace changes', async () => {
  let workspace = 'w';
  const calls = [];
  const release = [];
  const refresh = createCapabilityRefresh(
    (w, a) => {
      calls.push(a.id);
      return new Promise((resolve) => release.push(resolve));
    },
    () => workspace,
    () => assert.fail('stale notification'),
  );
  refresh('w', {
    agents: ['a', 'b', 'c'].map((id) => ({
      id,
      machineId: 'm',
      cliType: 'builtin',
      agentType: 'grok',
    })),
    capabilities: [],
  });
  assert.deepEqual(calls, ['a']);
  workspace = 'other';
  release[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['a']);
});
