import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { Flock } from '@loro-dev/flock-wasm/base64';

const bundle = await build({
  stdin: {
    contents: `export { registerProjects } from './packages/cloud-runtime/src/runtime/handlers/projects.ts';
    export { registerSessions } from './packages/cloud-runtime/src/runtime/handlers/sessions.ts';
    export { creationOptions } from './packages/cloud-runtime/src/runtime/create-session.ts';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  plugins: [
    {
      name: 'synthetic-transport',
      setup(b) {
        b.onResolve({ filter: /^@loro-dev\/streams-client$/ }, () => ({
          path: 'client',
          namespace: 'fixture',
        }));
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
          resolveDir: process.cwd(),
          contents: `export * from ${JSON.stringify(fileURLToPath(import.meta.resolve('@loro-dev/streams-client')))}; export class StreamsClient { async create() { return { ok: true }; } }`,
        }));
      },
    },
  ],
});
const { registerProjects, registerSessions, creationOptions } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text + '\n//# sourceURL=creation-availability-bundle.mjs').toString('base64')}`
);
function fixture() {
  const meta = new Flock('meta'),
    machine = new Flock('machine');
  meta.set(['e', 'machine-online'], true);
  meta.set(['e', 'machine-broken'], true);
  machine.set(['agentConfig', 'coder'], {
    id: 'coder',
    machineId: 'online',
    name: 'Coder',
    cliType: 'builtin',
    agentType: 'codex',
  });
  const state = {
    catalogs: new Map(),
    workspace: 'w',
    userId: 'u',
    metaReplica: { flock: meta },
    machineReplicas: new Map([['online', machine]]),
    unhealthy: new Set(['broken']),
    presence: { state: 'live', onlineMachineIds: ['online'] },
  };
  return { meta, machine, state };
}
test('creation lists a healthy online machine while another machine cannot sync', () => {
  const { state } = fixture(),
    handlers = new Map();
  registerProjects({
    state,
    channel: { handle: (name, fn) => handlers.set(name, fn) },
    getGrant: () => assert.fail('listing must not request a grant'),
    publish() {},
  });
  assert.deepEqual(
    handlers
      .get('creationOptions')({ workspaceId: 'w' })
      .agents.map((a) => a.id),
    ['coder'],
  );
  state.unhealthy.add('online');
  assert.deepEqual(
    handlers.get('creationOptions')({ workspaceId: 'w' }).agents,
    [],
  );
  state.metaReplica = undefined;
  assert.throws(
    () => handlers.get('creationOptions')({ workspaceId: 'w' }),
    /metadata_not_ready/,
  );
});
test('creation uses matching per-model declarations instead of the probed model snapshot', () => {
  const { meta, machine, state } = fixture();
  machine.set(['acpCapability', 'coder'], {
    cliType: 'builtin',
    agentType: 'codex',
    sourceVersion: 'v2',
    fetchedAt: 2,
    models: [
      { modelId: 'small', name: 'Small' },
      { modelId: 'large', name: 'Large' },
    ],
    configOptions: [
      {
        id: 'reasoning_effort',
        category: 'thought_level',
        name: 'Effort',
        type: 'select',
        options: [{ value: 'low', name: 'Low' }],
      },
    ],
  });
  machine.set(['acpModelCapability', 'coder'], {
    version: 1,
    sourceVersion: 'v2',
    models: {
      small: { effortValues: ['low'], fastMode: false },
      large: { effortValues: ['high', 'max'], fastMode: true },
    },
  });
  const result = creationOptions(undefined, meta, state.machineReplicas)
    .capabilities[0];
  assert.deepEqual(result.reasoningEfforts.large, ['high', 'max']);
  assert.deepEqual(result.fastModes, { small: false, large: true });
  machine.set(['acpModelCapability', 'coder'], {
    version: 1,
    sourceVersion: 'old',
    models: { large: { effortValues: ['wrong'] } },
  });
  const stale = creationOptions(undefined, meta, state.machineReplicas)
    .capabilities[0];
  assert.equal(stale.reasoningEfforts.large, undefined);
  assert.equal(stale.fastModes, undefined);
});

test('creation follows each model’s recorded options from a refresh that read every model', () => {
  const { meta, machine, state } = fixture();
  const effort = (values) => ({
    id: 'thought_level',
    category: 'thought_level',
    name: 'Thinking',
    type: 'select',
    currentValue: values[0],
    options: values.map((value) => ({ value, name: value })),
  });
  const fast = {
    id: 'fast',
    name: 'Fast',
    type: 'boolean',
    currentValue: false,
    options: [],
  };
  // Dimcode probed on mimo: its snapshot ladder alone would serve every model.
  machine.set(['acpCapability', 'dim'], {
    cliType: 'builtin',
    agentType: 'dimcode',
    sourceVersion: 'v1',
    fetchedAt: 2,
    models: [],
    configOptions: [
      {
        id: 'model',
        category: 'model',
        name: 'Model',
        type: 'select',
        currentValue: 'mimo',
        options: ['mimo', 'flash', 'qwen', 'plain'].map((value) => ({
          value,
          name: value,
        })),
      },
      effort(['auto', 'none']),
    ],
  });
  machine.set(['acpModelConfigOptionsShape', 'dim', 's1'], {
    version: 1,
    configOptions: [effort(['auto', 'low', 'max']), fast],
  });
  machine.set(['acpModelConfigOptionsShape', 'dim', 's2'], {
    version: 1,
    configOptions: [],
  });
  machine.set(['acpModelConfigOptions', 'dim', 'flash'], {
    version: 1,
    sourceVersion: 'v0',
    shape: 's1',
  });
  machine.set(['acpModelConfigOptions', 'dim', 'plain'], {
    version: 1,
    sourceVersion: 'v1',
    shape: 's2',
  });
  // A pointer whose shape has not synced yet stays unknown.
  machine.set(['acpModelConfigOptions', 'dim', 'qwen'], {
    version: 1,
    sourceVersion: 'v1',
    shape: 'missing',
  });

  const result = creationOptions(undefined, meta, state.machineReplicas)
    .capabilities[0];
  assert.deepEqual(result.reasoningEfforts.flash, ['auto', 'low', 'max']);
  assert.deepEqual(result.reasoningEfforts.plain, []);
  assert.equal(result.reasoningEfforts.qwen, undefined);
  assert.deepEqual(result.fastModes, { flash: true, plain: false });
  // Fast exists only on a recorded model, so the control is offered and
  // hidden per model through fastModes.
  assert.ok(result.configOptions.some((option) => option.id === 'fast'));

  // A declaration still decides over a recorded list.
  machine.set(['acpModelCapability', 'dim'], {
    version: 1,
    sourceVersion: 'v1',
    models: { flash: { effortValues: ['high'], fastMode: false } },
  });
  const declared = creationOptions(undefined, meta, state.machineReplicas)
    .capabilities[0];
  assert.deepEqual(declared.reasoningEfforts.flash, ['high']);
  assert.equal(declared.fastModes.flash, false);
});

test('creating on a healthy machine is not rejected by an unrelated sync failure', async () => {
  const { state, meta } = fixture(),
    handlers = new Map();
  state.metaReplica.client = { append: async () => ({ ok: true }) };
  registerSessions(
    {
      state,
      getGrant: async () => ({
        token: 'fixture',
        gatewayBaseUrl: 'https://example.invalid',
      }),
      channel: { handle: (name, fn) => handlers.set(name, fn) },
      publish() {},
    },
    () => {},
  );
  const args = {
    workspaceId: 'w',
    sessionId: crypto.randomUUID(),
    machineId: 'online',
    agentConfigId: 'coder',
    userId: 'u',
    title: 'Test',
    billingEntitlement: null,
  };
  assert.equal((await handlers.get('createSession')(args)).state, 'created');
  assert.equal(
    meta.get(['m', `session-${args.sessionId}`]).agentConfigId,
    'coder',
  );
  state.unhealthy.add('online');
  assert.equal(
    (
      await handlers.get('createSession')({
        ...args,
        sessionId: crypto.randomUUID(),
      })
    ).state,
    'rejected',
  );
});

// The daemon merges repo metadata with machine rows; a provider may live in either.
test('creation merges live metadata agents with authoritative machine configs', () => {
  const { meta, machine, state } = fixture();
  const put = (id, fields, alive = true) => {
    meta.set(['e', `agent-${id}`], alive);
    meta.set(['m', `agent-${id}`], {
      id,
      machineId: 'online',
      name: id,
      cliType: 'builtin',
      agentType: 'codex',
      env: { SECRET: 'never-project' },
      ...fields,
    });
  };
  put('legacy', {});
  meta.set(['m', 'agent-legacy', 'name'], 'Codex');
  put('coder', { name: 'Old Coder' });
  put('removed', {}, false);
  put('foreign', { machineId: 'unreadable' });
  put('mismatch', { id: 'different' });
  const options = creationOptions(undefined, meta, state.machineReplicas);
  assert.deepEqual(
    options.agents
      .map(({ id, name }) => ({ id, name }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: 'coder', name: 'Coder' },
      { id: 'legacy', name: 'Codex' },
    ],
  );
  assert.equal(JSON.stringify(options).includes('never-project'), false);
  meta.set(['e', 'agent-legacy'], false);
  assert.deepEqual(
    creationOptions(undefined, meta, state.machineReplicas).agents.map(
      (a) => a.id,
    ),
    ['coder'],
  );
});
