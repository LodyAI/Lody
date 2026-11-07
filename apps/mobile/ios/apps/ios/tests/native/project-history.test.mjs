import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { Flock } from '@loro-dev/flock-wasm/base64';

const bundle = await build({
  entryPoints: [
    new URL(
      '../../../../packages/cloud-runtime/src/runtime/project-history.ts',
      import.meta.url,
    ).pathname,
  ],
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
            'export class StreamsClient { constructor(args) { return new globalThis.__historyClient(args); } }',
        }));
      },
    },
  ],
});
const { historyTargets, historyResult, projectHistory } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);

test('history stays scoped to owned supported devices and registered projects, sends exact RPC, and preserves partial failure', async () => {
  const meta = new Flock('history-meta'),
    machine = new Flock('history-machine');
  meta.set(['e', 'machine-m1'], true);
  meta.set(['m', 'machine-m1'], {
    ownerUserId: 'owner',
    name: 'Studio',
    supportsLocalProjectHistoryRpc: true,
  });
  machine.set(['localProject', 'p1'], {
    name: 'Project',
    rootPath: '/project',
  });
  machine.set(['agentConfig', 'a1'], {
    machineId: 'm1',
    cliType: 'builtin',
    agentType: 'codex',
  });
  machine.set(['agentConfig', 'a2'], {
    machineId: 'm1',
    cliType: 'builtin',
    agentType: 'codex',
  });
  const machines = new Map([['m1', machine]]);
  const [target] = historyTargets(meta, machines, 'owner');
  assert.equal(
    historyTargets(meta, machines, 'owner').length,
    1,
    'Duplicate configs are one provider',
  );
  assert.equal(historyTargets(meta, machines, 'other').length, 0);
  meta.set(['m', 'machine-m1', 'supportsLocalProjectHistoryRpc'], false);
  assert.equal(historyTargets(meta, machines, 'owner').length, 0);
  meta.set(['m', 'machine-m1', 'supportsLocalProjectHistoryRpc'], true);
  machine.set(['cmd', 'deleteLocalProject', 'p1'], true);
  assert.equal(historyTargets(meta, machines, 'owner').length, 0);
  machine.delete(['cmd', 'deleteLocalProject', 'p1']);
  let envelope,
    sends = 0;
  const catalog = {
    sessions: [
      {
        acpSessionId: 'one',
        title: 'One',
        status: 'imported',
        importedSessionId: 'lody-one',
      },
      { acpSessionId: 'two', title: 'Two', status: 'available' },
    ],
  };
  globalThis.__historyClient = class {
    async create() {
      return { ok: true };
    }
    async append({ part }) {
      envelope = JSON.parse(part.body);
      sends++;
      return { ok: true };
    }
    async readOnce() {
      return {
        ok: true,
        result: {
          nextOffset: '1',
          payload: {
            body: new TextEncoder().encode(
              JSON.stringify({
                id: envelope.id,
                result: {
                  ok: true,
                  type: envelope.params.request.type,
                  result: {
                    catalog,
                    summary: {
                      failed: 1,
                      failures: [
                        { acpSessionId: 'two', message: 'Agent unavailable' },
                      ],
                    },
                  },
                },
              }),
            ),
          },
        },
      };
    }
  };
  const grant = async () => ({
    token: 'synthetic',
    gatewayBaseUrl: 'https://example.invalid',
  });
  const run = (request) =>
    projectHistory(
      request,
      'w1',
      'owner',
      meta,
      machines,
      grant,
      AbortSignal.timeout(1000),
    );
  await assert.rejects(
    run({
      kind: 'import',
      target: { ...target, machineId: 'other' },
      acpSessionIds: ['one'],
    }),
    /unavailable/,
  );
  await assert.rejects(
    run({ kind: 'import', target, acpSessionIds: Array(6).fill('one') }),
    /invalid_history_request/,
  );
  assert.equal(sends, 0);
  const result = await run({
    kind: 'import',
    target,
    acpSessionIds: ['one', 'two'],
  });
  assert.equal(sends, 1, 'No replay or retry of a write');
  assert.equal(envelope.machineId, 'm1');
  assert.equal(envelope.method, 'local-project/control');
  assert.deepEqual(envelope.params.request, {
    type: 'local-project/import-history',
    localProjectId: 'p1',
    provider: { cliType: 'builtin', agentType: 'codex' },
    requestedByUserId: 'owner',
    acpSessionIds: ['one', 'two'],
    workspaceId: 'w1',
    machineId: 'm1',
  });
  assert.equal(result.sessions[0].status, 'imported');
  assert.equal(result.sessions[1].status, 'available');
  assert.equal(result.failures[0].acpSessionId, 'two');
  assert.throws(
    () =>
      historyResult(
        { sessions: [catalog.sessions[0], catalog.sessions[0]] },
        'sync',
      ),
    /invalid_history_response/,
  );
  assert.throws(
    () => historyResult({ catalog, summary: {} }, 'import'),
    /invalid_history_response/,
  );
  assert.throws(
    () => historyResult({ catalog, status: 'blocked' }, 'resolve'),
    /invalid_history_response/,
  );
});
