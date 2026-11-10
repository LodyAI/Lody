import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { Flock } from '@loro-dev/flock-wasm/base64';

const bundleOptions = {
  entryPoints: [
    new URL(
      '../../../../packages/cloud-runtime/src/runtime/settings.ts',
      import.meta.url,
    ).pathname,
  ],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  plugins: [
    {
      name: 'streams',
      setup(b) {
        b.onResolve({ filter: /^@loro-dev\/streams-client$/ }, () => ({
          path: 'mock',
          namespace: 'test',
        }));
        b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
          contents:
            'export class StreamsClient { constructor(args) { return new globalThis.__settingsClient(args); } }',
        }));
      },
    },
  ],
};
const bundle = await build(bundleOptions);
const { settingsRows, editSetting, remoteSettings } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);

const providerBundle = await build({
  ...bundleOptions,
  entryPoints: [
    new URL(
      '../../../../packages/cloud-runtime/src/runtime/provider-settings.ts',
      import.meta.url,
    ).pathname,
  ],
});
const { providerRows, changeProvider, agentProviders } = await import(
  `data:text/javascript;base64,${Buffer.from(providerBundle.outputFiles[0].text).toString('base64')}`
);

const detailBundle = await build({
  ...bundleOptions,
  entryPoints: [
    new URL(
      '../../../../packages/cloud-runtime/src/runtime/provider-detail.ts',
      import.meta.url,
    ).pathname,
  ],
});
const { providerDetail, providerRevision } = await import(
  `data:text/javascript;base64,${Buffer.from(detailBundle.outputFiles[0].text).toString('base64')}`
);
const detailRequest = {
  workspaceId: 'w1',
  userId: 'owner',
  machineId: 'm1',
  id: '10000000-0000-4000-8000-000000000001',
};
const readDetail = () =>
  providerDetail(
    detailRequest,
    async () => ({ token: 'fixture', gatewayBaseUrl: 'https://example.com' }),
    new AbortController().signal,
    () => {},
  );

test('machine rename respects field metadata, excludes removed machines, and keeps ownership', () => {
  const flock = new Flock('machine-settings');
  flock.set(['e', 'machine-m1'], true);
  flock.set(['m', 'machine-m1'], { name: 'Old', ownerUserId: 'owner' });
  flock.set(['m', 'machine-m1', 'name'], 'Current');
  flock.set(['e', 'machine-m2'], false);
  flock.set(['m', 'machine-m2'], { name: 'Removed' });
  const [item] = settingsRows('machine', flock);
  assert.equal(item.name, 'Current');
  assert.equal(settingsRows('machine', flock).length, 1);
  editSetting(flock, { kind: 'machine', edit: { item, name: ' Renamed ' } });
  assert.equal(flock.get(['m', 'machine-m1', 'name']), 'Renamed');
  assert.equal(flock.get(['m', 'machine-m1']).ownerUserId, 'owner');
  assert.throws(
    () =>
      editSetting(flock, { kind: 'machine', edit: { item, name: 'Again' } }),
    /setting_conflict/,
  );
});

test('agent edits preserve secrets and unknown fields without projecting them to the UI', () => {
  const flock = new Flock('agent-settings');
  const key = ['agentConfig', 'a1'];
  flock.set(key, {
    id: 'a1',
    machineId: 'm1',
    name: 'Codex',
    prompt: 'Old',
    env: { SECRET: 'fixture-only' },
    futureField: { keep: true },
  });
  const [item] = settingsRows('agent', flock, 'm1');
  assert.equal(item.env, undefined);
  assert.equal(settingsRows('agent', flock, 'another-machine').length, 0);
  editSetting(flock, {
    kind: 'agent',
    edit: { item, name: 'My Codex', prompt: 'New instructions' },
  });
  assert.deepEqual(flock.get(key).env, { SECRET: 'fixture-only' });
  assert.deepEqual(flock.get(key).futureField, { keep: true });
  assert.equal(flock.get(key).prompt, 'New instructions');
  assert.throws(
    () =>
      editSetting(flock, {
        kind: 'agent',
        edit: {
          item: settingsRows('agent', flock, 'm1')[0],
          name: ' ',
          prompt: '',
        },
      }),
    /invalid_setting/,
  );
});

