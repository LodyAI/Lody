import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { Flock } from '@loro-dev/flock-wasm/base64';
import { openTestSession } from '../helpers.mjs';

const bundle = await build({
  stdin: {
    contents: `export {sessionMcpSelection} from './packages/cloud-runtime/src/runtime/mcp.ts';
      export {remoteSettings, settingsRows, editSetting} from './packages/cloud-runtime/src/runtime/settings.ts';`,
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
            'export class StreamsClient { constructor(args) { return new globalThis.__mcpClient(args); } }',
        }));
      },
    },
  ],
});
const { sessionMcpSelection, remoteSettings, settingsRows, editSetting } =
  await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
  );
const grant = async () => ({
  token: 'fixture',
  gatewayBaseUrl: 'https://example.invalid',
});
const signal = () => AbortSignal.timeout(5000);
const turn = {
  sessionId: 's1',
  machineId: 'm1',
  userId: 'u1',
  cliType: 'builtin',
  agentType: 'codex',
  text: 'Check MCP selection',
};

function catalog() {
  const remote = new Flock(`mcp-${crypto.randomUUID()}`);
  for (const [id, enabledByDefault] of [
    ['docs', false],
    ['search', false],
  ])
    remote.set(['mcpServer', id], {
      id,
      name: id,
      transport: 'http',
      enabledByDefault,
      createdAt: 1,
      updatedAt: 1,
      connection: {
        transport: 'http',
        url: 'https://example.invalid/mcp',
        bearerToken: 'fixture-secret',
      },
      futureField: { keep: true },
    });
  let failure,
    denied = false,
    loseAck = false,
    writes = 0;
  globalThis.__mcpClient = class {
    constructor({ url }) {
      assert.equal(
        decodeURIComponent(url),
        'https://example.invalid/ds/lody/w1:wf:workspace',
      );
    }
    async bootstrap() {
      if (failure) return { ok: false, result: { code: failure } };
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
      if (denied) return { ok: false, result: { code: 'forbidden' } };
      assert.equal(
        new DataView(part.body.buffer, part.body.byteOffset).getUint32(0),
        part.body.length - 4,
      );
      remote.importJson(
        JSON.parse(new TextDecoder().decode(part.body.subarray(4))),
      );
      if (loseAck) return { ok: false, result: { code: 'network' } };
      return { ok: true, result: {} };
    }
  };
  return {
    remote,
    fail(code) {
      failure = code;
    },
    loseAck() {
      loseAck = true;
    },
    denyWrites() {
      denied = true;
    },
    writes: () => writes,
    select: (persisted) =>
      sessionMcpSelection('w1', grant, persisted, signal()),
    read: () =>
      remoteSettings({ workspaceId: 'w1', kind: 'mcp' }, 'u1', grant, signal()),
    save: (request) =>
      remoteSettings(
        { workspaceId: 'w1', kind: 'mcp', ...request },
        'u1',
        grant,
        signal(),
      ),
  };
}

test('a saved MCP default reaches durable first-turn history and the machine RPC without credentials', async () => {
  const c = catalog(),
    calls = [];
  const f = await openTestSession({
    onRpc(request) {
      calls.push(request);
      assert.deepEqual(
        f.server.toJSON().history.at(-1).inputConfig.mcpServerIds,
        ['docs'],
      );
      return { result: { accepted: true } };
    },
  });
  try {
    const item = (await c.read()).find((item) => item.id === 'docs');
    assert.equal(JSON.stringify(item).includes('fixture-secret'), false);
    await c.save({
      edit: { item, name: 'Documentation', enabledByDefault: true },
    });
    assert.equal(
      (await f.runtime.sendTurn(turn, undefined, c.select)).state,
      'accepted',
    );
    assert.deepEqual(calls[0].params.inputConfig.mcpServerIds, ['docs']);
    console.log(
      JSON.stringify({
        observation: 'first-turn-default',
        persisted: f.server.toJSON().history.at(-1).inputConfig.mcpServerIds,
        dispatched: calls[0].params.inputConfig.mcpServerIds,
        credentialsProjected: JSON.stringify(calls).includes('fixture-secret'),
      }),
    );
    assert.equal(JSON.stringify(calls).includes('fixture-secret'), false);
    assert.equal(
      c.remote.get(['mcpServer', 'docs']).connection.bearerToken,
      'fixture-secret',
    );
    assert.deepEqual(c.remote.get(['mcpServer', 'docs']).futureField, {
      keep: true,
    });
    const latest = (await c.read()).find((item) => item.id === 'docs');
    await c.save({
      edit: { item: latest, name: 'Documentation', enabledByDefault: false },
    });
    f.server.getList('history').get(0).set('status', 'handled');
    f.server.commit();
    await f.pushUpdate();
    assert.equal(
      (await f.runtime.sendTurn(turn, undefined, c.select)).state,
      'accepted',
    );
    assert.deepEqual(
      calls[1].params.inputConfig.mcpServerIds,
      ['docs'],
      'An existing session keeps its selection after the workspace default changes',
    );
  } finally {
    f.close();
  }
});

