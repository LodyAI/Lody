import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { test } from 'node:test';
import { build } from 'esbuild';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

const bundle = await build({
  stdin: {
    contents:
      "export * from './files'; export * from './machine-rpc'; export * from './mentions'; export * from './roost-history'; export * from './upstream-roost-history'; export * from './handlers/sharing'; export { createAcceptedSessionInputs, createSessionInputStorage, buildPendingUserHistoryEntry } from './upstream-roost.js';",
    resolveDir: new URL(
      '../../../../packages/cloud-runtime/src/runtime/',
      import.meta.url,
    ).pathname,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  plugins: [
    {
      name: 'sharing-fixture',
      setup(b) {
        b.onResolve({ filter: /^\.\.\/sharing\/runtime\.ts$/ }, () => ({
          path: 'sharing',
          namespace: 'sharing-fixture',
        }));
        b.onLoad({ filter: /.*/, namespace: 'sharing-fixture' }, () => ({
          contents: `
          export const createSharingRuntime = deps => async args => ({ history: await deps.history(args.sessionId, AbortSignal.timeout(1000)) });
        `,
        }));
      },
    },
    {
      name: 'streams',
      setup(b) {
        b.onResolve({ filter: /^@loro-dev\/streams-client$/ }, () => ({
          path: 'mock',
          namespace: 'test',
        }));
        b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
          contents:
            'export class StreamsClient { constructor(args) { return new globalThis.__projectClient(args); } }',
        }));
      },
    },
  ],
});
const runtime = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);
const ctx = () => ({
  ownerSessionId: 's1',
  workspaceId: 'w',
  machineId: 'm',
  getGrant: async () => ({
    token: 'synthetic',
    gatewayBaseUrl: 'https://example.invalid',
  }),
  signal: AbortSignal.timeout(1000),
});

// Replies are produced by a fake machine that unseals the request with the
// same owner-session key and seals its answer back, like machine-rpc-server.
function machine(handler) {
  const calls = [];
  let pending;
  globalThis.__projectClient = class {
    async create() {
      return { ok: true };
    }
    async append({ part }) {
      const envelope = JSON.parse(part.body);
      const params = runtime.isEnvelope(envelope.params)
        ? await runtime.openPayload(envelope.params)
        : envelope.params;
      calls.push({ method: envelope.method, params, id: envelope.id });
      const reply = await handler(envelope.method, params, envelope);
      pending = {
        id: envelope.id,
        ...(reply.error
          ? { error: reply.error }
          : {
              result: runtime.isEnvelope(envelope.params)
                ? await runtime.sealPayload(
                    envelope.params.ownerSessionId,
                    reply.result,
                  )
                : reply.result,
            }),
      };
      return { ok: true };
    }
    async readOnce() {
      return {
        ok: true,
        result: {
          nextOffset: '1',
          payload: {
            body: new TextEncoder().encode(JSON.stringify([pending])),
          },
        },
      };
    }
  };
  return calls;
}

test('sealed payloads round-trip and reject a foreign key id', async () => {
  const sealed = await runtime.sealPayload('s1', { hello: 'world' });
  assert.equal(sealed.type, 'code-collab-v2-content-envelope');
  assert.equal(sealed.keyId, await runtime.contentKeyId('s1'));
  assert.deepEqual(await runtime.openPayload(sealed), { hello: 'world' });
  await assert.rejects(
    runtime.openPayload({ ...sealed, ownerSessionId: 's2' }),
    /envelope_key_mismatch/,
  );
});