test('remote save reaches the correct stream using framed updates; failures are not reported as success', async () => {
  const remote = new Flock('server');
  remote.set(['e', 'machine-one'], true);
  remote.set(['m', 'machine-one'], { name: 'Old', ownerUserId: 'owner' });
  let fail = false,
    writes = 0;
  const urls = [];
  globalThis.__settingsClient = class {
    constructor({ url }) {
      urls.push(decodeURIComponent(url));
    }
    async bootstrap() {
      return {
        ok: true,
        result: {
          snapshotOffset: '1',
          snapshot: { body: remote.exportFile() },
          updates: [],
          nextOffset: '1',
          upToDate: true,
        },
      };
    }
    async append({ part }) {
      writes++;
      if (fail) return { ok: false, result: { code: 'network' } };
      assert.equal(
        new DataView(part.body.buffer, part.body.byteOffset).getUint32(0),
        part.body.length - 4,
      );
      remote.importJson(
        JSON.parse(new TextDecoder().decode(part.body.subarray(4))),
      );
      return { ok: true, result: {} };
    }
  };
  const grant = async () => ({
    token: 'fixture',
    gatewayBaseUrl: 'https://example.com',
  });
  const request = { workspaceId: 'w1', kind: 'machine' };
  const [item] = await remoteSettings(
    request,
    'owner',
    grant,
    AbortSignal.timeout(5000),
  );
  await remoteSettings(
    { ...request, edit: { item, name: 'Docs' } },
    'owner',
    grant,
    AbortSignal.timeout(5000),
  );
  assert.equal(remote.get(['m', 'machine-one', 'name']), 'Docs');
  assert.ok(urls.every((url) => url === 'https://example.com/ds/lody/w1:meta'));
  fail = true;
  const [latest] = settingsRows('machine', remote);
  await assert.rejects(
    remoteSettings(
      {
        ...request,
        edit: { item: latest, name: 'Failed' },
      },
      'owner',
      grant,
      AbortSignal.timeout(5000),
    ),
    /setting_write_unknown/,
  );
  assert.equal(remote.get(['m', 'machine-one', 'name']), 'Docs');
  assert.equal(writes, 2, 'a failed write must not be replayed');
});

test('remote machine and agent writes require the authenticated machine owner', async () => {
  const meta = new Flock('ownership');
  meta.set(['e', 'machine-m1'], true);
  meta.set(['m', 'machine-m1'], { name: 'Shared Mac', ownerUserId: 'owner' });
  let writes = 0;
  globalThis.__settingsClient = class {
    async bootstrap() {
      return {
        ok: true,
        result: {
          snapshotOffset: '1',
          snapshot: { body: meta.exportFile() },
          updates: [],
          nextOffset: '1',
          upToDate: true,
        },
      };
    }
    async append() {
      writes++;
      return { ok: true, result: {} };
    }
  };
  const grant = async () => ({
    token: 'fixture',
    gatewayBaseUrl: 'https://example.com',
  });
  const request = { workspaceId: 'w1', kind: 'machine' };
  const [item] = await remoteSettings(
    request,
    'other-member',
    grant,
    AbortSignal.timeout(5000),
  );
  assert.equal(item.readOnly, true);
  await assert.rejects(
    remoteSettings(
      { ...request, edit: { item, name: 'Not mine' } },
      'other-member',
      grant,
      AbortSignal.timeout(5000),
    ),
    /setting_read_only/,
  );
  await assert.rejects(
    remoteSettings(
      {
        workspaceId: 'w1',
        kind: 'agent',
        edit: {
          item: { kind: 'agent', id: 'a1', machineId: 'm1' },
          name: 'Not mine',
          prompt: 'changed',
        },
      },
      'other-member',
      grant,
      AbortSignal.timeout(5000),
    ),
    /setting_read_only/,
  );
  assert.equal(writes, 0);
  const [owned] = await remoteSettings(
    request,
    'owner',
    grant,
    AbortSignal.timeout(5000),
  );
  assert.equal(owned.readOnly, false);
  await remoteSettings(
    { ...request, edit: { item: owned, name: 'Mine' } },
    'owner',
    grant,
    AbortSignal.timeout(5000),
  );
  assert.equal(writes, 1);
});

