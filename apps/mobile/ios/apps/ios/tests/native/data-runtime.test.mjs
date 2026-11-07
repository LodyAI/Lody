import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { Flock } from '@loro-dev/flock-wasm/base64';

test('persistent runtime applies live increments to the existing replica and advances the cursor', async () => {
  const flock = new Flock('synthetic');
  flock.set(['e', 'session-s1'], true, 1);
  flock.set(['e', 'machine-m1'], true, 1);
  flock.set(
    ['m', 'machine-m1'],
    {
      name: 'Synthetic Mac',
      localProjects: { p1: { name: 'app', rootPath: '/a' } },
    },
    1,
  );
  flock.set(['m', 'session-s1'], { title: 'Before', machineId: 'm1' }, 2);
  const snapshot = flock.exportFile(),
    version = flock.version();
  flock.set(['m', 'session-s1', 'title'], 'After', 3);
  flock.set(['m', 'session-s1', 'parentSessionId'], 'parent', 4);
  const update = new TextEncoder().encode(
    JSON.stringify(flock.exportJson(version)),
  );
  let nextEvent;
  const catalogEvent = () =>
    new Promise((resolve) => {
      nextEvent = resolve;
    });
  const requests = [];
  const envelopes = [];
  const replies = new Map();
  let respond;
  globalThis.__runtimeTestClient = class {
    constructor({ url }) {
      this.isMeta = decodeURIComponent(url).endsWith(':meta');
    }
    async bootstrap() {
      return {
        ok: true,
        result: {
          snapshotOffset: '1',
          nextOffset: '1',
          upToDate: true,
          snapshot: { body: snapshot },
          updates: [],
        },
      };
    }
    readOnce(request) {
      if (!this.isMeta) return new Promise(() => {});
      requests.push(request);
      return new Promise((resolve) => {
        respond = resolve;
      });
    }
  };
  globalThis.webkit = {
    messageHandlers: {
      dataRuntime: {
        postMessage(event) {
          if (event.type !== 'envelope') return;
          const message = JSON.parse(event.envelope);
          envelopes.push(message);
          replies.get(message.id)?.(message);
          if (message.kind === 'request' && message.method === 'grant')
            queueMicrotask(() =>
              globalThis.dataRuntime.receive(
                JSON.stringify({
                  v: 1,
                  gen: message.gen,
                  kind: 'result',
                  id: message.id,
                  method: 'grant',
                  payload: {
                    token: 'synthetic',
                    gatewayBaseUrl: 'https://example.invalid',
                    expiresIn: 3600,
                  },
                }),
              ),
            );
          if (message.kind === 'event' && message.method === 'catalog')
            nextEvent?.(message.payload);
        },
      },
    },
  };
  const bundle = await build({
    entryPoints: ['packages/cloud-runtime/src/runtime/index.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    plugins: [
      {
        name: 'synthetic-stream',
        setup(build) {
          build.onResolve(
            { filter: /^@loro-dev\/streams-crdt\/loro$/ },
            () => ({ path: 'presence', namespace: 'presence-test' }),
          );
          build.onLoad({ filter: /.*/, namespace: 'presence-test' }, () => ({
            contents: `
              export const EphemeralStoreAdaptor = store => store;
              export class EphemeralStreamCrdt {
                constructor({ adaptor }) { this.store = adaptor; globalThis.__runtimePresence = this; }
                async join({ onStatusChange }) {
                  onStatusChange('joined');
                  return { ok: true, value: { unsubscribe() {} } };
                }
                async close() { this.closed = true; }
              }
            `,
          }));
          build.onResolve({ filter: /^\.\.?\/files$/ }, () => ({
            path: 'files',
            namespace: 'file-test',
          }));
          build.onLoad({ filter: /.*/, namespace: 'file-test' }, () => ({
            contents: `
              export const readFile = (ctx, args) => ({
                status: 'error', path: args.path,
                code: ctx.ownerSessionId, message: args.sessionId,
              });
              export const fileDiff = (ctx, args) => ({
                status: 'unavailable', base: 'current', path: args.path,
                reason: ctx.ownerSessionId, message: args.sessionId,
              });
              export const turnDiff = fileDiff;
              export const workspaceChanges = (ctx, args) => ({
                status: 'unavailable',
                reason: ctx.ownerSessionId, message: args.sessionId,
              });
              export const listDir = () => ({ entries: [], truncated: false });
            `,
          }));
          build.onResolve({ filter: /^@loro-dev\/streams-client$/ }, () => ({
            path: 'client',
            namespace: 'test',
          }));
          build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
            contents:
              'export const StreamsClient = globalThis.__runtimeTestClient;',
          }));
        },
      },
    ],
  });
  let nextCall = 0;
  const call = (method, payload = {}) => {
    const id = `call-${++nextCall}`;
    const reply = new Promise((resolve) => replies.set(id, resolve));
    globalThis.dataRuntime.receive(
      JSON.stringify({ v: 1, gen: 1, kind: 'request', id, method, payload }),
    );
    return reply;
  };
  await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
  );
  globalThis.dataRuntime.receive(
    JSON.stringify({
      v: 1,
      gen: 1,
      kind: 'request',
      id: 'hello',
      method: 'hello',
      payload: { protocol: 1, gen: 1 },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(envelopes.shift(), {
    v: 1,
    gen: 1,
    kind: 'result',
    id: 'hello',
    method: 'hello',
    payload: {
      protocol: 1,
      methods: [
        'hello',
        'ensureSession',
        'start',
        'setActive',
        'ping',
        'openSession',
        'closeSession',
        'releaseReserve',
        'restoreSessions',
        'publishedShares',
        'promptShortcuts',
        'remoteSettings',
        'memorySettings',
        'agentRoles',
        'mentionCatalog',
        'creationOptions',
        'projectGroups',
        'localProjects',
        'sessionSharing',
        'sessionPreview',
        'iosSimulatorControl',
        'itemDetail',
        'turnDiff',
        'workspaceChanges',
        'fileDiff',
        'readFile',
        'listDir',
        'createTab',
        'createSession',
        'deleteSession',
        'archiveSession',
        'pinSession',
        'markSessionRead',
        'renameSession',
        'respondPermission',
        'controlTurn',
        'checkTurnQuota',
        'editSession',
        'sendTurn',
        'probeSchema',
      ],
    },
  });
  const turn = {
    sessionId: 's1',
    machineId: 'm1',
    userId: 'u1',
    text: 'hello',
    billingEntitlement: null,
  };
  assert.deepEqual((await call('sendTurn', turn)).payload, {
    state: 'not_sent',
    reason: 'metadata_not_ready',
  });
  assert.deepEqual(
    (
      await call('editSession', {
        action: 'read',
        sessionId: 's1',
        expectedUserTurnId: 't1',
        userId: 'u1',
        billingEntitlement: null,
      })
    ).payload,
    { state: 'not_sent', reason: 'metadata_not_ready' },
  );
  const first = catalogEvent();
  const started = await call('start', {
    workspaceId: 'synthetic-workspace',
    userId: '',
    active: true,
    knownRepos: { 'm1:local:p1': 'Afilmory/afilmory' },
  });
  assert.equal(started.kind, 'result');
  const initial = JSON.parse((await first).catalog);
  assert.equal(initial.sessions[0].title, 'Before');
  assert.equal(
    initial.projects.find((p) => p.id === 'm1:local:p1').repoFullName,
    'Afilmory/afilmory',
  );
  const runtimeEvents = envelopes.filter((m) => m.kind === 'event');
  assert.deepEqual(
    runtimeEvents
      .filter((m) => m.method === 'catalog' || m.method === 'synced')
      .map((m) => m.method),
    ['catalog', 'synced'],
  );
  assert.deepEqual(
    runtimeEvents.find(
      (m) => m.method === 'diagnostic' && m.payload.stage === 'bootstrap_ok',
    ).payload,
    { stage: 'bootstrap_ok', stream: 'meta' },
  );
  assert.equal(requests[0].live, 'long-poll');
  const fileCalls = {
    readFile: { sessionId: 's1', path: 'README.md' },
    fileDiff: { sessionId: 's1', path: 'README.md' },
    turnDiff: { sessionId: 's1', path: 'README.md', entryId: 'turn' },
    workspaceChanges: { sessionId: 's1' },
  };
  const owners = async () => {
    const found = {};
    for (const [method, payload] of Object.entries(fileCalls)) {
      const reply = await call(method, payload);
      assert.equal(reply.kind, 'result', method);
      assert.equal(reply.payload.message, 's1');
      found[method] = reply.payload.reason ?? reply.payload.code;
    }
    return found;
  };
  const ownedBy = (owner) =>
    Object.fromEntries(Object.keys(fileCalls).map((method) => [method, owner]));
  assert.deepEqual(await owners(), ownedBy('s1'));
  const second = catalogEvent();
  respond({
    ok: true,
    result: {
      nextOffset: '2',
      upToDate: true,
      closed: false,
      payload: { body: update },
    },
  });
  const changed = await second;
  assert.equal(JSON.parse(changed.catalog).sessions[0].title, 'After');
  assert.equal(
    JSON.parse(changed.catalog).projects.find((p) => p.id === 'm1:local:p1')
      .repoFullName,
    'Afilmory/afilmory',
  );
  assert.equal(changed.revision, 2);
  assert.equal(
    JSON.parse(changed.catalog).sessions[0].parentSessionId,
    'parent',
  );
  // No session document was opened: ownership must come from live Meta Flock.
  assert.deepEqual(await owners(), ownedBy('parent'));
  const listing = await call('listDir', {
    workspaceId: 'synthetic-workspace',
    sessionId: 's1',
    relativePath: '',
    userId: '',
  });
  assert.deepEqual(listing.error, {
    code: 'project_unavailable',
    retryable: false,
  });
  const detail = await call('itemDetail', {
    sessionId: 's1',
    entryId: 'e1',
    itemId: 'i1',
  });
  assert.deepEqual(detail.error, {
    code: 'session_not_ready',
    retryable: false,
  });
  assert.equal(requests[1].offset, '2');
  assert.equal(
    envelopes.filter((m) => m.kind === 'request' && m.method === 'grant')
      .length,
    1,
  );
  assert.ok(envelopes.every((m) => m.gen === 1));
  assert.deepEqual((await call('ping')).payload, {});
  const probe = await call('probeSchema', {
    workspaceId: 'synthetic-workspace',
  });
  assert.deepEqual(probe.payload, {
    creationOptionsTrial: { 'm1:local:p1': 'ok agents=0 capabilities=0' },
    machines: { m1: { otherKeys: ['e', 'm'], capabilities: [] } },
  });
  const writes = {
    createSession: {
      workspaceId: 'other-workspace',
      sessionId: 's2',
      machineId: 'm1',
      agentConfigId: 'a1',
      userId: 'u1',
      title: 'New',
      billingEntitlement: null,
    },
    deleteSession: {
      workspaceId: 'other-workspace',
      sessionId: 's1',
      sessionIds: ['s1'],
    },
    pinSession: {
      workspaceId: 'other-workspace',
      sessionId: 's1',
      pinned: true,
    },
    checkTurnQuota: { sessionId: 's1', billingEntitlement: null },
    sendTurn: { ...turn, modelId: { value: null } },
    controlTurn: {
      action: 'stop',
      sessionId: 's1',
      machineId: 'm1',
      turnId: 't1',
    },
    respondPermission: {
      sessionId: 's1',
      entryId: 'e1',
      itemId: 'i1',
      requestId: 'r1',
      optionId: 'o1',
    },
  };
  const outcomes = {};
  for (const [method, payload] of Object.entries(writes)) {
    const reply = await call(method, payload);
    outcomes[method] = reply.payload ?? reply.error;
  }
  assert.deepEqual(outcomes, {
    createSession: { state: 'rejected' },
    deleteSession: { code: 'metadata_not_ready', retryable: false },
    pinSession: { code: 'metadata_not_ready', retryable: false },
    checkTurnQuota: { state: 'allowed' },
    sendTurn: { state: 'not_sent', reason: 'session_not_ready' },
    controlTurn: { code: 'session_not_ready', retryable: false },
    respondPermission: { code: 'session_not_ready', retryable: false },
  });
  const mentions = await call('mentionCatalog', {
    workspaceId: 'synthetic-workspace',
    userId: '',
    category: 'session',
  });
  assert.equal(mentions.kind, 'result');
  assert.ok(
    mentions.payload.items.some(
      (item) =>
        item.kind === 'session' &&
        item.name === 'After' &&
        item.insertText === `@session:${item.path}`,
    ),
  );
  const moved = await call('promptShortcuts', {
    workspaceId: 'other-workspace',
    userId: '',
    action: 'list',
  });
  assert.deepEqual(moved.error, {
    code: 'workspace_changed',
    retryable: false,
  });
  globalThis.__runtimePresence.store.set('machine:m1', {
    kind: 'machine',
    machineId: 'm1',
    instanceId: 'test',
    updatedAt: Date.now(),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const presence = () =>
    envelopes
      .filter((m) => m.kind === 'event' && m.method === 'machinePresence')
      .at(-1).payload;
  assert.deepEqual(presence(), { state: 'live', onlineMachineIds: ['m1'] });
  assert.equal((await call('setActive', { active: false })).kind, 'result');
  assert.equal(globalThis.__runtimePresence.closed, true);
  assert.equal(presence().state, 'unknown');
  assert.deepEqual(
    envelopes.filter(
      (m) =>
        m.method === 'diagnostic' &&
        m.payload.stage.startsWith('contract_dropped'),
    ),
    [],
  );
  delete globalThis.__runtimePresence;
  delete globalThis.webkit;
  delete globalThis.__runtimeTestClient;
  delete globalThis.dataRuntime;
});