test('Roost history uses encrypted owner RPC for reads, watches and writes', async () => {
  const calls = machine(async (method, params) => ({
    result: {
      type:
        method === 'session/history-write'
          ? 'session/history-write_response'
          : 'session/history-read_response',
      sessionId: params.sessionId,
      success: true,
      ...(params.operation ? { operation: params.operation } : {}),
      result: { accepted: true },
    },
  }));
  const history = runtime.createRoostHistoryTransport({
    ...ctx(),
    sessionId: 's1',
  });
  await history.read({
    kind: 'readLatestPage',
    limit: 40,
    withCheckpoint: true,
  });
  await history.read({
    kind: 'watchChanges',
    checkpoint: 'c1',
    waitMs: 15000,
    includeBodiesFrom: 0,
  });
  await history.write('accept_input_and_dispatch', { entry: { id: 'turn' } });
  assert.deepEqual(
    calls.map((call) => call.method),
    ['session/history-read', 'session/history-watch', 'session/history-write'],
  );
  assert.deepEqual(calls[2].params, {
    sessionId: 's1',
    operation: 'accept_input_and_dispatch',
    payload: { entry: { id: 'turn' } },
  });
});

test('Roost history rejects a foreign session response and does not replay writes', async () => {
  const calls = machine(async () => ({
    result: {
      type: 'session/history-write_response',
      sessionId: 'another-session',
      operation: 'accept_input',
      success: true,
    },
  }));
  const history = runtime.createRoostHistoryTransport({
    ...ctx(),
    sessionId: 's1',
  });
  await assert.rejects(
    history.write('accept_input', { entry: { id: 'turn' } }),
    /invalid_history_response/,
  );
  assert.equal(calls.length, 1);
});

test('Roost history never retries a write after a transport failure', async () => {
  const calls = machine(async () => {
    throw new Error('lost_ack');
  });
  const history = runtime.createRoostHistoryTransport({
    ...ctx(),
    sessionId: 's1',
  });
  await assert.rejects(
    history.write('accept_input', { entry: { id: 'turn' } }),
    /lost_ack/,
  );
  assert.equal(calls.length, 1);
});

test('Roost history rejects an encrypted response for another owner', async () => {
  let pending;
  globalThis.__projectClient = class {
    async create() {
      return { ok: true };
    }
    async append({ part }) {
      const request = JSON.parse(part.body);
      pending = {
        id: request.id,
        result: await runtime.sealPayload('s2', {
          type: 'session/history-read_response',
          sessionId: 's1',
          success: true,
        }),
      };
      return { ok: true };
    }
    async readOnce() {
      return {
        ok: true,
        result: {
          nextOffset: '1',
          payload: {
            body: new TextEncoder().encode(JSON.stringify([pending])),
          },
        },
      };
    }
  };
  const history = runtime.createRoostHistoryTransport({
    ...ctx(),
    sessionId: 's1',
  });
  await assert.rejects(
    history.read({ kind: 'readAll' }),
    /invalid_history_envelope/,
  );
});

test('Roost history rejects a reply after the workspace lease changes', async () => {
  let current = true;
  machine(async () => {
    current = false;
    return {
      result: {
        type: 'session/history-read_response',
        sessionId: 's1',
        success: true,
        result: [],
      },
    };
  });
  const history = runtime.createRoostHistoryTransport({
    ...ctx(),
    sessionId: 's1',
    isCurrent: () => current,
  });
  await assert.rejects(history.read({ kind: 'readAll' }), /workspace_changed/);
});

test('sharing a Roost session reads an authoritative owner snapshot', async () => {
  const history = [
    { id: 'turn', role: 'user', timestamp: '2026-01-01', items: [] },
  ];
  const calls = machine(async (_method, params) => ({
    result: {
      type: 'session/history-read_response',
      sessionId: params.sessionId,
      success: true,
      historyRevision: 1,
      historyCount: history.length,
      result: history,
    },
  }));
  const handlers = new Map();
  const flock = {
    get: (key) =>
      key[0] === 'e' ? true : { machineId: 'm', historyBackend: 'roost' },
    scan: () => [],
  };
  runtime.registerSharing({
    state: {
      workspace: 'w',
      unhealthy: new Set(),
      metaReplica: { flock },
      catalogs: new Map(),
    },
    channel: { handle: (name, fn) => handlers.set(name, fn), emit() {} },
    getGrant: ctx().getGrant,
  });
  const result = await handlers.get('sessionSharing')({
    workspaceId: 'w',
    sessionId: 's1',
  });
  assert.deepEqual(result.history, history);
  assert.equal(calls[0].method, 'session/history-read');
  assert.equal(calls[0].params.query.kind, 'readAll');
});

