import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { LoroDoc } from 'loro-crdt/base64';

const bundle = await build({
  stdin: {
    contents: "export * from './preview';",
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
  external: ['loro-crdt/base64'],
});
const runtime = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);

const tunnel =
  'https://calm-river-demo.trycloudflare.com/?__lody_preview_token=abc';
const docWith = (preview) => {
  const doc = new LoroDoc();
  for (const [key, value] of Object.entries(preview))
    doc.getMap('preview').set(key, value);
  return doc;
};

function machine(handler) {
  const calls = [];
  return {
    calls,
    rpc: async (method, params) => {
      calls.push({ method, params });
      return handler({ method, params });
    },
  };
}

test('preview target only accepts a loopback candidate or live connection', () => {
  const local = { protocol: 'http', host: 'localhost', port: 5173, path: '/a' };
  assert.deepEqual(
    runtime.previewTarget(
      docWith({ candidate: { status: 'available', target: local } }),
    ),
    local,
  );
  assert.equal(
    runtime.previewTarget(
      docWith({
        candidate: {
          status: 'available',
          target: { ...local, host: '192.168.1.2' },
        },
      }),
    ),
    undefined,
  );
  assert.equal(
    runtime.previewTarget(
      docWith({ candidate: { status: 'invalid', target: local } }),
    ),
    undefined,
  );
  assert.deepEqual(
    runtime.previewTarget(
      docWith({ connection: { status: 'active', target: local } }),
    ),
    local,
  );
});

test('viewer url keeps the token and refuses foreign origins', () => {
  assert.equal(
    runtime.viewerUrl(tunnel, '/docs?x=1'),
    'https://calm-river-demo.trycloudflare.com/docs?x=1&__lody_preview_token=abc',
  );
  assert.equal(runtime.viewerUrl(tunnel, '//evil.example/'), undefined);
  assert.equal(
    runtime.viewerUrl('https://evil.example/?__lody_preview_token=abc'),
    undefined,
  );
  assert.equal(
    runtime.viewerUrl('https://calm-river-demo.trycloudflare.com/'),
    undefined,
  );
});

const args = (overrides = {}) => ({
  workspaceId: 'w',
  machineId: 'm',
  sessionId: 's',
  userId: 'u',
  target: { protocol: 'http', host: 'localhost', port: 5173, path: '/app' },
  mintToken: async () => 'signed',
  ...overrides,
});
const nonce = '4b9f2d1e-8c3a-4f5b-9d6e-1a2b3c4d5e6f';

test('create proves the exact intent and opens the tunnel path', async () => {
  const intents = [];
  const { calls, rpc } = machine(({ method }) =>
    method === 'machine/preview-control'
      ? { result: { success: true, runtimeNonce: nonce } }
      : {
          result: {
            success: true,
            connection: { status: 'active', publicUrl: tunnel },
          },
        },
  );
  const reply = await runtime.createPreview(
    args({
      rpc,
      mintToken: async (intent) => {
        intents.push(intent);
        return 'signed';
      },
    }),
  );
  assert.deepEqual(reply, {
    url: 'https://calm-river-demo.trycloudflare.com/app?__lody_preview_token=abc',
  });
  assert.deepEqual(
    calls.map((call) => call.method),
    ['machine/preview-control', 'session/preview-create'],
  );
  const create = calls[1].params;
  assert.deepEqual(Object.keys(create).sort(), [
    'approval',
    'proof',
    'requestedByUserId',
    'sessionId',
    'target',
  ]);
  assert.deepEqual(create.proof, {
    runtimeNonce: nonce,
    requestId: intents[0].requestId,
    requestToken: 'signed',
  });
  assert.equal(create.approval.targetClass, 'loopback');
  assert.equal(create.approval.confirmedByUserId, 'u');
  assert.deepEqual(intents[0].operation, {
    action: 'create',
    target: args().target,
    restart: false,
  });
  assert.equal('requesterUserId' in intents[0], false);
});

test('machine failures surface its code and message', async () => {
  let { rpc } = machine(({ method }) =>
    method === 'machine/preview-control'
      ? { result: { success: true, runtimeNonce: nonce } }
      : {
          result: {
            success: false,
            error: 'grant_denied',
            message: 'Only the session initiator can approve.',
          },
        },
  );
  assert.deepEqual(await runtime.createPreview(args({ rpc })), {
    error: 'grant_denied',
    message: 'Only the session initiator can approve.',
  });
  ({ rpc } = machine(() => ({
    result: { success: true, runtimeNonce: nonce },
  })));
  assert.deepEqual(
    await runtime.createPreview(
      args({ rpc, mintToken: async () => undefined }),
    ),
    { error: 'unauthorized' },
  );
  ({ rpc } = machine(async () => {
    throw new Error('cancelled');
  }));
  assert.deepEqual(await runtime.createPreview(args({ rpc })), {
    error: 'unsupported',
  });
});

test('revoke signs a revoke intent and reports success', async () => {
  const intents = [];
  const { calls, rpc } = machine(({ method }) =>
    method === 'machine/preview-control'
      ? { result: { success: true, runtimeNonce: nonce } }
      : { result: { success: true } },
  );
  const reply = await runtime.revokePreview(
    args({
      rpc,
      mintToken: async (intent) => {
        intents.push(intent);
        return 'signed';
      },
    }),
  );
  assert.deepEqual(reply, {});
  assert.deepEqual(intents[0].operation, { action: 'revoke' });
  assert.deepEqual(Object.keys(calls[1].params).sort(), [
    'proof',
    'requestedByUserId',
    'sessionId',
  ]);
});

test('summary labels the target and tracks a live connection', () => {
  const local = { protocol: 'http', host: '127.0.0.1', port: 8421 };
  assert.deepEqual(
    runtime.previewSummary(
      docWith({
        candidate: { status: 'available', target: local },
        connection: { status: 'active', target: local },
      }),
    ),
    { label: '127.0.0.1:8421', active: true },
  );
  assert.equal(runtime.previewSummary(docWith({})), undefined);
});