test('same-id Agent edits reach only the selected machine and read back without exposing secrets', async () => {
  const meta = new Flock('agent-machines');
  const replicas = new Map([['w1:meta', meta]]);
  for (const id of ['m1', 'm2']) {
    meta.set(['e', `machine-${id}`], true);
    meta.set(['m', `machine-${id}`], {
      name: 'Studio Mac',
      ownerUserId: 'owner',
    });
    const flock = new Flock(`agent-${id}`);
    flock.set(['agentConfig', 'a1'], {
      id: 'a1',
      machineId: id,
      name: 'Codex',
      prompt: `${id} instructions`,
      env: { SECRET: 'fixture-only' },
      futureField: id,
    });
    replicas.set(`w1:mf:${id}`, flock);
  }
  const writes = [];
  globalThis.__settingsClient = class {
    constructor({ url }) {
      this.stream = decodeURIComponent(url).split('/ds/lody/')[1];
      this.remote = replicas.get(this.stream);
      assert.ok(this.remote, `Unexpected stream ${this.stream}`);
    }
    async bootstrap() {
      return {
        ok: true,
        result: {
          snapshotOffset: '1',
          snapshot: { body: this.remote.exportFile() },
          updates: [],
          nextOffset: '1',
          upToDate: true,
        },
      };
    }
    async append({ part }) {
      writes.push(this.stream);
      assert.equal(
        new DataView(part.body.buffer, part.body.byteOffset).getUint32(0),
        part.body.length - 4,
      );
      this.remote.importJson(
        JSON.parse(new TextDecoder().decode(part.body.subarray(4))),
      );
      return { ok: true, result: {} };
    }
  };
  const grant = async () => ({
    token: 'fixture',
    gatewayBaseUrl: 'https://example.com',
  });
  const request = { workspaceId: 'w1', kind: 'agent' };
  const read = () =>
    remoteSettings(request, 'owner', grant, AbortSignal.timeout(5000));
  const items = await read();
  assert.equal(items.length, 2);
  assert.equal(JSON.stringify(items).includes('fixture-only'), false);
  const item = items.find((item) => item.machineId === 'm2');
  await remoteSettings(
    { ...request, edit: { item, name: 'Work Codex', prompt: 'Updated' } },
    'owner',
    grant,
    AbortSignal.timeout(5000),
  );
  assert.deepEqual(writes, ['w1:mf:m2']);
  const saved = await read();
  assert.equal(
    saved.find((row) => row.machineId === 'm1').prompt,
    'm1 instructions',
  );
  assert.equal(saved.find((row) => row.machineId === 'm1').name, 'Codex');
  assert.equal(saved.find((row) => row.machineId === 'm2').prompt, 'Updated');
  assert.equal(saved.find((row) => row.machineId === 'm2').name, 'Work Codex');
  assert.deepEqual(replicas.get('w1:mf:m2').get(['agentConfig', 'a1']).env, {
    SECRET: 'fixture-only',
  });
  assert.equal(
    replicas.get('w1:mf:m2').get(['agentConfig', 'a1']).futureField,
    'm2',
  );
  assert.equal(JSON.stringify(saved).includes('fixture-only'), false);
});

