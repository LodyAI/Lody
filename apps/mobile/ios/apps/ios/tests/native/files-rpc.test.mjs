import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { test } from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents:
      "export * from './files'; export * from './machine-rpc'; export * from './mentions';",
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

test('turnDiff decodes gzip snapshots and falls back to the current diff', async () => {
  const gz = (text) => ({
    encoding: 'gzip-base64',
    data: gzipSync(Buffer.from(text)).toString('base64'),
    rawBytes: text.length,
  });
  const calls = machine(async (method, params) => {
    if (method === 'code-collab/open-turn-diff')
      return params.path === 'a.ts'
        ? {
            result: {
              status: 'ok',
              path: 'a.ts',
              turnId: params.turnId,
              oldSnapshot: { kind: 'text', text: gz('old\n') },
              newSnapshot: {
                kind: 'text',
                text: { encoding: 'plain', text: 'new\n', rawBytes: 4 },
              },
              add: 1,
              del: 1,
            },
          }
        : {
            result: {
              status: 'unavailable',
              path: params.path,
              turnId: params.turnId,
              reason: 'turn_unavailable',
            },
          };
    return {
      result: {
        status: 'ok',
        path: params.path,
        oldSnapshot: { kind: 'missing' },
        newSnapshot: { kind: 'too_large' },
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

  const current = await runtime.turnDiff(ctx(), {
    sessionId: 's1',
    entryId: 'e1',
    path: 'b.ts',
  });
  assert.equal(current.base, 'current');
  assert.deepEqual(current.old, { kind: 'missing', text: '' });
  assert.deepEqual(current.new, { kind: 'too_large' });
  assert.deepEqual(
    calls.slice(1).map((c) => c.method),
    ['code-collab/open-turn-diff', 'code-collab/open-current-diff'],
  );
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
  assert.equal(
    (
      await runtime.turnDiff(context, {
        sessionId: 'child',
        entryId: 'turn',
        path: 'README.md',
      })
    ).base,
    'current',
  );
  assert.equal(
    calls.length,
    4,
    'The current-diff fallback must preserve the parent envelope too',
  );
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
