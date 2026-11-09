import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Flock } from '@loro-dev/flock-wasm/base64';

// Exercise the native bridge boundary: the Role must bind authoritative metadata,
// including field-level writes, rather than a caller-provided config ID.
const bundle = await build({
  entryPoints: ['packages/cloud-runtime/src/runtime/handlers/sessions.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  plugins: [
    {
      name: 'capture-send',
      setup(b) {
        b.onResolve({ filter: /^\.\.\/session$/ }, (args) =>
          args.importer.endsWith('/handlers/sessions.ts')
            ? { path: 'send', namespace: 'fixture' }
            : undefined,
        );
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
          contents: `
      export const sendTurn = args => args;
      export const checkTurnQuota = () => {}, controlTurn = () => {}, cancelRoostInputs = () => {}, actOnPendingInput = () => {}, editSession = () => {},
        sessionDoc = () => {}, sessionHistory = () => {}, readyHistory = () => [], releaseDeletedSessions = () => {}, respondPermission = () => {};
    `,
        }));
      },
    },
  ],
});
const { registerSessions } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);
function send(meta) {
  const handlers = new Map();
  registerSessions(
    {
      state: { workspace: 'w', userId: 'u', metaReplica: { flock: meta } },
      channel: { handle: (name, fn) => handlers.set(name, fn) },
      getGrant: () => assert.fail('metadata lookup needs no network'),
    },
    () => {},
  );
  return handlers.get('sendTurn')({
    sessionId: 's',
    userId: 'u',
    agentRoleId: { value: 'r' },
    agentConfigId: 'untrusted',
  });
}
for (const shape of ['object', 'fields', 'mixed']) {
  test(`Role sends resolve the session Agent Config from ${shape} metadata`, async () => {
    const meta = new Flock(`role-send-${shape}`);
    meta.set(['e', 'session-s'], true);
    if (shape !== 'fields')
      meta.set(['m', 'session-s'], {
        agentConfigId: shape === 'mixed' ? 'old' : 'current',
      });
    if (shape !== 'object')
      meta.set(['m', 'session-s', 'agentConfigId'], 'current');
    meta.commit();
    assert.equal((await send(meta)).agentConfigId, 'current');
  });
}
test('deleted session metadata cannot authorize a Role send', async () => {
  const meta = new Flock('role-send-deleted');
  meta.set(['m', 'session-s'], { agentConfigId: 'current' });
  meta.set(['e', 'session-s'], false);
  meta.commit();
  assert.deepEqual(await send(meta), {
    state: 'not_sent',
    reason: 'session_not_ready',
  });
});

test('session opening waits for metadata and negotiates Roost capabilities with the owner', async () => {
  const bundle = await build({
    entryPoints: ['packages/cloud-runtime/src/runtime/handlers/lifecycle.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    plugins: [
      {
        name: 'capture-session',
        setup(b) {
          b.onResolve({ filter: /^\.\.\/session$/ }, () => ({
            path: 'capture',
            namespace: 'fixture',
          }));
          b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            contents: `
        export const openSession = (...args) => { globalThis.__target = args[6]; };
        export const ensureSession = () => {}, closeSession = () => {}, loadOlderSession = () => {}, releaseReserve = () => {},
          traceSessionResume = () => {}, traceStalledReads = () => {},
          startAcceptedInputs = () => {}, resumeAcceptedInputs = () => {}, stopSessions = () => {};
      `,
          }));
        },
      },
    ],
  });
  const { registerLifecycle } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
  );
  const handlers = new Map();
  const state = {
    workspace: 'w',
    userId: 'u',
    unhealthy: new Set(),
    metaReplica: undefined,
  };
  registerLifecycle({
    state,
    channel: { handle: (name, fn) => handlers.set(name, fn) },
    publishSubscriptions() {},
  });
  await handlers.get('openSession')({ sessionId: 's' });
  try {
    assert.equal(globalThis.__target(), undefined);
    const flock = new Flock('history-target');
    state.metaReplica = { flock };
    flock.set(['e', 'session-s'], true);
    flock.set(['m', 'session-s'], { machineId: 'm', historyBackend: 'roost' });
    flock.set(['e', 'machine-m'], true);
    flock.set(['m', 'machine-m'], {
      protocolCapabilities: {
        sessionHistory: 3,
        sessionHistoryIncremental: 1,
        sessionHistoryWatch: 1,
        sessionHistoryInspection: 2,
        sessionInputAcceptance: 1,
        sessionInputDispatch: 1,
      },
    });
    flock.commit();
    const target = globalThis.__target();
    assert.equal(globalThis.__target.legacyFallbackAllowed(), false);
    assert.equal(target.isCurrent(), true);
    const { isCurrent, ...capabilities } = target;
    assert.deepEqual(capabilities, {
      backend: 'roost',
      accountId: 'u',
      machineId: 'm',
      incremental: true,
      watch: true,
      acceptsInput: true,
      dispatchesInput: true,
      isArchived: false,
      latestUserMsgId: undefined,
      patches: false,
      coherentInspection: true,
    });
    state.workspace = 'other';
    assert.equal(isCurrent(), false);
    assert.throws(() => globalThis.__target(), /workspace_changed/);
    state.workspace = 'w';
    flock.set(['m', 'machine-m', 'protocolCapabilities'], {
      sessionHistory: '3',
      sessionHistoryIncremental: 1,
      sessionHistoryWatch: 1,
    });
    flock.commit();
    assert.throws(() => globalThis.__target(), /roost_history_unsupported/);
    flock.set(['m', 'machine-m', 'protocolCapabilities'], {
      sessionHistory: 3,
    });
    flock.commit();
    const compatible = globalThis.__target();
    assert.equal(compatible.backend, 'roost');
    assert.equal(compatible.incremental, false);
    assert.equal(compatible.watch, false);
    flock.set(['m', 'session-s', 'historyBackend'], 'loro');
    flock.set(['m', 'session-s', 'machineId'], undefined);
    flock.commit();
    assert.deepEqual(globalThis.__target(), { backend: 'loro' });
    assert.equal(globalThis.__target.legacyFallbackAllowed(), true);
  } finally {
    delete globalThis.__target;
  }
});