const providerId = '10000000-0000-4000-8000-000000000001';
const providerFields = {
  name: 'My Codex',
  prompt: 'Instructions',
  cliType: 'builtin',
  agentType: 'codex',
  command: '',
  args: [],
};
const providerScope = { workspaceId: 'w1', userId: 'owner' };
const providerSave = {
  ...providerScope,
  action: 'save',
  machineId: 'm1',
  id: providerId,
  base: null,
  fields: providerFields,
};

function providerFixture() {
  const meta = new Flock('provider-meta');
  meta.set(['e', 'machine-m1'], true);
  meta.set(['m', 'machine-m1'], {
    name: 'Laptop',
    os: 'darwin',
    ownerUserId: 'owner',
    protocolCapabilities: { providerSetup: 1 },
  });
  const machine = new Flock('provider-machine');
  const others = new Map();
  const writes = [];
  let failAt = -1;
  let replyOverrides = {};
  let rpcResult;
  globalThis.__settingsClient = class {
    constructor({ url }) {
      this.stream = decodeURIComponent(url).split('/ds/lody/')[1];
    }
    async bootstrap() {
      const flock =
        this.stream === 'w1:meta' ? meta : (others.get(this.stream) ?? machine);
      return {
        ok: true,
        result: {
          snapshotOffset: '1',
          snapshot: { body: flock.exportFile() },
          updates: [],
          nextOffset: '1',
          upToDate: true,
        },
      };
    }
    async create() {
      return { ok: true, result: {} };
    }
    async append({ part }) {
      if (this.stream.includes(':rpc:req:')) {
        const request = JSON.parse(part.body);
        assert.equal(request.method, 'machine/acp-capabilities-refresh');
        assert.deepEqual(request.params, { configId: providerId, force: true });
        rpcResult = {
          id: request.id,
          result: {
            machineId: 'm1',
            configId: providerId,
            cliType: 'builtin',
            agentType: 'codex',
            success: false,
            authRequired: true,
            error: 'synthetic-private-provider-output',
            ...replyOverrides,
          },
        };
        return { ok: true, result: {} };
      }
      writes.push(this.stream);
      if (writes.length === failAt)
        throw new Error('synthetic-private-transport-error');
      machine.importJson(
        JSON.parse(new TextDecoder().decode(part.body.subarray(4))),
      );
      return { ok: true, result: {} };
    }
    async readOnce() {
      return {
        ok: true,
        result: {
          nextOffset: '1',
          payload: {
            body: new TextEncoder().encode(JSON.stringify(rpcResult)),
          },
        },
      };
    }
  };
  const grant = async () => ({
    token: 'fixture',
    gatewayBaseUrl: 'https://example.com',
  });
  const run = (request) =>
    agentProviders(
      request,
      grant,
      new AbortController().signal,
      { state: 'live', onlineMachineIds: ['m1'] },
      () => {},
    );
  return {
    meta,
    machine,
    others,
    writes,
    run,
    failWrite: (number) => {
      failAt = number;
    },
    overrideReply: (value) => {
      replyOverrides = value;
    },
  };
}

test('native provider creation queues capable targets and uses explicit config writes on older targets', async () => {
  const { meta, machine, run } = providerFixture();
  const result = await run(providerSave);
  assert.equal(result.providers.length, 0);
  assert.equal(result.setups[0].status, 'queued');
  assert.equal(result.setups[0].name, 'My Codex');
  assert.deepEqual(machine.get(['providerSetup', providerId]).config.env, {});
  assert.equal(machine.get(['agentConfig', providerId]), undefined);
  meta.set(['m', 'machine-m1', 'protocolCapabilities'], {});
  const direct = await run({
    ...providerSave,
    id: '10000000-0000-4000-8000-000000000002',
  });
  assert.equal(direct.providers[0].id, '10000000-0000-4000-8000-000000000002');
  await assert.rejects(
    run({ ...providerSave, userId: 'member' }),
    /setting_read_only/,
  );
});

