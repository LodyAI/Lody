import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { LoroDoc } from 'loro-crdt/base64';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

const bundle = await build({
  stdin: { contents: "export * from './session.ts'; export { openPayload, sealPayload } from './machine-rpc.ts';", resolveDir: new URL('../vendor/cloud-runtime/src/runtime/', import.meta.url).pathname, loader: 'ts' },
  bundle: true, format: 'esm', platform: 'browser', write: false,
  plugins: [{ name: 'stream-fixture', setup(build) {
    build.onResolve({ filter: /^loro-crdt\/base64$/ }, () => ({ path: pathToFileURL(createRequire(import.meta.url).resolve('loro-crdt/base64')).href, external: true }));
    build.onResolve({ filter: /^@loro-dev\/streams-client$/ }, () => ({ path: 'fake', namespace: 'fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export class StreamsClient { constructor(args) { return new globalThis.__androidStream(args); } }' }));
  } }],
});
const runtime = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const ok = (result = {}) => ({ ok: true, result });
const args = { id: '22222222-2222-4222-8222-222222222222', sessionId: 's', machineId: 'm', userId: 'u', text: 'hello', cliType: 'builtin', agentType: 'codex', modelId: 'model' };

async function fixture({ failAt, target, owner } = {}) {
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const locks = new Map();
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request(name, { signal }, work) {
    const previous = locks.get(name) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => { signal.throwIfAborted(); return work(); });
    locks.set(name, current); return current;
  } } } });
  globalThis.indexedDB = new IDBFactory();
  globalThis.IDBKeyRange = IDBKeyRange;
  const doc = new LoroDoc(), calls = [], replies = new Map();
  globalThis.__androidStream = class {
    constructor({ url }) { this.url = decodeURIComponent(url); }
    async bootstrap() { return ok({ snapshotOffset: '1', nextOffset: '1', upToDate: true, snapshot: { body: doc.export({ mode: 'snapshot' }) }, updates: [] }); }
    async create() { calls.push('reply-stream'); return ok(); }
    async append({ part }) {
      if (this.url.includes(':rpc:req:')) {
        calls.push('rpc');
        const request = JSON.parse(part.body);
        if (failAt === 'rpc') throw new Error('lost_ack');
        replies.set(request.replyTo, request);
      } else {
        calls.push('history');
        doc.import(part.body.subarray(4));
        if (failAt === 'history') throw new Error('lost_ack');
      }
      return ok();
    }
    async readOnce({ signal } = {}) {
      if (this.url.includes(':rpc:res:')) {
        const request = replies.get(this.url.split('/ds/lody/')[1]);
        const result = owner ? await owner(request, signal) : { result: { accepted: true } };
        return ok({ nextOffset: '1', payload: { body: new TextEncoder().encode(JSON.stringify({ id: request.id, ...result })) } });
      }
      return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    }
  };
  let ready;
  const opened = new Promise((resolve) => { ready = resolve; });
  const resolver = target ? () => ({ incremental: true, watch: true, ...target }) : undefined;
  const getGrant = async () => ({ token: 'fixture', gatewayBaseUrl: 'https://x.invalid' });
  const emit = (event) => { if (event.session && JSON.parse(event.session).status === 'live') ready(); };
  const markDispatch = async () => calls.push('dispatch-pointer');
  await runtime.openSession('s', 'w', getGrant, emit, markDispatch, true, resolver);
  await opened;
  if (target?.backend === 'roost') runtime.startAcceptedInputs({
    accountId: 'u', workspaceId: 'w', getGrant, emit, markDispatch, resolveTarget: () => resolver,
    async getDocMeta(room) {
      if (room === 'session-s') return { exists: true, meta: { id: 's', machineId: target.machineId, historyBackend: 'roost' } };
      if (room === 'machine-' + target.machineId) return { exists: true, meta: { protocolCapabilities: {
        sessionInputAcceptance: target.acceptsInput ? 1 : 0,
        sessionInputDispatch: target.dispatchesInput ? 1 : 0,
      } } };
    },
  });
  return { doc, calls, close() { runtime.stopSessions(); void runtime.stopAcceptedInputs(); doc.free(); delete globalThis.__androidStream; if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator); else delete globalThis.navigator; } };
}

