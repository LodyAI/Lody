import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/**
 * Bundles the runtime's schedule repository and command mapping against an
 * in-memory Streams gateway (`globalThis.__scheduleStreams`, stream id →
 * appended parts). Loro is shared with the caller so documents can be read
 * back without crossing WASM instances.
 */
export async function loadSchedules() {
  const require = createRequire(import.meta.url);
  const bundle = await build({
    stdin: {
      contents: `
        export * from './src/runtime/schedules.ts';
        export { draftInput, ruleOf, triggerOf } from './src/runtime/handlers/schedules.ts';
        export * from './src/protocol/schedules.ts';
      `,
      resolveDir: new URL(
        '../../../../packages/cloud-runtime/',
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
        name: 'stream',
        setup(b) {
          b.onResolve({ filter: /^loro-crdt(\/base64)?$/ }, () => ({
            path: pathToFileURL(require.resolve('loro-crdt/base64')).href,
            external: true,
          }));
          b.onResolve({ filter: /^@loro-dev\/streams-client$/ }, () => ({
            path: 'mock',
            namespace: 'test',
          }));
          b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
            contents: `export class StreamsClient {
              constructor({ url }) {
                this.id = decodeURIComponent(url.split('/ds/lody/')[1]);
              }
              get store() { return globalThis.__scheduleStreams; }
              async create() {
                if (!this.store.has(this.id)) this.store.set(this.id, []);
                return { ok: true, result: {} };
              }
              async bootstrap() {
                const parts = this.store.get(this.id);
                if (!parts) return { ok: false, result: { code: 'not_found' } };
                return { ok: true, result: {
                  snapshotOffset: '-1', snapshot: null,
                  updates: parts.map((body) => ({ body })),
                  nextOffset: String(parts.length), cursor: '', upToDate: true,
                } };
              }
              async readOnce() { throw new Error('unexpected read'); }
              async append({ part }) {
                const parts = this.store.get(this.id);
                if (!parts) return { ok: false, result: { code: 'not_found' } };
                parts.push(part.body);
                return { ok: true, result: {} };
              }
            }`,
          }));
        },
      },
    ],
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
  );
}

export const grant = async () => ({
  token: 't',
  gatewayBaseUrl: 'https://gateway.test',
});