test('native provider edits preserve credentials and future fields, and reject stale or substituted identities', () => {
  const machine = new Flock('provider-edit');
  machine.set(['agentConfig', providerId], {
    id: providerId,
    machineId: 'm1',
    ...providerFields,
    env: { API_KEY: 'synthetic-secret' },
    futureField: { keep: true },
  });
  const base = providerRows(machine, 'm1', false).providers[0];
  assert.equal(JSON.stringify(base).includes('synthetic-secret'), false);
  const edit = {
    ...providerSave,
    base,
    fields: { ...providerFields, name: 'Updated' },
  };
  changeProvider(machine, edit, true, 100);
  const saved = machine.get(['agentConfig', providerId]);
  assert.equal(saved.name, 'Updated');
  assert.equal(saved.env.API_KEY, 'synthetic-secret');
  assert.deepEqual(saved.futureField, { keep: true });
  assert.throws(
    () => changeProvider(machine, edit, true, 101),
    /provider_conflict/,
  );
  const current = providerRows(machine, 'm1', false).providers[0];
  assert.throws(
    () =>
      changeProvider(
        machine,
        {
          ...edit,
          base: current,
          fields: { ...edit.fields, agentType: 'claude' },
        },
        true,
        102,
      ),
    /provider_identity_immutable/,
  );
});

test('provider removal records only the last builtin opt-out and removes only its own scoped quota', () => {
  const machine = new Flock('provider-remove');
  for (const id of [providerId, 'second'])
    machine.set(['agentConfig', id], {
      id,
      machineId: 'm1',
      ...providerFields,
      env: {},
    });
  machine.set(['rateLimit', providerId, 'codex', 'window'], { used: 1 });
  machine.set(['rateLimit', 'second', 'codex', 'window'], { used: 2 });
  machine.set(['rateLimit', 'codex', 'legacy'], { used: 3 });
  let rows = providerRows(machine, 'm1', false).providers;
  changeProvider(
    machine,
    {
      ...providerScope,
      action: 'delete',
      base: rows.find((item) => item.id === providerId),
    },
    true,
    100,
  );
  assert.equal(machine.get(['builtinAgentOptOut', 'codex']), undefined);
  assert.equal(
    machine.get(['rateLimit', providerId, 'codex', 'window']),
    undefined,
  );
  assert.deepEqual(machine.get(['rateLimit', 'second', 'codex', 'window']), {
    used: 2,
  });
  assert.deepEqual(machine.get(['rateLimit', 'codex', 'legacy']), { used: 3 });
  rows = providerRows(machine, 'm1', false).providers;
  changeProvider(
    machine,
    { ...providerScope, action: 'delete', base: rows[0] },
    true,
    101,
  );
  assert.deepEqual(machine.get(['builtinAgentOptOut', 'codex']), {
    v: 1,
    removedAt: 101,
  });
});

test('provider cancellation survives cleanup failure through its accepted durable tombstone', async () => {
  const { machine, run, failWrite, writes } = providerFixture();
  const created = await run(providerSave);
  failWrite(3); // create, durable cancellation, then interrupted cleanup
  await assert.rejects(
    run({ ...providerScope, action: 'deleteSetup', setup: created.setups[0] }),
    /setting_write_unknown/,
  );
  assert.equal(
    machine.get(['providerSetupCancellation', providerId]).id,
    providerId,
  );
  assert.ok(machine.get(['providerSetup', providerId]));
  assert.equal(providerRows(machine, 'm1', false).setups.length, 0);
  assert.equal(writes.length, 3);
});

test('provider retry preserves config, increments attempt and rejects stale or active setup retries', async () => {
  const { machine, run } = providerFixture();
  const created = await run(providerSave);
  await assert.rejects(
    run({ ...providerScope, action: 'retrySetup', setup: created.setups[0] }),
    /provider_conflict/,
  );
  const key = ['providerSetup', providerId];
  machine.set(key, {
    ...machine.get(key),
    status: 'failed',
    failureCode: 'verification-failed',
  });
  const failed = (await run({ ...providerScope, action: 'list' })).setups[0];
  const retried = await run({
    ...providerScope,
    action: 'retrySetup',
    setup: failed,
  });
  assert.equal(retried.setups[0].attempt, 2);
  assert.equal(retried.setups[0].status, 'queued');
  assert.equal(machine.get(key).failureCode, undefined);
  assert.equal(machine.get(key).config.prompt, 'Instructions');
  await assert.rejects(
    run({ ...providerScope, action: 'retrySetup', setup: failed }),
    /provider_conflict/,
  );
});