test('upstream Roost reader rejects page bodies that do not match the directory', async () => {
  globalThis.indexedDB = new IDBFactory();
  globalThis.IDBKeyRange = IDBKeyRange;
  const controller = new AbortController();
  machine(async () => ({
    result: {
      type: 'session/history-read_response',
      sessionId: 's1',
      success: true,
      historyRevision: 1,
      historyCount: 1,
      result: {
        checkpoint: 'c1',
        startPosition: 0,
        totalCount: 1,
        rows: [{ position: 0, state: 'ready', turnId: 'one' }],
        hasMoreOlder: false,
        cursor: null,
      },
      pageTurns: [{ id: 'other', role: 'user', timestamp: '2026-01-01' }],
    },
  }));
  const options = { ...ctx(), sessionId: 's1', signal: controller.signal };
  const reader = await runtime.createUpstreamRoostHistory({
    ...options,
    getGrant: options.getGrant,
  });
  try {
    await assert.rejects(reader.latest(), /disagree/);
  } finally {
    controller.abort();
  }
});

test('upstream Roost reader rejects older pages from a different checkpoint', async () => {
  globalThis.indexedDB = new IDBFactory();
  globalThis.IDBKeyRange = IDBKeyRange;
  const controller = new AbortController();
  machine(async (_method, params) => {
    const latest = params.query.kind === 'readLatestPage';
    const id = latest ? 'new' : 'old';
    const position = latest ? 1 : 0;
    return {
      result: {
        type: 'session/history-read_response',
        sessionId: 's1',
        success: true,
        historyRevision: 1,
        historyCount: 2,
        result: {
          checkpoint: latest ? 'c1' : 'c2',
          startPosition: position,
          totalCount: 2,
          rows: [{ position, state: 'ready', turnId: id }],
          hasMoreOlder: latest,
          cursor: latest ? 'older' : null,
        },
        pageTurns: [{ id, role: 'user', timestamp: '2026-01-01' }],
      },
    };
  });
  const options = { ...ctx(), sessionId: 's1', signal: controller.signal };
  const reader = await runtime.createUpstreamRoostHistory({
    ...options,
    getGrant: options.getGrant,
  });
  try {
    const latest = await reader.latest();
    await assert.rejects(
      reader.older(latest),
      /history_observation_superseded/,
    );
  } finally {
    controller.abort();
  }
});

test(
  'upstream Roost cache restores the observed page and resumes at its checkpoint within the same account',
  { timeout: 5000 },
  async () => {
    globalThis.indexedDB = new IDBFactory();
    globalThis.IDBKeyRange = IDBKeyRange;
    const firstController = new AbortController();
    const secondController = new AbortController();
    const foreignController = new AbortController();
    let watchStarted;
    const watching = new Promise((resolve) => {
      watchStarted = resolve;
    });
    let online = true;
    const calls = [];
    machine(async (method, { query }) => {
      assert.notEqual(method, 'session/history-write');
      calls.push(query);
      if (query.kind === 'watchChanges') {
        watchStarted(query);
        return new Promise((_resolve, reject) =>
          secondController.signal.addEventListener(
            'abort',
            () => reject(new Error('cancelled')),
            { once: true },
          ),
        );
      }
      if (!online) throw new Error('owner_offline');
      return {
        result: {
          type: 'session/history-read_response',
          sessionId: 's1',
          success: true,
          historyRevision: 1,
          historyCount: 1,
          result: {
            checkpoint: 'c1',
            startPosition: 0,
            totalCount: 1,
            rows: [{ position: 0, state: 'ready', turnId: 'turn' }],
            hasMoreOlder: false,
            cursor: null,
          },
          pageTurns: [
            {
              id: 'turn',
              role: 'user',
              timestamp: '2026-01-01',
              items: [{ type: 'text', text: 'cached' }],
            },
          ],
        },
      };
    });
    const options = {
      accountId: 'account-a',
      workspaceId: 'w',
      machineId: 'm',
      sessionId: 's1',
      getGrant: ctx().getGrant,
      incremental: true,
      watch: true,
    };
    try {
      const first = await runtime.createUpstreamRoostHistory({
        ...options,
        signal: firstController.signal,
      });
      assert.equal((await first.latest()).turns[0].items[0].text, 'cached');
      firstController.abort();
      online = false;
      const second = await runtime.createUpstreamRoostHistory({
        ...options,
        signal: secondController.signal,
      });
      assert.equal((await second.latest()).turns[0].items[0].text, 'cached');
      assert.equal((await watching).checkpoint, 'c1');
      const foreign = await runtime.createUpstreamRoostHistory({
        ...options,
        accountId: 'account-b',
        signal: foreignController.signal,
      });
      await assert.rejects(foreign.latest(), /owner_offline/);
      assert.equal(
        calls.some(
          (query) => query.kind === 'watchChanges' && query.checkpoint === 'c1',
        ),
        true,
      );
    } finally {
      firstController.abort();
      secondController.abort();
      foreignController.abort();
    }
  },
);

