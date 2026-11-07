import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { Flock } from '@loro-dev/flock-wasm/base64';

const bundle = await build({
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
});
const { settingsRows, editSetting, remoteSettings } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
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

test('MCP rejects duplicate names and preserves connection when changing defaults', () => {
  const flock = new Flock('mcp-settings');
  const connection = {
    transport: 'http',
    url: 'https://example.com/mcp',
    bearerToken: 'fixture-only',
  };
  flock.set(['mcpServer', 'one'], {
    id: 'one',
    name: 'Docs',
    transport: 'http',
    connection,
    createdAt: 10,
  });
  flock.set(['mcpServer', 'two'], {
    id: 'two',
    name: 'Search',
    transport: 'stdio',
  });
  const item = settingsRows('mcp', flock).find((row) => row.id === 'one');
  assert.equal(item.connection, undefined);
  assert.throws(
    () =>
      editSetting(flock, {
        kind: 'mcp',
        edit: { item, name: 'search', enabledByDefault: true },
      }),
    /setting_duplicate/,
  );
  editSetting(flock, {
    kind: 'mcp',
    edit: { item, name: 'Docs', enabledByDefault: true },
  });
  const saved = flock.get(['mcpServer', 'one']);
  assert.equal(saved.enabledByDefault, true);
  assert.deepEqual(saved.connection, connection);
  assert.equal(saved.createdAt, 10);
});

test('remote save reaches the correct stream using framed updates; failures are not reported as success', async () => {
  const remote = new Flock('server');
  remote.set(['mcpServer', 'one'], {
    id: 'one',
    name: 'Docs',
    transport: 'http',
    connection: { transport: 'http', url: 'https://example.com/mcp' },
  });
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
  const request = { workspaceId: 'w1', kind: 'mcp' };
  const [item] = await remoteSettings(
    request,
    'owner',
    grant,
    AbortSignal.timeout(5000),
  );
  await remoteSettings(
    { ...request, edit: { item, name: 'Docs', enabledByDefault: true } },
    'owner',
    grant,
    AbortSignal.timeout(5000),
  );
  assert.equal(remote.get(['mcpServer', 'one']).enabledByDefault, true);
  assert.ok(
    urls.every((url) => url === 'https://example.com/ds/lody/w1:wf:workspace'),
  );
  fail = true;
  const [latest] = settingsRows('mcp', remote);
  await assert.rejects(
    remoteSettings(
      {
        ...request,
        edit: { item: latest, name: 'Failed', enabledByDefault: false },
      },
      'owner',
      grant,
      AbortSignal.timeout(5000),
    ),
    /setting_write_unknown/,
  );
  assert.equal(remote.get(['mcpServer', 'one']).name, 'Docs');
  assert.equal(writes, 2, 'a failed write must not be replayed');
  assert.equal(item.enabledByDefault, false);
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