test('provider refresh uses the persisted target and returns only the safe auth-required state', async () => {
  const { machine, run } = providerFixture();
  machine.set(['agentConfig', providerId], {
    id: providerId,
    machineId: 'm1',
    ...providerFields,
    env: {},
  });
  const base = providerRows(machine, 'm1', false).providers[0];
  const refreshed = await run({ ...providerScope, action: 'refresh', base });
  assert.equal(refreshed.authRequired, true);
  assert.equal(
    JSON.stringify(refreshed).includes('synthetic-private-provider-output'),
    false,
  );
  await assert.rejects(
    run({
      ...providerScope,
      action: 'refresh',
      base: { ...base, agentType: 'claude' },
    }),
    /provider_conflict/,
  );
});

test('an unrelated machine failure cannot prevent or obscure a provider write receipt', async () => {
  for (const name of ['A first', 'Z last']) {
    const { meta, machine, others, writes, run } = providerFixture();
    meta.set(['e', 'machine-m2'], true);
    meta.set(['m', 'machine-m2'], { name, ownerUserId: 'other-owner' });
    others.set('w1:mf:m2', {
      exportFile() {
        throw new Error('independent_machine_failure');
      },
    });
    machine.set(['agentConfig', providerId], {
      id: providerId,
      machineId: 'm1',
      ...providerFields,
      env: {},
    });
    const base = providerRows(machine, 'm1', false).providers[0];
    const snapshot = await run({
      ...providerSave,
      base,
      fields: { ...providerFields, name: 'Renamed' },
    });
    assert.deepEqual(
      snapshot.providers.map((item) => [item.machineId, item.name]),
      [['m1', 'Renamed']],
    );
    assert.equal(machine.get(['agentConfig', providerId]).name, 'Renamed');
    assert.deepEqual(writes, ['w1:mf:m1']);
    await assert.rejects(
      run({ ...providerScope, action: 'list' }),
      /independent_machine_failure/,
    );
  }
});

test('custom launch editing preserves unexposed fields and catalog supports real registry identities and DeepSeek', async () => {
  const { machine, run } = providerFixture();
  const listed = await run({ ...providerScope, action: 'list' });
  const registry = listed.catalog.find((item) => item.cliType === 'registry');
  assert.ok(registry);
  assert.ok(listed.catalog.some((item) => item.agentType === 'deepseek'));
  const created = await run({
    ...providerSave,
    fields: {
      ...providerFields,
      cliType: 'registry',
      agentType: registry.agentType,
    },
  });
  assert.equal(created.providers[0].agentType, registry.agentType);
  const customId = '10000000-0000-4000-8000-000000000002';
  const fields = {
    ...providerFields,
    cliType: 'custom',
    agentType: 'custom',
    command: '/usr/local/bin/agent',
    args: ['--acp'],
  };
  const custom = await run({ ...providerSave, id: customId, fields });
  const base = custom.providers.find((item) => item.id === customId);
  assert.equal(base.agentType, `custom-${customId}`);
  const key = ['agentConfig', customId],
    value = machine.get(key);
  machine.set(key, {
    ...value,
    customAcp: { ...value.customAcp, futureLaunch: 'keep' },
  });
  await run({
    ...providerSave,
    id: customId,
    base,
    fields: { ...fields, agentType: base.agentType, command: '/new/agent' },
  });
  assert.equal(machine.get(key).customAcp.futureLaunch, 'keep');
  assert.equal(machine.get(key).customAcp.command, '/new/agent');
});