for (const [failure, expected] of [[undefined, 'accepted'], ['history', 'unknown'], ['rpc', 'uploaded']]) {
  test(`Loro send preserves durable ordering and does not replay after ${failure ?? 'success'}`, async () => {
    const f = await fixture({ failAt: failure });
    try {
      const result = await runtime.sendTurn(args), duplicate = await runtime.sendTurn(args);
      assert.equal(result.state, expected);
      assert.equal(duplicate.state, 'unknown');
      assert.equal(f.doc.toJSON().history[0].items[0].text, 'hello');
      assert.deepEqual(f.calls, failure === 'history' ? ['history'] : ['history', 'dispatch-pointer', 'reply-stream', 'rpc']);
    } finally { f.close(); }
  });
}

test('Android snapshot opens a Roost session and writes input through the owner', async () => {
  const operations = [];
  let accepted;
  const handoff = new Promise((resolve) => { accepted = resolve; });
  const f = await fixture({
    target: { backend: 'roost', machineId: 'm', acceptsInput: true, dispatchesInput: true },
    async owner(request, signal) {
      const params = await runtime.openPayload(request.params);
      operations.push({ method: request.method, params });
      if (request.method === 'session/history-write') accepted();
      if (request.method === 'session/history-watch') return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
      const response = request.method === 'session/history-read'
        ? { type: 'session/history-read_response', sessionId: 's', success: true, historyRevision: 1, historyCount: 0,
            result: { checkpoint: 'c1', startPosition: 0, totalCount: 0, rows: [], hasMoreOlder: false, cursor: null }, pageTurns: [] }
        : { type: 'session/history-write_response', sessionId: 's', success: true, operation: params.operation,
            result: { status: 'accepted', turnId: params.payload.entry.id, active: true } };
      return { result: await runtime.sealPayload('s', response) };
    },
  });
  try {
    assert.equal((await runtime.sendTurn(args)).state, 'uploaded');
    await handoff;
    assert.equal(operations.find((item) => item.method === 'session/history-write').params.operation, 'accept_input_and_dispatch');
    assert.deepEqual(f.doc.toJSON().history ?? [], []);
  } finally { f.close(); }
});

test('Android snapshot checks the owner receipt after a lost Roost acknowledgement', async () => {
  const operations = [];
  let firstWrite, recoveredWrite;
  const firstHandoff = new Promise((resolve) => { firstWrite = resolve; });
  const recovery = new Promise((resolve) => { recoveredWrite = resolve; });
  const f = await fixture({
    target: { backend: 'roost', machineId: 'm', acceptsInput: true, dispatchesInput: true },
    async owner(request, signal) {
      const params = await runtime.openPayload(request.params);
      operations.push({ method: request.method, params });
      if (request.method === 'session/history-watch') return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
      if (request.method === 'session/history-write') {
        if (operations.filter((item) => item.method === 'session/history-write').length === 1) firstWrite(); else recoveredWrite();
        throw new Error('lost_ack');
      }
      const response = params.query.kind === 'inputAcceptance'
        ? { type: 'session/history-read_response', sessionId: 's', success: true, historyRevision: 1, historyCount: 0,
            result: { status: 'accepted', turnId: params.query.entry.id, active: true } }
        : { type: 'session/history-read_response', sessionId: 's', success: true, historyRevision: 1, historyCount: 0,
            result: { checkpoint: 'c1', startPosition: 0, totalCount: 0, rows: [], hasMoreOlder: false, cursor: null }, pageTurns: [] };
      return { result: await runtime.sealPayload('s', response) };
    },
  });
  try {
    assert.equal((await runtime.sendTurn(args)).state, 'uploaded');
    await firstHandoff;
    runtime.resumeAcceptedInputs();
    await recovery;
    assert.equal(operations.filter((item) => item.method === 'session/history-write').length, 2);
    const queries = operations.filter((item) => item.params.query?.kind === 'inputAcceptance');
    assert.ok(queries.length >= 1);
    assert.ok(queries.every((item) => item.params.query.entry.id === args.id));
  } finally { f.close(); }
});
