import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transform } from 'esbuild';
const source = await readFile(
  new URL(
    '../../../../packages/cloud-runtime/src/runtime/machine-rpc.ts',
    import.meta.url,
  ),
  'utf8',
);
const fn = source.slice(
  source.indexOf('export async function machineRpc('),
  source.indexOf('// Code Collab'),
);
const code = (await transform(fn.replace('export ', ''), { loader: 'ts' }))
  .code;
test('capability RPC waits past progress frames for the final result', async () => {
  let id,
    reads = 0;
  const context = {
    crypto,
    Date,
    TextDecoder,
    clientFor: async (stream) =>
      stream.includes(':rpc:req:')
        ? {
            append: async (value) => {
              id = JSON.parse(value.part.body).id;
              return { ok: true };
            },
          }
        : {
            create: async () => ({ ok: true }),
            readOnce: async () => {
              reads++;
              const result =
                reads === 1
                  ? { type: 'machine/acp-binary-progress' }
                  : {
                      type: 'machine/acp-capabilities-refresh_response',
                      success: true,
                    };
              return {
                ok: true,
                result: {
                  nextOffset: String(reads),
                  payload: {
                    body: new TextEncoder().encode(
                      JSON.stringify({ id, result }),
                    ),
                  },
                },
              };
            },
          },
  };
  vm.createContext(context);
  vm.runInContext(code + ';globalThis.call=machineRpc;', context);
  const reply = await context.call(
    'w',
    'm',
    'machine/acp-capabilities-refresh',
    { configId: 'g' },
    () => {},
    new AbortController().signal,
  );
  assert.equal(reads, 2);
  assert.equal(reply.result.success, true);
});
