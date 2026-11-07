import assert from 'node:assert/strict';
import test from 'node:test';
import { Flock } from '@loro-dev/flock-wasm/base64';
import { projectRows } from '../../../../packages/cloud-runtime/src/protocol/catalog.ts';
import { mergeAgentQuotas } from '../../../../packages/cloud-runtime/src/protocol/agent-usage.ts';

test('machine replica changes reach usage rows, preserve zero/expired limits and never expose API credentials', () => {
  const machine = new Flock('usage-behavior');
  for (const [id, env] of [
    ['official', {}],
    ['api', { OPENAI_API_KEY: 'synthetic-secret' }],
  ]) {
    machine.set(['agentConfig', id], {
      id,
      machineId: 'm1',
      name: id,
      cliType: 'builtin',
      agentType: 'codex',
      env,
    });
  }
  machine.set(['agentConfig', 'foreign'], {
    id: 'foreign',
    machineId: 'm2',
    cliType: 'builtin',
    agentType: 'codex',
  });
  const snapshot = (percent) => ({
    limitId: 'codex',
    scope: { providerId: 'codex' },
    windows: [
      {
        usedPercent: percent,
        windowDurationSeconds: 18000,
        resetsAtEpochSeconds: 1,
      },
    ],
  });
  machine.set(['rateLimit', 'codex', 'codex'], snapshot(0));
  machine.set(['rateLimit', 'codex', 'codex_bengalfox'], {
    ...snapshot(8),
    limitId: 'codex_bengalfox',
  });
  machine.commit();
  const read = () => projectRows(machine.scan(), 'm1').agentUsage.m1;
  const quota = (usage, id) => usage.quotas.find((q) => q.id === id);
  const initial = read();
  assert.equal(initial.configs.length, 2);
  assert.ok(!JSON.stringify(initial).includes('synthetic-secret'));
  assert.equal(
    initial.configs.find((config) => config.id === 'api').eligible,
    false,
  );
  assert.equal(
    initial.configs.find((config) => config.id === 'official').eligible,
    true,
  );
  assert.equal(quota(initial, 'codex').windows[0].usedPercent, 0);
  assert.match(quota(initial, 'codex_bengalfox').name, /Spark/);
  machine.set(['rateLimit', 'codex', 'codex'], snapshot(72));
  machine.commit();
  const updated = read();
  const [window] = quota(updated, 'codex').windows;
  assert.equal(window.usedPercent, 72);
  assert.equal(window.duration, 18000);
  assert.equal(window.resetsAt, 1);
  // JSON is also the durable catalog boundary; offline must not recompute usage from a past reset time.
  assert.equal(
    quota(JSON.parse(JSON.stringify(updated)), 'codex').windows[0].usedPercent,
    72,
  );
  machine.delete(['rateLimit', 'codex', 'codex']);
  machine.delete(['rateLimit', 'codex', 'codex_bengalfox']);
  machine.commit();
  assert.deepEqual(read().quotas, []);
});

test('legacy Claude ratios and timestamps migrate while current windows and independent tiers win', () => {
  const legacy = projectRows(
    [
      { key: ['e', 'machine-m1'], value: true },
      {
        key: ['m', 'machine-m1'],
        value: {
          raceLimits: {
            claude: { fiveHour: 0.42, fiveHourResetAt: 1900000000000 },
            codex: { fiveHour: 11 },
            'codex::codex_bengalfox': { fiveHour: 8 },
          },
        },
      },
    ],
    'meta',
  ).agentUsage.m1.quotas;
  assert.equal(legacy[0].windows[0].usedPercent, 42);
  assert.equal(legacy[0].windows[0].resetsAt, 1900000000);
  assert.equal(legacy[1].windows[0].duration, 604800);
  const current = projectRows(
    [
      {
        key: ['rateLimit', 'codex', 'codex'],
        value: {
          limitId: 'codex',
          scope: { providerId: 'codex' },
          windows: [
            {
              usedPercent: 120,
              windowDurationSeconds: 18000,
              resetsAtEpochSeconds: null,
            },
            {
              usedPercent: NaN,
              windowDurationSeconds: 18000,
              resetsAtEpochSeconds: null,
            },
          ],
        },
      },
    ],
    'm1',
  ).agentUsage.m1.quotas;
  const merged = mergeAgentQuotas(legacy, current);
  assert.equal(merged.length, 3);
  const codex = merged.find((q) => q.id === 'codex');
  assert.equal(codex.windows.length, 1);
  assert.equal(codex.windows[0].usedPercent, 100);
  assert.ok(merged.some((q) => q.id === 'codex_bengalfox'));
  const claude = projectRows(
    [
      {
        key: ['rateLimit', 'claude', 'claude'],
        value: {
          limitId: 'claude',
          scope: { providerId: 'claude' },
          windows: [
            {
              usedPercent: 0.5,
              windowDurationSeconds: 60,
              resetsAtEpochSeconds: null,
            },
          ],
        },
      },
    ],
    'm1',
  ).agentUsage.m1.quotas;
  assert.equal(claude[0].windows[0].usedPercent, 0.5);
});