test('turnDiff decodes the requested historical gzip snapshots', async () => {
  const gz = (text) => ({
    encoding: 'gzip-base64',
    data: gzipSync(Buffer.from(text)).toString('base64'),
    rawBytes: text.length,
  });
  const calls = machine(async (method, params) => {
    assert.equal(method, 'code-collab/open-turn-diff');
    return {
      result: {
        status: 'ok',
        path: params.path,
        turnId: params.turnId,
        oldSnapshot: { kind: 'text', text: gz('old\n') },
        newSnapshot: {
          kind: 'text',
          text: { encoding: 'plain', text: 'new\n', rawBytes: 4 },
        },
        add: 1,
        del: 1,
      },
    };
  });
  const turn = await runtime.turnDiff(ctx(), {
    sessionId: 's1',
    entryId: 'e1',
    path: 'a.ts',
  });
  assert.deepEqual(turn, {
    status: 'ok',
    base: 'turn',
    path: 'a.ts',
    old: { kind: 'text', text: 'old\n' },
    new: { kind: 'text', text: 'new\n' },
    add: 1,
    del: 1,
  });
  assert.equal(calls[0].params.turnId, 'e1');
  assert.equal(calls[0].params.sessionId, 's1');
});

test('unavailable turns stay historical even when the current diff is readable', async () => {
  const snapshot = (text) => ({
    kind: 'text',
    text: { encoding: 'plain', text, rawBytes: text.length },
  });
  for (const reason of ['turn_unavailable', 'not_changed', 'transient_io']) {
    machine(async (method, params) => ({
      result:
        method === 'code-collab/open-turn-diff'
          ? {
              status: 'unavailable',
              path: params.path,
              reason,
              message: 'Historical contents are unavailable',
            }
          : {
              status: 'ok',
              path: params.path,
              oldSnapshot: snapshot('value = 0\n'),
              newSnapshot: snapshot('value = 2\n'),
            },
    }));
    for (const entryId of ['e1', 'e2']) {
      assert.deepEqual(
        await runtime.turnDiff(ctx(), {
          sessionId: 's1',
          entryId,
          path: 'a.ts',
        }),
        {
          status: 'unavailable',
          base: 'turn',
          path: 'a.ts',
          reason,
          message: 'Historical contents are unavailable',
        },
      );
    }
    const current = await runtime.fileDiff(ctx(), {
      sessionId: 's1',
      path: 'a.ts',
    });
    assert.equal(current.base, 'current');
    assert.deepEqual(current.old, { kind: 'text', text: 'value = 0\n' });
    assert.deepEqual(current.new, { kind: 'text', text: 'value = 2\n' });
  }
});

test('explicit current diffs retain missing and oversize sides', async () => {
  machine(async () => ({
    result: {
      status: 'ok',
      path: 'b.ts',
      oldSnapshot: { kind: 'missing' },
      newSnapshot: { kind: 'too_large' },
    },
  }));
  const current = await runtime.fileDiff(ctx(), {
    sessionId: 's1',
    path: 'b.ts',
  });
  assert.equal(current.base, 'current');
  assert.deepEqual(current.old, { kind: 'missing', text: '' });
  assert.deepEqual(current.new, { kind: 'too_large' });
});