test('queued turns keep their first selection and an explicit empty selection never adopts new defaults', async () => {
  const c = catalog();
  c.remote.set(['mcpServer', 'docs'], {
    ...c.remote.get(['mcpServer', 'docs']),
    enabledByDefault: true,
  });
  const f = await openTestSession();
  try {
    assert.equal(
      (await f.runtime.sendTurn({ ...turn, queue: true }, undefined, c.select))
        .state,
      'queued',
    );
    c.remote.set(['mcpServer', 'docs'], {
      ...c.remote.get(['mcpServer', 'docs']),
      enabledByDefault: false,
    });
    c.remote.set(['mcpServer', 'search'], {
      ...c.remote.get(['mcpServer', 'search']),
      enabledByDefault: true,
    });
    assert.equal(
      (await f.runtime.sendTurn({ ...turn, queue: true }, undefined, c.select))
        .state,
      'queued',
    );
    assert.deepEqual(
      f.server.toJSON().mq.map((item) => item.acpSessionConfig.mcpServerIds),
      [['docs'], ['docs']],
    );
    console.log(
      JSON.stringify({
        observation: 'queue-retains-selection-after-default-change',
        persisted: f.server
          .toJSON()
          .mq.map((item) => item.acpSessionConfig.mcpServerIds),
      }),
    );
    assert.deepEqual(await c.select([]), []);
  } finally {
    f.close();
  }
});

test('deletion checks the displayed revision and filters removed IDs from subsequent dispatch', async () => {
  const c = catalog();
  const item = (await c.read()).find((item) => item.id === 'docs');
  c.remote.set(['mcpServer', 'docs'], {
    ...c.remote.get(['mcpServer', 'docs']),
    updatedAt: 2,
  });
  await assert.rejects(c.save({ remove: item }), /setting_conflict/);
  assert.equal(c.writes(), 0);
  const latest = (await c.read()).find((item) => item.id === 'docs');
  await c.save({ remove: latest });
  assert.equal(c.remote.get(['mcpServer', 'docs']), undefined);
  assert.deepEqual(await c.select(['docs', 'search', 'search']), ['search']);
  assert.equal(
    c.remote.get(['mcpServer', 'search']).connection.bearerToken,
    'fixture-secret',
  );
  assert.equal(
    (await c.read()).some((item) => item.id === 'docs'),
    false,
  );
});

test('catalog failure or a missing connection stops sending before any history, queue or RPC write', async () => {
  const c = catalog(),
    f = await openTestSession();
  try {
    c.fail('forbidden');
    for (const queue of [false, true]) {
      assert.equal(
        (await f.runtime.sendTurn({ ...turn, queue }, undefined, c.select))
          .reason,
        'mcp_catalog_unavailable',
      );
      assert.equal(f.server.toJSON().history?.length ?? 0, 0);
      assert.equal(f.server.toJSON().mq?.length ?? 0, 0);
      assert.deepEqual(f.appends, []);
    }
    c.fail('not_found');
    assert.deepEqual(await c.select(undefined), []);
    c.fail(undefined);
    c.remote.set(['mcpServer', 'docs'], {
      ...c.remote.get(['mcpServer', 'docs']),
      connection: undefined,
      enabledByDefault: true,
    });
    assert.equal(
      (await f.runtime.sendTurn(turn, undefined, c.select)).reason,
      'mcp_connection_missing',
    );
    assert.deepEqual(f.appends, []);
    const item = settingsRows('mcp', c.remote).find(
      (item) => item.id === 'docs',
    );
    assert.throws(
      () =>
        editSetting(c.remote, {
          kind: 'mcp',
          edit: { item, name: 'docs', enabledByDefault: true },
        }),
      /mcp_connection_missing/,
    );
  } finally {
    f.close();
  }
});

