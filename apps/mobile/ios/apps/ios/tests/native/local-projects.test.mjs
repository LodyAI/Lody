import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: [
    new URL(
      '../../../../packages/cloud-runtime/src/runtime/local-projects.ts',
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
            'export class StreamsClient { constructor(args) { return new globalThis.__projectClient(args); } }',
        }));
      },
    },
  ],
});
const runtime = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);
const grant = async () => ({
  token: 'synthetic',
  gatewayBaseUrl: 'https://example.invalid',
});
const signal = () => AbortSignal.timeout(1000);

test('directory RPC targets the chosen machine, correlates responses and rejects errors', async () => {
  let envelope;
  let fail = false;
  globalThis.__projectClient = class {
    async create() {
      return { ok: true };
    }
    async append({ part }) {
      envelope = JSON.parse(part.body);
      return { ok: true };
    }
    async readOnce() {
      return {
        ok: true,
        result: {
          nextOffset: '1',
          payload: {
            body: new TextEncoder().encode(
              JSON.stringify([
                { id: 'other', result: { ok: true } },
                {
                  id: envelope.id,
                  ...(fail
                    ? { error: { message: 'denied' } }
                    : {
                        result: {
                          ok: true,
                          type: 'local-project/browse-dir',
                          result: {
                            path: '/home',
                            parentPath: '/',
                            entries: [],
                            truncated: false,
                          },
                        },
                      }),
                },
              ]),
            ),
          },
        },
      };
    }
  };
  const request = { type: 'local-project/browse-dir' };
  const result = await runtime.projectControl(
    'w',
    'm',
    request,
    grant,
    signal(),
  );
  assert.equal(runtime.directoryResult(result).path, '/home');
  assert.equal(envelope.params.request.machineId, 'm');
  assert.equal(envelope.params.request.workspaceId, 'w');
  assert.equal(envelope.method, 'local-project/control');
  fail = true;
  await assert.rejects(
    runtime.projectControl('w', 'm', request, grant, signal()),
    /denied/,
  );
  await assert.rejects(
    runtime.projectControl('w', 'm', request, grant, AbortSignal.abort()),
  );
});

test('registration preserves existing names and never replays an uncertain append', async () => {
  let appends = 0;
  globalThis.__projectClient = class {
    async append() {
      appends++;
      throw new Error('lost ACK');
    }
  };
  const prepared = {
    localProjectId: 'local-project-test',
    name: 'Folder',
    rootPath: '/folder',
  };
  const existing = {
    get: (key) =>
      key[0] === 'localProject'
        ? { name: 'Custom name', rootPath: '/folder' }
        : undefined,
  };
  assert.equal(
    (
      await runtime.registerProject(
        'w',
        'm',
        prepared,
        existing,
        grant,
        signal(),
      )
    ).name,
    'Custom name',
  );
  assert.equal(appends, 0);
  const empty = { get: () => undefined };
  await assert.rejects(
    runtime.registerProject('w', 'm', prepared, empty, grant, signal()),
    /project_write_unknown/,
  );
  await assert.rejects(
    runtime.registerProject('w', 'm', prepared, empty, grant, signal()),
    /project_write_unknown/,
  );
  assert.equal(appends, 1);
  await assert.rejects(
    runtime.registerProject(
      'w',
      'm',
      { ...prepared, alreadyRegistered: true },
      empty,
      grant,
      signal(),
    ),
    /project_sync_pending/,
  );
});

test('registration imports only an acknowledged framed update', async () => {
  let bytes;
  globalThis.__projectClient = class {
    async append({ part }) {
      bytes = part.body;
      return { ok: true };
    }
  };
  let imported;
  const replica = {
    get: () => undefined,
    importJson: (value) => {
      imported = value;
    },
  };
  const result = await runtime.registerProject(
    'w',
    'm',
    { localProjectId: 'success', name: 'Folder', rootPath: '/folder' },
    replica,
    grant,
    signal(),
  );
  assert.equal(result.id, 'm:local:success');
  assert.equal(new DataView(bytes.buffer).getUint32(0), bytes.length - 4);
  assert.deepEqual(
    imported,
    JSON.parse(new TextDecoder().decode(bytes.subarray(4))),
  );
});
