import { build } from 'esbuild';
import { LoroDoc } from 'loro-crdt/base64';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export async function loadRuntime() {
  const bundle = await build({
    entryPoints: [
      new URL(
        '../../../packages/cloud-runtime/src/runtime/session.ts',
        import.meta.url,
      ).pathname,
    ],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    plugins: [
      {
        name: 'stream',
        setup(b) {
          // Fixtures and runtime must share one WASM instance: passing a Loro
          // container between independently bundled instances corrupts pointers.
          b.onResolve({ filter: /^loro-crdt\/base64$/ }, () => ({
            path: pathToFileURL(
              createRequire(import.meta.url).resolve('loro-crdt/base64'),
            ).href,
            external: true,
          }));
          b.onResolve({ filter: /^@loro-dev\/streams-client$/ }, () => ({
            path: 'mock',
            namespace: 'test',
          }));
          b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
            contents:
              'export class StreamsClient{constructor(a){return new globalThis.__sessionClient(a)}}',
          }));
        },
      },
    ],
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
  );
}

export function frame(bytes) {
  const result = new Uint8Array(bytes.length + 4);
  new DataView(result.buffer).setUint32(0, bytes.length, false);
  result.set(bytes, 4);
  return result;
}

export async function openTestSession({
  failAppend = () => false,
  markDispatch = async () => {},
  onRpc,
  /** Bytes of the workspace settings Flock (`w1:wf:workspace`), e.g. Agent Role rows. */
  settings,
} = {}) {
  const server = new LoroDoc();
  const ok = (result) => ({ ok: true, result });
  let sessionRead;
  let offset = 1;
  const appends = [];
  const replies = new Map();
  globalThis.__sessionClient = class {
    constructor({ url }) {
      this.url = decodeURIComponent(url);
    }
    async bootstrap() {
      if (this.url.includes(':wf:') && settings)
        return ok({
          snapshotOffset: '1',
          nextOffset: '1',
          upToDate: true,
          snapshot: { body: settings() },
          updates: [],
        });
      return ok({
        snapshotOffset: '1',
        nextOffset: '1',
        upToDate: true,
        snapshot: { body: server.export({ mode: 'snapshot' }) },
        updates: [],
      });
    }
    async readOnce() {
      if (this.url.includes(':rpc:res:') && onRpc) {
        const request = replies.get(this.url.split('/ds/lody/')[1]);
        const result = await onRpc(request);
        return ok({
          nextOffset: '1',
          upToDate: true,
          closed: false,
          payload: {
            body: new TextEncoder().encode(
              JSON.stringify({ id: request.id, ...result }),
            ),
          },
        });
      }
      return new Promise((resolve) => {
        sessionRead = resolve;
      });
    }
    async create() {
      return ok({});
    }
    async append({ part }) {
      appends.push(this.url);
      if (failAppend(this.url))
        return { ok: false, result: { code: 'timeout' } };
      if (this.url.includes(':rpc:req:')) {
        const request = JSON.parse(part.body);
        replies.set(request.replyTo, request);
      } else if (!this.url.includes(':rpc:'))
        server.import(part.body.subarray(4));
      return ok({ nextOffset: String(++offset) });
    }
  };
  const runtime = await loadRuntime();
  let resolveEmit;
  const events = [];
  const background = [];
  const nextEmit = () =>
    new Promise((resolve) => {
      resolveEmit = resolve;
    });
  const ready = nextEmit();
  await runtime.openSession(
    's1',
    'w1',
    async () => ({ token: 'synthetic', gatewayBaseUrl: 'https://x.invalid' }),
    (e) => {
      if (e.backgroundWork) background.push(e.backgroundWork);
      if (!e.session) return;
      const value = JSON.parse(e.session);
      events.push(value);
      if (value.status === 'live') resolveEmit?.(value);
    },
    markDispatch,
  );
  await ready;
  let version = server.version();
  const pushUpdate = async () => {
    const update = server.export({ mode: 'update', from: version });
    version = server.version();
    const emitted = nextEmit();
    sessionRead(
      ok({
        nextOffset: String(++offset),
        upToDate: true,
        closed: false,
        payload: { body: frame(update) },
      }),
    );
    return emitted;
  };
  const close = () => {
    runtime.stopSessions();
    delete globalThis.__sessionClient;
  };
  return { runtime, server, pushUpdate, events, background, appends, close };
}
