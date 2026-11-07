import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { Flock } from '@loro-dev/flock-wasm/base64';

const bundle = await build({
  entryPoints: ['packages/cloud-runtime/src/runtime/memory-settings.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  plugins: [
    {
      name: 'streams',
      setup(b) {
        b.onResolve({ filter: /^@loro-dev\/streams-client$/ }, () => ({
          path: 'streams',
          namespace: 'test',
        }));
        b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
          contents:
            'export class StreamsClient { constructor(args) { return new globalThis.__memoryClient(args); } }',
        }));
      },
    },
  ],
});
const { memorySettings } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);
function fixture() {
  const remote = new Flock('memory'),
    meta = new Flock('meta');
  for (const [id, owner] of [
    ['m1', 'me'],
    ['m2', 'other'],
  ]) {
    meta.set(['e', `machine-${id}`], true);
    meta.set(['m', `machine-${id}`], {
      ownerUserId: owner,
      name: id,
      protocolCapabilities: { memoryProviders: 1 },
    });
  }
  meta.commit();
  const entry = {
    machineId: 'm1',
    providerId: 'nowledge-mem',
    memoryId: 'review',
    name: 'Reviewer',
    description: 'Customized name',
  };
  const put = (value = entry) => {
    remote.set(['memory', value.providerId, value.memoryId], value);
    remote.commit();
  };
  put();
  let inventory = {
    type: 'machine/memory',
    status: 'ready',
    memories: [
      { id: 'review', name: 'Provider name', content: 'MUST NOT LEAK' },
      { id: 'new', name: 'Reviewer', description: 'Imported' },
    ],
  };
  let mode = '',
    calls = [],
    presence = { state: 'live', onlineMachineIds: ['m1'] },
    message,
    hook;
  globalThis.__memoryClient = class {
    constructor({ url }) {
      this.url = decodeURIComponent(url);
    }
    async bootstrap() {
      hook?.();
      if (mode === 'missing')
        return { ok: false, result: { code: 'not_found' } };
      if (mode === 'denied')
        return { ok: false, result: { code: 'forbidden' } };
      if (mode === 'offline') throw new Error('network');
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
    async create() {
      if (this.url.includes(':mf:')) {
        calls.push({ create: this.url });
        mode = '';
      }
      return { ok: true };
    }
    async append({ part }) {
      if (this.url.includes(':rpc:req:')) {
        message = JSON.parse(part.body);
        calls.push(message);
        return { ok: true };
      }
      assert.equal(
        new DataView(part.body.buffer, part.body.byteOffset).getUint32(0),
        part.body.length - 4,
      );
      calls.push({ write: this.url });
      if (mode === 'write-denied')
        return { ok: false, result: { code: 'forbidden' } };
      remote.importJson(
        JSON.parse(new TextDecoder().decode(part.body.subarray(4))),
      );
      if (mode === 'lost') throw new Error('lost ACK');
      return { ok: true };
    }
    async readOnce() {
      return {
        ok: true,
        result: {
          nextOffset: '1',
          payload: {
            body: new TextEncoder().encode(
              JSON.stringify({ id: message.id, result: inventory }),
            ),
          },
        },
      };
    }
  };
  const call = (request = { action: 'list' }, check = () => {}) =>
    memorySettings(
      { workspaceId: 'w', ...request },
      'me',
      meta,
      new Map([['m1', remote]]),
      () => presence,
      async () => ({
        token: 'fixture',
        gatewayBaseUrl: 'https://example.invalid',
      }),
      AbortSignal.timeout(2000),
      check,
    );
  return {
    call,
    remote,
    meta,
    entry,
    put,
    calls,
    mode: (v) => (mode = v),
    inventory: (v) => (inventory = v),
    presence: (v) => (presence = v),
    hook: (v) => (hook = v),
  };
}
test('lists own machines, routes an identity-only request and strips provider extras', async () => {
  const f = fixture(),
    result = await f.call();
  assert.deepEqual(result.machines, [{ id: 'm1', name: 'm1' }]);
  assert.equal(result.status, 'ready');
  assert.equal(result.entries[0].name, 'Reviewer');
  assert.equal(JSON.stringify(result).includes('MUST NOT LEAK'), false);
  assert.equal(f.calls[0].method, 'machine/memory');
  console.log(
    JSON.stringify({
      observation: 'provider-request-and-projection',
      request: f.calls[0],
      projection: result,
    }),
  );
  assert.deepEqual(f.calls[0].params, {
    action: 'list',
    providerId: 'nowledge-mem',
  });
  await assert.rejects(
    f.call({ action: 'list', machineId: 'm2' }),
    /memory_forbidden/,
  );
});
test('offline, unknown and old daemons never receive provider RPC', async () => {
  const f = fixture();
  for (const [presence, status] of [
    [{ state: 'live', onlineMachineIds: [] }, 'offline'],
    [{ state: 'unknown', onlineMachineIds: [] }, 'unknown'],
  ]) {
    f.presence(presence);
    assert.equal((await f.call()).status, status);
  }
  f.presence({ state: 'live', onlineMachineIds: ['m1'] });
  f.meta.set(['m', 'machine-m1', 'protocolCapabilities'], {
    memoryProviders: 0,
  });
  f.meta.commit();
  assert.equal((await f.call()).status, 'unsupported');
  assert.equal(f.calls.length, 0);
});
test('provider failures retain saved associations and do not establish deletion', async () => {
  const f = fixture();
  for (const status of ['not_installed', 'not_running', 'error']) {
    f.inventory({ type: 'machine/memory', status, memories: [] });
    const result = await f.call();
    assert.equal(result.status, status);
    assert.equal(result.entries.length, 1);
    await assert.rejects(
      f.call({ action: 'import', memoryId: 'new' }),
      new RegExp('memory_' + status),
    );
  }
  assert.equal(f.calls.filter((c) => c.write).length, 0);
});
test('catalog denial never falls back to cached private metadata', async () => {
  const f = fixture();
  f.mode('denied');
  await assert.rejects(f.call(), /memory_forbidden/);
  assert.equal(f.calls.length, 0);
});
test('network failure labels cached associations and prevents writes', async () => {
  const f = fixture();
  f.mode('offline');
  const result = await f.call();
  assert.equal(result.cached, true);
  assert.equal(result.entries.length, 1);
  await assert.rejects(f.call({ action: 'remove', base: f.entry }), /network/);
  assert.equal(f.calls.filter((c) => c.write).length, 0);
});
test('import rereads authoritative inventory and deduplicates without overwriting metadata', async () => {
  const f = fixture();
  const result = await f.call({ action: 'import', memoryId: 'new' });
  assert.equal(result.entries.length, 2);
  assert.deepEqual(f.remote.get(['memory', 'nowledge-mem', 'new']), {
    machineId: 'm1',
    providerId: 'nowledge-mem',
    memoryId: 'new',
    name: 'Reviewer',
    description: 'Imported',
  });
  await f.call({ action: 'import', memoryId: 'review' });
  assert.deepEqual(f.remote.get(['memory', 'nowledge-mem', 'review']), f.entry);
  assert.equal(f.calls.filter((c) => c.write).length, 1);
  console.log(
    JSON.stringify({
      observation: 'import-stored',
      imported: f.remote.get(['memory', 'nowledge-mem', 'new']),
      existing: f.remote.get(['memory', 'nowledge-mem', 'review']),
      writes: f.calls.filter((c) => c.write),
    }),
  );
  await assert.rejects(
    f.call({ action: 'import', memoryId: 'gone' }),
    /memory_conflict/,
  );
});
test('remove deletes only the association, preserves roles and never calls a provider mutation', async () => {
  const f = fixture();
  f.remote.set(['agentRole', 'role'], {
    memory: { providerId: 'nowledge-mem', memoryId: 'review' },
  });
  f.remote.commit();
  await f.call({ action: 'remove', base: f.entry });
  assert.equal(f.remote.get(['memory', 'nowledge-mem', 'review']), undefined);
  assert.deepEqual(f.remote.get(['agentRole', 'role']), {
    memory: { providerId: 'nowledge-mem', memoryId: 'review' },
  });
  assert.deepEqual(f.calls, [
    { write: 'https://example.invalid/ds/lody/w:mf:m1' },
  ]);
  console.log(
    JSON.stringify({
      observation: 'association-removed-only',
      association: f.remote.get(['memory', 'nowledge-mem', 'review']) ?? null,
      role: f.remote.get(['agentRole', 'role']),
      calls: f.calls,
    }),
  );
});
test('stale remove, wrong machine and changed account stop before append', async () => {
  const f = fixture();
  f.put({ ...f.entry, name: 'Changed elsewhere' });
  await assert.rejects(
    f.call({ action: 'remove', base: f.entry }),
    /memory_conflict/,
  );
  await assert.rejects(
    f.call({ action: 'remove', base: { ...f.entry, machineId: 'm2' } }),
    /memory_invalid/,
  );
  let changed = false;
  f.hook(() => (changed = true));
  await assert.rejects(
    f.call({ action: 'import', memoryId: 'new' }, () => {
      if (changed) throw new Error('workspace_changed');
    }),
    /workspace_changed/,
  );
  assert.equal(f.calls.length, 0);
});
test('lost acknowledgement is uncertain and never triggers a second write', async () => {
  const f = fixture();
  f.mode('lost');
  await assert.rejects(
    f.call({ action: 'remove', base: f.entry }),
    /memory_write_unknown/,
  );
  assert.equal(f.remote.get(['memory', 'nowledge-mem', 'review']), undefined);
  assert.equal(f.calls.length, 1);
});
test('write permission failure is distinct from success or unknown delivery', async () => {
  const f = fixture();
  f.mode('write-denied');
  await assert.rejects(
    f.call({ action: 'remove', base: f.entry }),
    /memory_forbidden/,
  );
  assert.deepEqual(f.remote.get(['memory', 'nowledge-mem', 'review']), f.entry);
});

test('malformed inventory is a failed probe, retains saved rows and cannot import', async () => {
  const f = fixture();
  f.inventory({
    type: 'machine/memory',
    status: 'ready',
    memories: [{ id: 5, name: 'Bad' }],
  });
  const result = await f.call();
  assert.equal(result.status, 'error');
  assert.equal(result.entries.length, 1);
  assert.deepEqual(result.identities, []);
  await assert.rejects(
    f.call({ action: 'import', memoryId: 'new' }),
    /memory_error/,
  );
  assert.equal(f.calls.filter((c) => c.write).length, 0);
});
test('machine ownership loss during bootstrap stops reads and writes before RPC', async () => {
  const f = fixture();
  f.hook(() => {
    f.meta.set(['m', 'machine-m1', 'ownerUserId'], 'other');
    f.meta.commit();
  });
  await assert.rejects(
    f.call({ action: 'import', memoryId: 'new' }),
    /memory_forbidden/,
  );
  assert.equal(f.calls.length, 0);
});

test('unconfirmed import has one durable append, and later import preserves the stored association', async () => {
  const f = fixture();
  f.mode('lost');
  await assert.rejects(
    f.call({ action: 'import', memoryId: 'new' }),
    /memory_write_unknown/,
  );
  assert.equal(f.calls.filter((c) => c.write).length, 1);
  f.mode('');
  const next = await f.call();
  assert.equal(next.entries.length, 2);
  await f.call({ action: 'import', memoryId: 'new' });
  assert.equal(f.calls.filter((c) => c.write).length, 1);
});

test('unknown provider associations remain readable and removable without a provider RPC', async () => {
  const f = fixture();
  const future = {
    ...f.entry,
    providerId: 'future-provider',
    memoryId: 'future',
  };
  f.put(future);
  const listed = await f.call();
  assert.equal(
    listed.entries.find((e) => e.providerId === 'future-provider').memoryId,
    'future',
  );
  f.calls.length = 0;
  await f.call({ action: 'remove', base: future });
  assert.equal(
    f.remote.get(['memory', 'future-provider', 'future']),
    undefined,
  );
  assert.deepEqual(f.calls, [
    { write: 'https://example.invalid/ds/lody/w:mf:m1' },
  ]);
});

test('the first import creates a missing machine catalog only after an authoritative inventory', async () => {
  const f = fixture();
  f.remote.delete(['memory', 'nowledge-mem', 'review']);
  f.remote.commit();
  f.mode('missing');
  const initial = await f.call();
  assert.deepEqual(initial.entries, []);
  assert.equal(f.calls.filter((c) => c.create).length, 0);
  const result = await f.call({ action: 'import', memoryId: 'new' });
  assert.equal(result.entries.length, 1);
  assert.deepEqual(
    f.calls.filter((c) => c.create || c.write),
    [
      { create: 'https://example.invalid/ds/lody/w:mf:m1' },
      { write: 'https://example.invalid/ds/lody/w:mf:m1' },
    ],
  );
  assert.equal(
    f.remote.get(['memory', 'nowledge-mem', 'new']).name,
    'Reviewer',
  );
});