test('provider refresh rejects a result for another provider even when success is true', async () => {
  const { machine, run, overrideReply } = providerFixture();
  machine.set(['agentConfig', providerId], {
    id: providerId,
    machineId: 'm1',
    ...providerFields,
    env: {},
  });
  const base = providerRows(machine, 'm1', false).providers[0];
  overrideReply({ success: true, configId: 'another-provider' });
  await assert.rejects(
    run({ ...providerScope, action: 'refresh', base }),
    /provider_refresh_failed/,
  );
});

test('provider detail redacts credentials and advanced patches preserve omitted secrets with revision fencing', async () => {
  const { machine, run } = providerFixture();
  const key = ['agentConfig', providerId];
  machine.set(key, {
    id: providerId,
    machineId: 'm1',
    ...providerFields,
    description: 'Work',
    env: {
      API_KEY: 'synthetic-private-key',
      KEEP: 'synthetic-hidden-value',
      DELETE: 'old',
      ANTHROPIC_BASE_URL: 'https://api.example.com/path',
    },
    futureField: { keep: true },
    runtimeOverrides: { codexPath: '/bin/codex', futureLaunch: 'preserve' },
    titleGeneration: { configOptionValues: { model: 'small' } },
  });
  const detail = await readDetail();
  assert.equal(JSON.stringify(detail).includes('synthetic-private-key'), false);
  assert.equal(
    JSON.stringify(detail).includes('synthetic-hidden-value'),
    false,
  );
  assert.deepEqual(
    detail.env.find((row) => row.key === 'API_KEY'),
    { key: 'API_KEY', hasValue: true },
  );
  assert.deepEqual(detail.endpoints, [
    { key: 'ANTHROPIC_BASE_URL', value: 'https://api.example.com/path' },
  ]);
  let base = providerRows(machine, 'm1', false).providers[0];
  await run({
    ...providerSave,
    base,
    fields: {
      ...providerFields,
      detailRevision: detail.revision,
      envPatch: { DELETE: null, NEW: '', API_KEY: 'synthetic-replaced-key' },
      runtimeOverrides: {
        action: 'merge',
        value: { codexPath: '/new/codex' },
        remove: [],
      },
    },
  });
  const saved = machine.get(key);
  assert.equal(saved.env.KEEP, 'synthetic-hidden-value');
  assert.equal(saved.env.DELETE, undefined);
  assert.equal(saved.env.NEW, '');
  assert.equal(saved.env.API_KEY, 'synthetic-replaced-key');
  assert.equal(saved.runtimeOverrides.futureLaunch, 'preserve');
  assert.deepEqual(saved.titleGeneration, {
    configOptionValues: { model: 'small' },
  });
  base = providerRows(machine, 'm1', false).providers[0];
  await assert.rejects(
    run({
      ...providerSave,
      base,
      fields: {
        ...providerFields,
        detailRevision: detail.revision,
        envPatch: { KEEP: 'stale' },
      },
    }),
    /provider_conflict/,
  );
  const current = await readDetail();
  await run({
    ...providerSave,
    base,
    fields: {
      ...providerFields,
      detailRevision: current.revision,
      runtimeOverrides: { action: 'clear' },
      titleGeneration: { action: 'clear' },
    },
  });
  assert.equal(machine.get(key).runtimeOverrides, undefined);
  assert.equal(machine.get(key).titleGeneration, undefined);
});