test('sealed RPC errors surface the machine code and message', async () => {
  machine(async () => ({
    error: { code: 'permission_denied', message: 'archived' },
  }));
  await assert.rejects(
    runtime.fileDiff(ctx(), { sessionId: 's1', path: 'a.ts' }),
    (error) =>
      error.message === 'archived' && error.code === 'permission_denied',
  );
});

test('readFile classifies text and binary previews and reports errors', async () => {
  machine(async (method, params) => {
    assert.equal(method, 'file/preview');
    assert.equal(params.v, 3);
    if (params.path === 'README.md')
      return {
        result: {
          status: 'ok',
          v: 3,
          path: 'README.md',
          digest: 'sha256:' + '0'.repeat(64),
          kind: 'text',
          content: { encoding: 'utf8-plain', text: '# hi\n', rawBytes: 5 },
          sizeBytes: 5,
        },
      };
    if (params.path === 'logo.png')
      return {
        result: {
          status: 'ok',
          v: 3,
          path: 'logo.png',
          digest: 'sha256:' + '0'.repeat(64),
          kind: 'binary',
          content: { encoding: 'base64', data: 'AAEC', rawBytes: 3 },
          mimeType: 'image/png',
          sizeBytes: 3,
        },
      };
    return {
      result: { status: 'error', v: 3, path: params.path, code: 'too_large' },
    };
  });
  assert.deepEqual(
    await runtime.readFile(ctx(), { sessionId: 's1', path: 'README.md' }),
    {
      status: 'ok',
      path: 'README.md',
      kind: 'text',
      text: '# hi\n',
      bytes: 5,
    },
  );
  assert.deepEqual(
    await runtime.readFile(ctx(), { sessionId: 's1', path: 'logo.png' }),
    {
      status: 'ok',
      path: 'logo.png',
      kind: 'binary',
      base64: 'AAEC',
      mimeType: 'image/png',
      bytes: 3,
    },
  );
  assert.deepEqual(
    await runtime.readFile(ctx(), { sessionId: 's1', path: 'big.bin' }),
    {
      status: 'error',
      path: 'big.bin',
      code: 'too_large',
      message: undefined,
    },
  );
});

test('listDir goes through local-project/control and sorts directories first', async () => {
  const calls = machine(async (method, params) => ({
    result: {
      ok: true,
      type: 'local-project/list-dir',
      result: {
        entries: [
          { name: 'z.ts', type: 'file' },
          { name: 'src', type: 'directory' },
          { name: 'A.md', type: 'file' },
        ],
        truncated: false,
      },
    },
  }));
  const result = await runtime.listDir(ctx(), {
    localProjectId: 'p',
    relativePath: '',
    userId: 'u1',
  });
  assert.deepEqual(
    result.entries.map((e) => e.name),
    ['src', 'A.md', 'z.ts'],
  );
  assert.equal(calls[0].method, 'local-project/control');
  assert.equal(calls[0].params.request.type, 'local-project/list-dir');
  assert.equal(calls[0].params.request.localProjectId, 'p');
  assert.equal(calls[0].params.request.requestedByUserId, 'u1');
});

test('listSessionDir lists the session folder through the owner envelope', async () => {
  const calls = machine(async () => ({
    result: {
      status: 'ok',
      v: 3,
      path: 'docs',
      entries: [
        { name: 'b.md', type: 'file' },
        { name: 'guides', type: 'directory' },
      ],
      truncated: true,
    },
  }));
  const result = await runtime.listSessionDir(ctx(), {
    sessionId: 'child',
    relativePath: 'docs',
  });
  assert.deepEqual(result, {
    entries: [
      { name: 'guides', type: 'directory' },
      { name: 'b.md', type: 'file' },
    ],
    truncated: true,
  });
  assert.equal(calls[0].method, 'file/list-dir');
  assert.deepEqual(calls[0].params, {
    v: 3,
    sessionId: 'child',
    path: 'docs',
    limit: 2000,
  });
});

