import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { Flock } from '@loro-dev/flock-wasm/base64';
import { openTestSession } from '../helpers.mjs';

const bundle = await build({
  stdin: {
    contents: `export {roleSettings,roleSnapshot} from './packages/cloud-runtime/src/runtime/role-settings.ts';
export {roleMentions,workspaceRoleMentions} from './packages/cloud-runtime/src/runtime/agent-roles.ts';
export {expandMentions} from './packages/cloud-runtime/src/runtime/mention-expansion.ts';`,
    resolveDir: process.cwd(),
  },
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
            'export class StreamsClient { constructor(args) { return new globalThis.__roleClient(args); } }',
        }));
      },
    },
  ],
});
const runtime = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);
const grant = async () => ({
  token: 'fixture',
  gatewayBaseUrl: 'https://example.invalid',
});
const fields = (name = 'Reviewer') => ({
  name,
  description: 'Find regressions',
  promptPrefix: 'Review carefully.',
  visibility: 'private',
});
const row = (id, patch = {}) => ({
  v: 1,
  id,
  ownerUserId: 'me',
  ...fields(id),
  machineId: 'm1',
  agentConfigId: 'a1',
  runConfig: { modelId: 'model', configOptionValues: { safe: 'yes' } },
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});
function catalog() {
  const remote = new Flock(`role-${crypto.randomUUID()}`),
    meta = new Flock('meta');
  const machines = new Map(
    ['m1', 'm2'].map((machineId, i) => {
      const flock = new Flock(machineId);
      flock.set(['agentConfig', `a${i + 1}`], {
        id: `a${i + 1}`,
        machineId,
        name: 'Coder',
        cliType: 'builtin',
        agentType: 'codex',
        env: { TOKEN: 'fixture-secret' },
      });
      flock.commit();
      meta.set(['m', `machine-${machineId}`, 'name'], `Machine ${i + 1}`);
      return [machineId, flock];
    }),
  );
  meta.commit();
  let presence = { state: 'live', onlineMachineIds: ['m1', 'm2'] };
  let writes = 0,
    creates = 0,
    denied = false,
    lost = false,
    missing = false,
    bootstrapHook;
  globalThis.__roleClient = class {
    constructor({ url }) {
      assert.equal(
        decodeURIComponent(url),
        'https://example.invalid/ds/lody/w:wf:workspace',
      );
    }
    async bootstrap() {
      bootstrapHook?.();
      if (missing) return { ok: false, result: { code: 'not_found' } };
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
      creates++;
      missing = false;
      return { ok: true, result: {} };
    }
    async append({ part }) {
      writes++;
      if (denied) return { ok: false, result: { code: 'forbidden' } };
      assert.equal(
        new DataView(part.body.buffer, part.body.byteOffset).getUint32(0),
        part.body.length - 4,
      );
      remote.importJson(
        JSON.parse(new TextDecoder().decode(part.body.subarray(4))),
      );
      if (lost) throw new Error('lost ACK');
      return { ok: true, result: {} };
    }
  };
  const put = (id, patch = {}) => {
    remote.set(['agentRole', id], row(id, patch));
    remote.commit();
  };
  const call = (request, user = 'me', check = () => {}) =>
    runtime.roleSettings(
      { workspaceId: 'w', ...request },
      user,
      meta,
      machines,
      grant,
      AbortSignal.timeout(5000),
      check,
    );
  return {
    remote,
    meta,
    machines,
    put,
    call,
    list: (user) => call({ action: 'list' }, user),
    presence: (value) => (presence = value),
    writes: () => writes,
    creates: () => creates,
    deny: () => (denied = true),
    lose: () => (lost = true),
    missing: () => (missing = true),
    bootstrap: (fn) => (bootstrapHook = fn),
    save: (base, patch) =>
      call({
        action: 'save',
        id: base.id,
        base,
        fields: {
          name: base.name,
          description: base.description,
          promptPrefix: base.promptPrefix,
          visibility: base.visibility,
          ...patch,
        },
      }),
    mentions: () =>
      runtime.workspaceRoleMentions('w', 'me', machines, grant, () => presence),
  };
}
test('discovery filters private rows, keeps broken targets visible, and lists only safe pinned run config', async () => {
  const c = catalog();
  c.put('mine', {
    emoji: '🧪',
    runConfig: {
      modelId: 'model',
      configOptionValues: { safe: 'yes', api_key: 'fixture-secret' },
      memory: { providerId: 'p', memoryId: 'fixture-memory' },
    },
  });
  c.put('shared', { ownerUserId: 'other', visibility: 'workspace' });
  c.put('hidden', { ownerUserId: 'other' });
  c.put('broken', { agentConfigId: 'deleted' });
  c.put('future', { v: 3 });
  c.put('malformed-memory', {
    runConfig: {
      memory: { providerId: 'p', memoryId: 'm', secret: 'fixture-secret' },
    },
  });
  const snapshot = await c.list();
  assert.deepEqual(
    snapshot.roles.map((x) => x.id),
    ['broken', 'mine', 'shared'],
  );
  assert.equal(snapshot.roles[0].targets[0].state, 'agentUnavailable');
  assert.equal(JSON.stringify(snapshot).includes('fixture-secret'), false);
  // The new-chat Role row seeds the composer from what a target pins (web), so the
  // safe pinned values are listed; secret-shaped keys and memory never leave the row.
  const mine = snapshot.roles.find((role) => role.id === 'mine');
  assert.deepEqual(mine.targets[0].runConfig, { modelId: 'model', configOptionValues: { safe: 'yes' } });
  assert.equal(mine.emoji, '🧪');
  assert.equal(snapshot.roles.find((role) => role.id === 'shared').emoji, '🪼');
  assert.equal(JSON.stringify(snapshot).includes('fixture-memory'), false);
  assert.deepEqual(
    (await c.mentions()).items.map((x) => x.path),
    ['mine', 'shared'],
  );
  assert.deepEqual(
    (await c.list('other')).roles.map((x) => x.id),
    ['hidden', 'shared'],
  );
});
test('a new private role uses a verified Agent and round-trips through the official framed Flock row', async () => {
  const c = catalog();
  c.missing();
  assert.equal((await c.list()).roles.length, 0);
  assert.equal(c.creates(), 0);
  await assert.rejects(
    c.call({
      action: 'save',
      id: 'new',
      base: null,
      fields: fields(''),
      target: { machineId: 'm1', agentConfigId: 'a1' },
    }),
    /role_invalid/,
  );
  assert.equal(c.creates(), 0, 'Validation precedes stream creation');
  const result = await c.call({
    action: 'save',
    id: 'new',
    base: null,
    fields: fields(),
    target: { machineId: 'm2', agentConfigId: 'a2' },
  });
  assert.equal(c.creates(), 1);
  assert.equal(c.writes(), 1);
  assert.equal(result.roles[0].visibility, 'private');
  const saved = c.remote.get(['agentRole', 'new']);
  assert.equal(saved.v, 1);
  assert.equal(saved.ownerUserId, 'me');
  assert.equal(saved.machineId, 'm2');
  assert.deepEqual(saved.runConfig, {});
  assert.equal(saved.revision, 1);
  await assert.rejects(
    c.call({
      action: 'save',
      id: 'new',
      base: null,
      fields: fields(),
      target: { machineId: 'm2', agentConfigId: 'a2' },
    }),
    /role_conflict/,
  );
  assert.equal(c.writes(), 1, 'An uncertain create ID is never replayed');
});
test('editing shared fields preserves v2 targets, memory, future fields and frozen run config; no-op keeps revision', async () => {
  const c = catalog();
  const targets = [
    {
      machineId: 'm1',
      agentConfigId: 'a1',
      alias: 'Studio-review',
      runConfig: { modelId: 'm', memory: { providerId: 'p', memoryId: 'mem' } },
    },
    {
      machineId: 'm2',
      agentConfigId: 'a2',
      runConfig: { modeId: 'plan', configOptionValues: { reasoning: 'high' } },
    },
  ];
  c.put('multi', {
    v: 2,
    targets,
    futureField: { keep: 'yes' },
    description: '  Old guidance  ',
    promptPrefix: '  Prefix  ',
  });
  const initial = (await c.list()).roles[0];
  // Swift JSONSerialization may reorder object keys while preserving the same value.
  const base = Object.fromEntries(Object.entries(initial).reverse());
  base.targets = base.targets.map((target) =>
    Object.fromEntries(Object.entries(target).reverse()),
  );
  await c.save(base, {});
  assert.equal(c.writes(), 0);
  await c.save(base, {
    name: 'Mobile',
    description: 'New guidance',
    visibility: 'workspace',
  });
  const saved = c.remote.get(['agentRole', 'multi']);
  assert.equal(saved.v, 2);
  assert.deepEqual(saved.targets, targets);
  assert.deepEqual(saved.futureField, { keep: 'yes' });
  assert.equal(saved.revision, 2);
  assert.equal(saved.createdAt, 1);
  const mentions = await c.mentions();
  assert.deepEqual(mentions.items.map((x) => x.path).sort(), [
    'multi@m1',
    'multi@m2',
  ]);
  assert.ok(mentions.items.every((x) => x.subtitle === 'New guidance'));
  console.log(
    JSON.stringify({
      observation: 'metadata-edit',
      storedVersion: saved.v,
      revision: saved.revision,
      targetsPreserved: true,
      mentions: mentions.items.map((x) => x.insertText),
    }),
  );
});
test('only the owner can mutate; private and forged bases do not bypass discovery or write grants', async () => {
  const c = catalog();
  c.put('shared', { visibility: 'workspace', ownerUserId: 'other' });
  c.put('private', { ownerUserId: 'other' });
  const shared = (await c.list()).roles[0];
  await assert.rejects(
    c.save({ ...shared, ownerUserId: 'me' }, { name: 'Takeover' }),
    /role_read_only/,
  );
  await assert.rejects(
    c.call({ action: 'delete', base: shared }),
    /role_read_only/,
  );
  await assert.rejects(
    c.call({
      action: 'delete',
      base: { ...shared, id: 'private', ownerUserId: 'me' },
    }),
    /role_read_only/,
  );
  assert.equal(c.writes(), 0);
  c.put('owned');
  const owned = (await c.list()).roles.find((x) => x.id === 'owned');
  c.deny();
  await assert.rejects(c.save(owned, { name: 'Denied' }), /role_forbidden/);
  assert.equal(c.remote.get(['agentRole', 'owned']).name, 'owned');
  c.bootstrap(() => {
    throw new Error('forbidden');
  });
  await assert.rejects(c.list(), /role_forbidden/);
});
test('name aliases, invalid bindings, stale save/delete and workspace changes are rejected before append', async () => {
  const c = catalog();
  c.put('one', { name: 'Code Reviewer' });
  c.put('two');
  let base = (await c.list()).roles.find((x) => x.id === 'two');
  await assert.rejects(
    c.save(base, { name: 'Code-Reviewer' }),
    /role_duplicate/,
  );
  await assert.rejects(
    c.call({
      action: 'save',
      id: 'missing',
      base: null,
      fields: fields(),
      target: { machineId: 'm2', agentConfigId: 'a1' },
    }),
    /role_target_unavailable/,
  );
  c.put('two', { revision: 2, promptPrefix: 'Updated on desktop' });
  await assert.rejects(c.save(base, { name: 'Overwrite' }), /role_conflict/);
  await assert.rejects(c.call({ action: 'delete', base }), /role_conflict/);
  let switched = false;
  c.bootstrap(() => (switched = true));
  await assert.rejects(
    c.call({ action: 'list' }, 'me', () => {
      if (switched) throw new Error('workspace_changed');
    }),
    /workspace_changed/,
  );
  assert.equal(c.writes(), 0);
});
test('a lost delete ACK requires refresh and never replays a destructive write', async () => {
  const c = catalog();
  c.put('delete');
  const base = (await c.list()).roles[0];
  c.lose();
  await assert.rejects(
    c.call({ action: 'delete', base }),
    /role_write_unknown/,
  );
  assert.equal(c.writes(), 1);
  assert.equal((await c.list()).roles.length, 0);
  await assert.rejects(c.call({ action: 'delete', base }), /role_read_only/);
  assert.equal(c.writes(), 1);
  console.log(
    JSON.stringify({
      observation: 'lost-delete-ack',
      writes: c.writes(),
      readback: 'absent',
    }),
  );
});
test('fresh v2 role references reach durable history and queue with an explicit machine, never change the current turn Role', async () => {
  const c = catalog();
  c.put('multi', {
    v: 2,
    targets: [
      { machineId: 'm1', agentConfigId: 'a1' },
      { machineId: 'm2', agentConfigId: 'a2' },
    ],
  });
  const base = (await c.list()).roles[0];
  await c.save(base, { name: 'Latest', promptPrefix: 'LATEST INSTRUCTIONS' });
  const calls = [];
  const f = await openTestSession({
    onRpc(request) {
      calls.push(request);
      return { result: { accepted: true } };
    },
  });
  const args = {
    sessionId: 's1',
    machineId: 'm1',
    userId: 'u1',
    cliType: 'builtin',
    agentType: 'codex',
    text: '@role:multi@m2 Review changes',
  };
  const expand = (text) => runtime.expandMentions(text, c.mentions);
  try {
    const result = await f.runtime.sendTurn(args, expand);
    assert.equal(result.state, 'accepted');
    const prompt = calls[0].params.inputConfig.prompt;
    assert.match(prompt, /id: multi, agentRoleMachineId: m2, name: Latest/);
    assert.equal(
      prompt.includes('LATEST INSTRUCTIONS'),
      false,
      'Only IDs cross into the instruction; daemon resolves the catalog',
    );
    assert.equal(calls[0].params.inputConfig.agentRoleId, undefined);
    assert.equal(f.server.toJSON().history[0].inputConfig.prompt, prompt);
    const queued = await f.runtime.sendTurn({ ...args, queue: true }, expand);
    assert.equal(queued.state, 'queued');
    assert.equal(f.server.toJSON().mq[0].acpSessionConfig.prompt, prompt);
    const latest = (await c.list()).roles[0];
    await c.call({ action: 'delete', base: latest });
    const count = f.appends.length;
    const blocked = await f.runtime.sendTurn({ ...args, queue: true }, expand);
    assert.equal(blocked.state, 'not_sent');
    assert.equal(f.appends.length, count);
    assert.equal(calls.length, 1);
    console.log(
      JSON.stringify({
        observation: 'role-reference-delivery',
        persisted: f.server.toJSON().history[0].inputConfig.prompt,
        queued: f.server.toJSON().mq[0].acpSessionConfig.prompt,
        deletedReference: blocked.state,
      }),
    );
  } finally {
    f.runtime.closeSession();
  }
});

test('Role references are global across authorized machines and require current live presence', async () => {
  const c = catalog();
  c.put('multi', {
    v: 2,
    targets: [
      { machineId: 'm1', agentConfigId: 'a1' },
      { machineId: 'm2', agentConfigId: 'a2' },
    ],
  });
  c.presence({ state: 'live', onlineMachineIds: ['m2'] });
  assert.deepEqual(
    (await c.mentions()).items.map((item) => item.path),
    ['multi@m2'],
  );
  c.bootstrap(() => c.presence({ state: 'unknown', onlineMachineIds: [] }));
  const unavailable = await c.mentions();
  assert.equal(unavailable.incomplete, true);
  assert.deepEqual(unavailable.items, []);
  await assert.rejects(
    runtime.expandMentions('@role:multi@m2', c.mentions),
    /mention_expansion_failed/,
  );
  assert.equal(c.writes(), 0);
});