test('native preset catalog applies Web credential modes and endpoints without echoing tokens', async () => {
  const { machine, run } = providerFixture();
  const catalog = await run({ ...providerScope, action: 'list' });
  const preset = catalog.presets.find(
    (item) => item.id === 'mimo-over-claude-code',
  );
  assert.equal(preset.tokenEnvKey, 'ANTHROPIC_AUTH_TOKEN');
  assert.ok(
    preset.modes
      .find((mode) => mode.id === 'token-plan')
      .endpoints.some((e) => e.id === 'sgp'),
  );
  const result = await run({
    ...providerSave,
    fields: {
      ...providerFields,
      agentType: 'claude',
      presetId: preset.id,
      presetModeId: 'token-plan',
      presetEndpoint: 'https://token-plan-sgp.xiaomimimo.com/anthropic',
      envPatch: { ANTHROPIC_AUTH_TOKEN: 'tp-synthetic-private-key' },
    },
  });
  const config = machine.get(['providerSetup', providerId]).config;
  assert.equal(
    config.env.ANTHROPIC_BASE_URL,
    'https://token-plan-sgp.xiaomimimo.com/anthropic',
  );
  assert.equal(config.env.ANTHROPIC_AUTH_TOKEN, 'tp-synthetic-private-key');
  assert.equal(config.brandId, 'mimo');
  assert.equal(
    JSON.stringify(result).includes('tp-synthetic-private-key'),
    false,
  );
  const pending = await readDetail();
  assert.equal(pending.presetId, preset.id);
  assert.equal(
    JSON.stringify(pending).includes('tp-synthetic-private-key'),
    false,
  );
});

test('Codex profile creation is capability gated and preserves immutable account identity', async () => {
  const { meta, machine, run } = providerFixture();
  const codexAuth = {
    mode: 'api-key',
    profileId: '20000000-0000-4000-8000-000000000001',
    baseUrl: 'https://codex.example.com/v1',
  };
  await assert.rejects(
    run({ ...providerSave, fields: { ...providerFields, codexAuth } }),
    /codex_profiles_unsupported/,
  );
  meta.set(['m', 'machine-m1', 'protocolCapabilities'], {
    providerSetup: 1,
    codexAuthProfiles: 1,
  });
  await run({ ...providerSave, fields: { ...providerFields, codexAuth } });
  const pending = machine.get(['providerSetup', providerId]).config;
  assert.equal(pending.runtimeOverrides.codexPath, '\0lody-codex-profile-v1');
  assert.deepEqual((await readDetail()).runtimeOverrides, {});
  machine.delete(['providerSetup', providerId]);
  machine.set(['agentConfig', providerId], pending);
  const base = providerRows(machine, 'm1', false).providers[0];
  const detail = await readDetail();
  await assert.rejects(
    run({
      ...providerSave,
      base,
      fields: {
        ...providerFields,
        detailRevision: detail.revision,
        codexAuth: {
          ...codexAuth,
          profileId: '20000000-0000-4000-8000-000000000002',
        },
      },
    }),
    /provider_identity_immutable/,
  );
  await assert.rejects(
    run({
      ...providerSave,
      base,
      fields: {
        ...providerFields,
        detailRevision: detail.revision,
        envPatch: { OPENAI_API_KEY: 'synthetic' },
      },
    }),
    /invalid_codex_profile/,
  );
});

test('advanced overrides avoid background setup, and endpoint credentials never enter safe detail', async () => {
  const { machine, run } = providerFixture();
  await run({
    ...providerSave,
    fields: {
      ...providerFields,
      runtimeOverrides: {
        action: 'merge',
        value: { codexPath: '/custom/codex' },
        remove: [],
      },
    },
  });
  assert.ok(machine.get(['agentConfig', providerId]));
  assert.equal(machine.get(['providerSetup', providerId]), undefined);
  const key = ['agentConfig', providerId],
    config = machine.get(key);
  machine.set(key, {
    ...config,
    env: {
      ANTHROPIC_BASE_URL:
        'https://user:synthetic-secret@example.com/path?token=secret',
    },
  });
  assert.deepEqual((await readDetail()).endpoints, []);
  const detail = await readDetail(),
    base = providerRows(machine, 'm1', false).providers[0];
  await assert.rejects(
    run({
      ...providerSave,
      base,
      fields: {
        ...providerFields,
        detailRevision: detail.revision,
        envPatch: { ANTHROPIC_BASE_URL: 'https://user:secret@example.com/' },
      },
    }),
    /invalid_provider_endpoint/,
  );
});
