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
      export const checkTurnQuota = () => {}, controlTurn = () => {}, editSession = () => {},
        sessionDoc = () => {}, readyHistory = () => [], releaseDeletedSessions = () => {}, respondPermission = () => {};
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