test('listSessionDir yields to the project listing only when the machine cannot list', async () => {
  machine(async () => ({
    result: { status: 'error', v: 3, code: 'unsupported_protocol' },
  }));
  assert.equal(
    await runtime.listSessionDir(ctx(), { sessionId: 's1', relativePath: '' }),
    null,
  );
  machine(async () => ({
    result: { status: 'error', v: 3, code: 'path_not_allowed' },
  }));
  await assert.rejects(
    runtime.listSessionDir(ctx(), { sessionId: 's1', relativePath: 'escape' }),
    /path_not_allowed/,
  );
});

test('real file mentions use the owning project RPC, preserve spaces, and reject escaped paths', async () => {
  const calls = machine(async (_method, params) => ({
    result: {
      ok: true,
      type: params.request.type,
      result: {
        paths: [
          'src/auth/session.ts',
          'docs/My Notes.md',
          '../secret',
          '/outside',
          'bad\\path',
        ],
        truncated: false,
      },
    },
  }));
  const result = await runtime.mentionCatalog(
    { ...ctx(), localProjectId: 'p' },
    'file',
    'owner',
  );
  assert.equal(calls[0].method, 'local-project/control');
  assert.equal(calls[0].params.request.type, 'local-project/list-files');
  assert.equal(calls[0].params.request.localProjectId, 'p');
  assert.equal(calls[0].params.request.requestedByUserId, 'owner');
  assert.equal(
    result.items.find((item) => item.path === 'docs/My Notes.md').insertText,
    '@"docs/My Notes.md"',
  );
  assert(
    result.items.some(
      (item) => item.path === 'src/auth' && item.kind === 'directory',
    ),
  );
  assert(
    !result.items.some(
      (item) => item.path.includes('secret') || item.path === '/outside',
    ),
  );
  assert(result.incomplete);
});

test('skills retain the machine path behind a short token and report incomplete results', () => {
  const result = runtime.skillMentions([
    {
      groups: [
        {
          dir: '~/.agents/skills',
          scope: 'global',
          truncated: true,
          skills: [
            {
              name: 'auth-review',
              absolutePath: '/Users/test/My Skills/auth/SKILL.md',
              relativePath: '.agents/skills/auth/SKILL.md',
              description: 'Review auth',
            },
          ],
        },
        { dir: '.claude/skills', skills: [], error: 'offline' },
      ],
    },
  ]);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].insertText, '$auth-review');
  assert(result.truncated && result.incomplete);
  assert.throws(
    () => runtime.skillMentions([{ groups: [{}] }]),
    /invalid_skill_group/,
  );
  assert.throws(
    () => runtime.fileMentions({ paths: null }),
    /invalid_file_list/,
  );
});

test('child file and diff requests use the workspace owner envelope but keep the child as the business session', async () => {
  const calls = machine(async (method, params, request) => {
    assert.equal(request.params.ownerSessionId, 'parent');
    assert.equal(params.sessionId, 'child');
    if (method === 'file/preview') {
      return {
        result: {
          status: 'ok',
          path: params.path,
          kind: 'text',
          content: {
            encoding: 'utf8-plain',
            text: '# child file',
            rawBytes: 12,
          },
          sizeBytes: 12,
        },
      };
    }
    if (method === 'code-collab/open-turn-diff') {
      return {
        result: {
          status: 'unavailable',
          path: params.path,
          reason: 'turn_unavailable',
        },
      };
    }
    return {
      result: {
        status: 'ok',
        path: params.path,
        oldSnapshot: { kind: 'missing' },
        newSnapshot: {
          kind: 'text',
          text: { encoding: 'plain', text: 'changed', rawBytes: 7 },
        },
      },
    };
  });
  const context = { ...ctx(), ownerSessionId: 'parent' };
  assert.equal(
    (await runtime.readFile(context, { sessionId: 'child', path: 'README.md' }))
      .text,
    '# child file',
  );
  assert.equal(
    (await runtime.fileDiff(context, { sessionId: 'child', path: 'README.md' }))
      .new.text,
    'changed',
  );
  assert.deepEqual(
    await runtime.turnDiff(context, {
      sessionId: 'child',
      entryId: 'turn',
      path: 'README.md',
    }),
    {
      status: 'unavailable',
      base: 'turn',
      path: 'README.md',
      reason: 'turn_unavailable',
      message: undefined,
    },
  );
  assert.deepEqual(calls.at(-1).params, {
    sessionId: 'child',
    turnId: 'turn',
    path: 'README.md',
  });
});