test('persisted empty and deleted selections reach the machine without adopting another default', async () => {
  const c = catalog();
  c.remote.set(['mcpServer', 'search'], {
    ...c.remote.get(['mcpServer', 'search']),
    enabledByDefault: true,
  });
  c.remote.delete(['mcpServer', 'docs']);
  for (const mcpServerIds of [[], ['docs']]) {
    let payload;
    const f = await openTestSession({
      onRpc(request) {
        payload = request.params.inputConfig;
        return { result: { accepted: true } };
      },
    });
    try {
      f.server.getList('history').push({
        id: 'previous',
        role: 'user',
        status: 'handled',
        inputConfig: {
          cliType: turn.cliType,
          agentType: turn.agentType,
          mcpServerIds,
          agentRoleId: 'role-fixture',
          agentRoleRevision: 1,
        },
        items: [],
      });
      f.server.commit();
      await f.pushUpdate();
      assert.equal(
        (await f.runtime.sendTurn(turn, undefined, c.select)).state,
        'accepted',
      );
      assert.deepEqual(payload.mcpServerIds, []);
      assert.equal(
        payload.agentRoleId,
        mcpServerIds.length ? null : 'role-fixture',
      );
      console.log(
        JSON.stringify({
          observation: 'existing-selection-after-default-change-or-deletion',
          previous: mcpServerIds,
          dispatched: payload.mcpServerIds,
        }),
      );
      assert.deepEqual(
        f.server.toJSON().history.at(-1).inputConfig.mcpServerIds,
        [],
      );
    } finally {
      f.close();
    }
  }
});

test('replacing the session during MCP lookup cannot write a late turn', async () => {
  const f = await openTestSession();
  let resume, entered;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  const pending = f.runtime.sendTurn(turn, undefined, () => {
    entered();
    return new Promise((resolve) => {
      resume = resolve;
    });
  });
  await waiting;
  f.runtime.stopSessions();
  resume(['docs']);
  try {
    assert.equal((await pending).state, 'not_sent');
    assert.deepEqual(f.appends, []);
    assert.equal(f.server.toJSON().history?.length ?? 0, 0);
  } finally {
    f.close();
  }
});

test('a lost deletion ACK is uncertain, never replayed, and a refresh reads the persisted deletion', async () => {
  const c = catalog();
  const item = (await c.read()).find((item) => item.id === 'docs');
  c.loseAck();
  await assert.rejects(c.save({ remove: item }), /setting_write_unknown/);
  assert.equal(c.writes(), 1);
  assert.equal(
    (await c.read()).some((row) => row.id === 'docs'),
    false,
  );
  await assert.rejects(c.save({ remove: item }), /setting_not_found/);
  assert.equal(c.writes(), 1);
});

test('daemon environment references remain valid configured connections without exposing values', async () => {
  const c = catalog();
  c.remote.set(['mcpServer', 'docs'], {
    ...c.remote.get(['mcpServer', 'docs']),
    connection: { transport: 'http', url: '${MCP_URL}' },
    enabledByDefault: true,
  });
  assert.deepEqual(await c.select(undefined), ['docs']);
  const item = (await c.read()).find((item) => item.id === 'docs');
  assert.equal(item.configured, true);
  assert.equal(JSON.stringify(item).includes('MCP_URL'), false);
});

test('a denied workspace write is read-only and does not delete or replay', async () => {
  const c = catalog();
  const item = (await c.read()).find((item) => item.id === 'docs');
  c.denyWrites();
  await assert.rejects(c.save({ remove: item }), /setting_read_only/);
  assert.equal(c.writes(), 1);
  assert.equal(
    (await c.read()).some((row) => row.id === 'docs'),
    true,
  );
});
