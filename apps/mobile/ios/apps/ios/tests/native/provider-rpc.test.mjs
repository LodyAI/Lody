import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const { outputFiles } = await build({
  entryPoints: [
    new URL(
      '../../../../packages/cloud-runtime/src/runtime/provider-rpc.ts',
      import.meta.url,
    ).pathname,
  ],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  plugins: [
    {
      name: 'synthetic-machine',
      setup(b) {
        b.onResolve({ filter: /^\.\/settings$/ }, () => ({
          path: 'settings',
          namespace: 'fixture',
        }));
        b.onResolve({ filter: /^\.\/machine-rpc$/ }, () => ({
          path: 'rpc',
          namespace: 'fixture',
        }));
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
          contents:
            path === 'settings'
              ? 'export const openSettings=(...args)=>globalThis.__providerFixture.open(...args);'
              : 'export const machineRpc=(...args)=>globalThis.__providerFixture.rpc(...args);',
        }));
      },
    },
  ],
});
const { createProviderRpc } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`
);
const scope = {
  workspaceId: 'workspace',
  userId: 'owner',
  machineId: 'machine',
  id: 'provider',
};
function fixture(t) {
  let owner = 'owner',
    online = true,
    valid = true;
  const config = {
    id: 'provider',
    machineId: 'machine',
    cliType: 'builtin',
    agentType: 'codex',
  };
  const protocol = {
    acpProtocolAuthentication: 2,
    acpAuthenticationInteractions: 2,
    acpAuthenticationMethodSelection: 1,
    piExtensions: 1,
    providerRateLimitsRefresh: 1,
  };
  const capability = { rateLimits: { query: true } };
  const calls = [],
    events = [],
    operations = [];
  let dispatch = () => {
    throw new Error('unexpected_rpc');
  };
  globalThis.__providerFixture = {
    open: async (id) => ({
      flock: {
        get(path) {
          if (id.endsWith(':meta')) {
            if (path[0] === 'e') return true;
            if (path.length === 2)
              return { ownerUserId: owner, protocolCapabilities: protocol };
            return { ownerUserId: owner, protocolCapabilities: protocol }[
              path[2]
            ];
          }
          if (path[0] === 'agentConfig') return config;
          if (path[0] === 'acpCapability') return capability;
        },
      },
    }),
    rpc: async (...args) => {
      calls.push(args);
      return dispatch(...args);
    },
  };
  const api = createProviderRpc({
    grant: async () => ({
      token: 'synthetic',
      gatewayBaseUrl: 'https://example.invalid',
    }),
    check: () => {
      if (!valid) throw new Error('scope_changed');
    },
    online: () => online,
    progress: (s) => events.push(s),
    operationProgress: (s) => operations.push(s),
  });
  t.after(async () => {
    await api.dispose();
    delete globalThis.__providerFixture;
  });
  return {
    api,
    calls,
    events,
    operations,
    config,
    protocol,
    capability,
    owner: (v) => (owner = v),
    online: (v) => (online = v),
    invalidate: () => (valid = false),
    dispatch: (v) => (dispatch = v),
  };
}
function startServer(f) {
  let progress, finish;
  f.dispatch((_w, _m, method, params, _grant, signal, notify) => {
    if (method === 'machine/acp-authenticate' && params.action === 'start') {
      progress = notify;
      return new Promise((resolve, reject) => {
        finish = resolve;
        signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      });
    }
    return {
      result: {
        type: 'machine/acp-authenticate_response',
        agentType: 'codex',
        machineId: 'machine',
        requestId: params.requestId,
        success: true,
        disposition:
          params.action === 'cancel' ? 'cancelled' : 'input-accepted',
      },
    };
  });
  return {
    progress: (flowId, value) =>
      progress({
        type: 'machine/acp-authentication-progress',
        machineId: 'machine',
        requestId: flowId,
        agentType: 'codex',
        ...value,
      }),
    finish: (value) => finish({ result: value }),
  };
}
async function recipient() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey'],
  );
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const publicKey = {
    type: 'rpc-secret-public-key-v1',
    algorithm: 'ECDH-P256-AES-256-GCM',
    keyId: 'synthetic-key',
    publicKey: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y },
  };
  return {
    publicKey,
    async decrypt(envelope, context) {
      assert.equal(envelope.type, 'rpc-secret-envelope-v1');
      const ephemeral = await crypto.subtle.importKey(
        'jwk',
        envelope.ephemeralPublicKey,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        [],
      );
      const key = await crypto.subtle.deriveKey(
        { name: 'ECDH', public: ephemeral },
        pair.privateKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['decrypt'],
      );
      return new TextDecoder().decode(
        await crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: Buffer.from(envelope.iv, 'base64url'),
            additionalData: new TextEncoder().encode(
              `lody-machine-rpc-secret-v1\0synthetic-key\0${context}`,
            ),
          },
          key,
          Buffer.from(envelope.ciphertext, 'base64url'),
        ),
      );
    },
  };
}

test('authentication encrypts consent and form input with exact flow scope; accepted input is not completion', async (t) => {
  const f = fixture(t),
    server = startServer(f),
    key = await recipient(),
    flowId = crypto.randomUUID();
  assert.equal(
    (await f.api.auth({ ...scope, action: 'start', flowId })).status,
    'starting',
  );
  assert.equal(f.calls[0][7], 300000);
  server.progress(flowId, {
    status: 'authorization',
    authorizationUrl: 'https://auth.example.invalid/authorize',
    interactionId: 'consent',
    requiresAuthorizationConsent: true,
    authenticationInputPublicKey: key.publicKey,
    output: 'DO NOT PROJECT',
  });
  assert.equal(
    (await f.api.auth({ ...scope, action: 'status', flowId }))
      .requiresAuthorizationConsent,
    true,
  );
  const result = await f.api.auth({
    ...scope,
    action: 'submit',
    flowId,
    interactionId: 'consent',
    responseAction: 'accept',
    values: { password: 'synthetic-secret' },
  });
  assert.equal(result.status, 'authorization');
  assert.equal(result.requiresAuthorizationConsent, false);
  const wire = f.calls[1][3];
  assert.equal(wire.action, 'submit-input');
  assert.equal(JSON.stringify(wire).includes('synthetic-secret'), false);
  assert.deepEqual(
    JSON.parse(
      await key.decrypt(
        wire.authenticationInputEnvelope,
        `machine/acp-authenticate-input\0workspace\0machine\0${flowId}\0consent`,
      ),
    ),
    { action: 'accept', content: { password: 'synthetic-secret' } },
  );
  await assert.rejects(
    key.decrypt(
      wire.authenticationInputEnvelope,
      `machine/acp-authenticate-input\0workspace\0other-machine\0${flowId}\0consent`,
    ),
  );
  assert.equal(JSON.stringify(f.events).includes('DO NOT PROJECT'), false);
  assert.equal(JSON.stringify(f.events).includes('publicKey'), false);
  assert.equal(
    (await f.api.auth({ ...scope, action: 'cancel', flowId })).status,
    'cancelled',
  );
});

test('authorization codes use their own encrypted context and missing keys never send', async (t) => {
  const f = fixture(t),
    server = startServer(f),
    flowId = crypto.randomUUID();
  await f.api.auth({ ...scope, action: 'start', flowId });
  server.progress(flowId, {
    status: 'authorization',
    authorizationUrl: 'javascript:alert(1)',
    acceptsAuthorizationCode: true,
  });
  assert.equal(
    (await f.api.auth({ ...scope, action: 'status', flowId })).authorizationUrl,
    undefined,
  );
  await assert.rejects(
    f.api.auth({
      ...scope,
      action: 'submit',
      flowId,
      authorizationCode: 'synthetic-code',
    }),
    /key_missing/,
  );
  assert.equal(f.calls.length, 1);
  const key = await recipient();
  server.progress(flowId, {
    status: 'authorization',
    authorizationUrl: 'https://auth.example.invalid',
    acceptsAuthorizationCode: true,
    authorizationCodePublicKey: key.publicKey,
  });
  await f.api.auth({
    ...scope,
    action: 'submit',
    flowId,
    authorizationCode: 'synthetic-code',
  });
  const wire = f.calls[1][3];
  assert.equal(
    await key.decrypt(
      wire.authorizationCodeEnvelope,
      `machine/acp-authenticate\0workspace\0machine\0${flowId}`,
    ),
    'synthetic-code',
  );
  assert.equal(JSON.stringify(wire).includes('synthetic-code'), false);
});

test('fresh ownership and online state fence calls; old scope and disposed flows cannot publish', async (t) => {
  const f = fixture(t),
    server = startServer(f),
    flowId = crypto.randomUUID();
  f.owner('teammate');
  await assert.rejects(
    f.api.auth({ ...scope, action: 'start', flowId }),
    /read_only/,
  );
  assert.equal(f.calls.length, 0);
  f.owner('owner');
  f.online(false);
  assert.equal(
    (await f.api.operation({ ...scope, action: 'binary-install' })).success,
    false,
  );
  assert.equal(f.calls.length, 0);
  f.online(true);
  await f.api.auth({ ...scope, action: 'start', flowId });
  await assert.rejects(
    f.api.auth({ ...scope, userId: 'teammate', action: 'status', flowId }),
    /read_only/,
  );
  f.api.dispose();
  assert.throws(
    () => server.progress(flowId, { status: 'authenticated' }),
    /disposed/,
  );
  assert.equal(f.events.length, 0);
});

test('uncertain starts are retained, never replayed; method selection has explicit continuation semantics', async (t) => {
  const f = fixture(t),
    server = startServer(f),
    flowId = crypto.randomUUID();
  await f.api.auth({ ...scope, action: 'start', flowId });
  await f.api.auth({ ...scope, action: 'start', flowId });
  assert.equal(f.calls.length, 1);
  server.progress(flowId, {
    status: 'auth-methods',
    interactionId: 'choose',
    authMethods: [{ id: 'oauth', type: 'agent', name: 'OAuth' }],
  });
  assert.equal(
    (await f.api.auth({ ...scope, action: 'status', flowId })).interactionId,
    'choose',
  );
  await assert.rejects(
    f.api.auth({ ...scope, action: 'start', flowId: crypto.randomUUID() }),
    /running/,
  );
});

test('operation gates Pi and rate limits, preserves progress separately and projects no incidental response data', async (t) => {
  const f = fixture(t);
  f.dispatch((_w, _m, method, params, _g, _signal, progress) => {
    if (method === 'machine/acp-binary-install') {
      progress({
        type: 'machine/acp-binary-progress',
        machineId: 'machine',
        agentType: 'codex',
        status: 'downloading',
        percent: 42,
        output: 'private',
      });
      return {
        result: {
          type: 'machine/acp-binary-install_response',
          machineId: 'machine',
          agentType: 'codex',
          success: true,
          version: '1.0',
          env: { TOKEN: 'private' },
        },
      };
    }
    if (method === 'machine/pi-extensions')
      return {
        result: {
          success: true,
          discovery: {
            version: 1,
            extensions: [
              {
                path: '/synthetic/extension.ts',
                name: 'Example',
                source: 'directory',
              },
            ],
          },
        },
      };
    return {
      result: {
        type: 'machine/provider-rate-limits-refresh_response',
        machineId: 'machine',
        configId: params.configId,
        success: true,
      },
    };
  });
  const installed = await f.api.operation({
    ...scope,
    action: 'binary-install',
  });
  assert.deepEqual(installed, {
    action: 'binary-install',
    success: true,
    status: 'installed',
    version: '1.0',
  });
  assert.deepEqual(f.operations, [
    {
      machineId: 'machine',
      id: 'provider',
      status: 'downloading',
      percent: 42,
    },
  ]);
  await assert.rejects(
    f.api.operation({ ...scope, action: 'pi-extension-scan' }),
    /unsupported/,
  );
  f.config.agentType = 'pi';
  assert.equal(
    (await f.api.operation({ ...scope, action: 'pi-extension-scan' }))
      .extensions[0].path,
    '/synthetic/extension.ts',
  );
  assert.equal(f.calls.at(-1)[7], 180000);
  f.config.agentType = 'codex';
  assert.equal(
    (await f.api.operation({ ...scope, action: 'rate-limits-refresh' }))
      .success,
    true,
  );
  assert.equal(f.calls.at(-1)[7], 60000);
  f.config.env = { OPENAI_API_KEY: 'synthetic' };
  await assert.rejects(
    f.api.operation({ ...scope, action: 'rate-limits-refresh' }),
    /unsupported/,
  );
  delete f.config.env;
  f.capability.rateLimits.query = false;
  await assert.rejects(
    f.api.operation({ ...scope, action: 'rate-limits-refresh' }),
    /unsupported/,
  );
});

test('rate refresh shares a config request and rejects a target-mismatched final reply', async (t) => {
  const f = fixture(t);
  const sent = Promise.withResolvers(),
    response = Promise.withResolvers();
  f.dispatch(() => {
    sent.resolve();
    return response.promise;
  });
  const first = f.api.operation({ ...scope, action: 'rate-limits-refresh' });
  const second = f.api.operation({ ...scope, action: 'rate-limits-refresh' });
  const outcome = Promise.allSettled([first, second]);
  await sent.promise;
  response.resolve({
    result: {
      type: 'machine/provider-rate-limits-refresh_response',
      machineId: 'other-machine',
      configId: 'provider',
      success: true,
    },
  });
  const settled = await outcome;
  assert.equal(f.calls.length, 1);
  assert.equal(
    settled.every(
      (v) => v.status === 'rejected' && /mismatch/.test(v.reason.message),
    ),
    true,
  );
});

test('authentication deadline aborts its transport and marks uncertainty without replay', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  startServer(f);
  const flowId = crypto.randomUUID();
  await f.api.auth({ ...scope, action: 'start', flowId });
  t.mock.timers.tick(300000);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const state = await f.api.auth({ ...scope, action: 'status', flowId });
  assert.equal(state.status, 'error');
  assert.equal(state.errorCode, 'provider_auth_unknown');
  await f.api.auth({ ...scope, action: 'start', flowId });
  assert.equal(f.calls.length, 1);
});

test('authenticated progress remains verifying until the daemon final verification receipt', async (t) => {
  const f = fixture(t),
    server = startServer(f),
    flowId = crypto.randomUUID();
  await f.api.auth({ ...scope, action: 'start', flowId });
  server.progress(flowId, { status: 'authenticated' });
  assert.equal(
    (await f.api.auth({ ...scope, action: 'status', flowId })).status,
    'verifying',
  );
  server.finish({
    type: 'machine/acp-authenticate_response',
    machineId: 'machine',
    agentType: 'codex',
    requestId: flowId,
    success: true,
    disposition: 'authenticated',
    authRequired: true,
    capabilitiesRefreshed: false,
  });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const result = await f.api.auth({ ...scope, action: 'status', flowId });
  assert.equal(result.status, 'error');
  assert.equal(result.errorCode, 'provider_auth_required');
});

test('verification can be cancelled and late authenticated receipt cannot restore success', async (t) => {
  const f = fixture(t),
    server = startServer(f),
    flowId = crypto.randomUUID();
  await f.api.auth({ ...scope, action: 'start', flowId });
  server.progress(flowId, { status: 'authenticated' });
  assert.equal(
    (await f.api.auth({ ...scope, action: 'cancel', flowId })).status,
    'cancelled',
  );
  server.finish({
    type: 'machine/acp-authenticate_response',
    machineId: 'machine',
    agentType: 'codex',
    requestId: flowId,
    success: true,
    disposition: 'authenticated',
    authRequired: false,
    capabilitiesRefreshed: true,
  });
  assert.equal(
    (await f.api.auth({ ...scope, action: 'status', flowId })).status,
    'cancelled',
  );
});

test('dispose cancels remote authentication while retaining the original owner scope', async (t) => {
  const f = fixture(t),
    server = startServer(f),
    flowId = crypto.randomUUID();
  await f.api.auth({ ...scope, action: 'start', flowId });
  server.progress(flowId, { status: 'authenticated' });
  assert.deepEqual(await f.api.dispose(), { unconfirmedFlowIds: [] });
  assert.equal(f.calls[1][3].action, 'cancel');
  assert.equal(f.calls[1][3].authenticationRequestId, flowId);
  assert.equal(f.calls[1][7], 10000);
});

test('dispose bounds a hung cancellation by ten seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  startServer(f);
  const flowId = crypto.randomUUID();
  await f.api.auth({ ...scope, action: 'start', flowId });
  const sent = Promise.withResolvers();
  f.dispatch(() => {
    sent.resolve();
    return new Promise(() => {});
  });
  const disposed = f.api.dispose();
  await sent.promise;
  t.mock.timers.tick(10000);
  assert.deepEqual(await disposed, { unconfirmedFlowIds: [flowId] });
});

test('draft Pi scan uses only fresh machine authority and sends no fabricated config', async (t) => {
  const f = fixture(t);
  f.dispatch(() => ({
    result: {
      success: true,
      discovery: {
        version: 1,
        extensions: [
          { path: '/synthetic/pi.ts', name: 'Pi', source: 'directory' },
        ],
      },
    },
  }));
  const { id, ...machine } = scope;
  assert.equal(
    (await f.api.operation({ ...machine, action: 'pi-extension-scan' }))
      .extensions[0].name,
    'Pi',
  );
  assert.deepEqual(f.calls[0][3], {});
  f.owner('other');
  await assert.rejects(
    f.api.operation({ ...machine, action: 'pi-extension-scan' }),
    /read_only/,
  );
  assert.equal(f.calls.length, 1);
});

test('failed capability refresh never promotes verified authentication', async (t) => {
  const f = fixture(t),
    server = startServer(f),
    flowId = crypto.randomUUID();
  await f.api.auth({ ...scope, action: 'start', flowId });
  server.progress(flowId, { status: 'authenticated' });
  server.finish({
    type: 'machine/acp-authenticate_response',
    machineId: 'machine',
    agentType: 'codex',
    requestId: flowId,
    success: true,
    disposition: 'authenticated',
    authRequired: false,
    capabilitiesRefreshed: false,
  });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    (await f.api.auth({ ...scope, action: 'status', flowId })).status,
    'error',
  );
});

test('dispose does not send cancellation under a replacement owner', async (t) => {
  const f = fixture(t);
  startServer(f);
  const flowId = crypto.randomUUID();
  await f.api.auth({ ...scope, action: 'start', flowId });
  f.owner('replacement');
  assert.deepEqual(await f.api.dispose(), { unconfirmedFlowIds: [flowId] });
  assert.equal(f.calls.length, 1);
});

test('draft binary operations validate catalog selection and keep distinct provider requests', async (t) => {
  const f = fixture(t);
  const { id, ...machine } = scope;
  f.dispatch((_w, _m, method, params) => ({
    result: {
      type: `${method}_response`,
      machineId: 'machine',
      agentType: params.agentType,
      success: true,
      status: 'installed',
    },
  }));
  const results = await Promise.all(
    ['codex', 'claude'].map((agentType) =>
      f.api.operation({
        ...machine,
        action: 'binary-status',
        cliType: 'builtin',
        agentType,
      }),
    ),
  );
  assert.equal(
    results.every((r) => r.status === 'installed'),
    true,
  );
  assert.deepEqual(f.calls.map((c) => c[3].agentType).sort(), [
    'claude',
    'codex',
  ]);
  assert.equal(f.operations.length, 0);
  await assert.rejects(
    f.api.operation({
      ...machine,
      action: 'binary-install',
      cliType: 'registry',
      agentType: 'not-a-real-registry-entry',
    }),
    /unsupported/,
  );
  assert.equal(f.calls.length, 2);
});