test('workspace changes use the session worktree and owner key, retaining deferred and binary files without projecting file bodies into UI state', async () => {
  const text = {
    kind: 'text',
    text: { encoding: 'plain', text: 'private body', rawBytes: 12 },
  };
  const calls = machine((method, params, envelope) => {
    assert.equal(method, 'code-collab/open-all-changes-diff');
    assert.equal(envelope.params.ownerSessionId, 'parent');
    assert.deepEqual(params, { sessionId: 'child' });
    return {
      result: {
        status: 'ok',
        base: 'abc123',
        truncated: true,
        entries: [
          {
            status: 'ok',
            path: 'new.ts',
            oldSnapshot: { kind: 'missing' },
            newSnapshot: text,
            add: 1,
            del: 0,
          },
          {
            status: 'ok',
            path: 'removed.ts',
            oldSnapshot: text,
            newSnapshot: { kind: 'missing' },
            add: 0,
            del: 1,
          },
          {
            status: 'ok',
            path: 'image.png',
            oldSnapshot: { kind: 'binary' },
            newSnapshot: { kind: 'binary' },
          },
          { status: 'deferred', path: 'large.ts', add: 200, del: 10 },
          {
            status: 'unavailable',
            path: 'unchanged.ts',
            reason: 'not_changed',
          },
        ],
      },
    };
  });
  const result = await runtime.workspaceChanges(
    { ...ctx(), ownerSessionId: 'parent' },
    { sessionId: 'child' },
  );
  assert.equal(result.base, 'abc123');
  assert.deepEqual(
    result.files.map((file) => file.path),
    ['image.png', 'large.ts', 'new.ts', 'removed.ts'],
  );
  assert.equal(result.files[1].add, 200);
  assert.equal(result.files[2].kind, 'added');
  assert.equal(result.files[3].kind, 'deleted');
  assert.ok(!JSON.stringify(result).includes('private body'));
  assert.equal(calls.length, 1);
});

test('workspace changes distinguish unavailable, rejected and successfully empty reads', async () => {
  machine(() => ({
    result: { status: 'unavailable', reason: 'transient_io' },
  }));
  assert.equal(
    (await runtime.workspaceChanges(ctx(), { sessionId: 's1' })).status,
    'unavailable',
  );
  machine(() => ({
    error: { code: 'method_not_found', message: 'Upgrade required' },
  }));
  await assert.rejects(runtime.workspaceChanges(ctx(), { sessionId: 's1' }));
  machine(() => ({
    result: { status: 'ok', base: 'HEAD', entries: [], truncated: false },
  }));
  assert.deepEqual(await runtime.workspaceChanges(ctx(), { sessionId: 's1' }), {
    status: 'ok',
    base: 'HEAD',
    files: [],
  });
});

test('the upstream input coordinator restores immutable inputs in session order', async () => {
  const previousIndexedDB = globalThis.indexedDB,
    previousKeyRange = globalThis.IDBKeyRange;
  globalThis.indexedDB = new IDBFactory();
  globalThis.IDBKeyRange = IDBKeyRange;
  const storage = runtime.createSessionInputStorage('account', 'workspace');
  const controller = new AbortController();
  const calls = [];
  let complete;
  const finished = new Promise((resolve) => {
    complete = resolve;
  });
  const remove = storage.remove;
  storage.remove = async (id) => {
    await remove(id);
    if (id === 'second') complete();
  };
  const send = (id) => ({
    id,
    sessionId: 'session',
    workspaceId: 'workspace',
    targetMachineId: 'machine',
    historyBackend: 'roost',
    entry: {
      ...runtime.buildPendingUserHistoryEntry({
        userId: 'u',
        timestamp: '2026-01-01T00:00:00Z',
        inputBlocks: [{ type: 'text', text: id }],
        inputConfig: { cliType: 'builtin', agentType: 'codex' },
      }),
      id,
    },
    delivery: { kind: 'dispatch' },
    attachments: [],
  });
  const first = send('first'),
    second = send('second');
  await storage.save(first);
  await storage.patch('first', { state: 'unknown' });
  await storage.save(second);
  const owner = runtime.createAcceptedSessionInputs({
    storage,
    paused: true,
    resources: { run: (work, signal) => work(signal ?? controller.signal) },
    lock: async (_session, _signal, work) => work(),
    lookup: async (input) => {
      calls.push(['lookup', input.id, input.entry]);
      return { status: 'unobserved' };
    },
    write: async (input) => {
      calls.push(['write', input.id, input.entry]);
      return {
        status: 'accepted',
        turnId: input.id,
        active: true,
        dispatchHandled: true,
      };
    },
    deliver: async (input) => {
      calls.push(['deliver', input.id]);
    },
    visible: async () => true,
    unknownMessage: () => 'unknown',
  });
  try {
    await owner.resume();
    await finished;
    assert.deepEqual(
      calls.map(([kind, id]) => [kind, id]),
      [
        ['lookup', 'first'],
        ['write', 'first'],
        ['deliver', 'first'],
        ['write', 'second'],
        ['deliver', 'second'],
      ],
    );
    assert.deepEqual(calls[0][2], first.entry);
    assert.deepEqual(calls[1][2], first.entry);
    assert.deepEqual(await storage.list(), []);
  } finally {
    controller.abort();
    await owner.dispose();
    globalThis.indexedDB = previousIndexedDB;
    globalThis.IDBKeyRange = previousKeyRange;
  }
});

for (const deliveryStarted of [false, true]) {
  test(`upstream restores a guide with its delivery fence ${deliveryStarted}`, async () => {
    const previousIndexedDB = globalThis.indexedDB,
      previousKeyRange = globalThis.IDBKeyRange;
    globalThis.indexedDB = new IDBFactory();
    globalThis.IDBKeyRange = IDBKeyRange;
    const storage = runtime.createSessionInputStorage('account', 'workspace');
    const controller = new AbortController();
    let complete;
    const finished = new Promise((resolve) => {
      complete = resolve;
    });
    const remove = storage.remove;
    storage.remove = async (id) => {
      await remove(id);
      complete();
    };
    const entry = {
      ...runtime.buildPendingUserHistoryEntry({
        userId: 'u',
        timestamp: '2026-01-01T00:00:00Z',
        inputBlocks: [{ type: 'text', text: 'guide' }],
        status: 'pending_apply',
        inputConfig: { cliType: 'builtin', agentType: 'codex' },
      }),
      id: 'guide',
    };
    await storage.save({
      id: 'guide',
      sessionId: 'session',
      workspaceId: 'workspace',
      targetMachineId: 'machine',
      historyBackend: 'roost',
      entry,
      delivery: { kind: 'guide', expectedTurnId: 'running' },
      attachments: [],
    });
    await storage.patch('guide', { state: 'confirmed', deliveryStarted });
    let delivered = 0;
    const owner = runtime.createAcceptedSessionInputs({
      storage,
      paused: true,
      resources: { run: (work, signal) => work(signal ?? controller.signal) },
      lock: async (_session, _signal, work) => work(),
      lookup: async (input) => ({
        status: 'accepted',
        turnId: input.id,
        active: true,
      }),
      write: async () => {
        throw new Error('unexpected_write');
      },
      deliver: async () => {
        delivered += 1;
      },
      visible: async () => true,
      unknownMessage: () => 'unknown',
    });
    try {
      await owner.resume();
      await finished;
      assert.equal(delivered, deliveryStarted ? 0 : 1);
      assert.deepEqual(await storage.list(), []);
    } finally {
      controller.abort();
      await owner.dispose();
      globalThis.indexedDB = previousIndexedDB;
      globalThis.IDBKeyRange = previousKeyRange;
    }
  });
}
