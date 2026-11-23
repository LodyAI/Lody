// node tests/eager-sync-browser.integration.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { build } from 'vite';
import wasm from 'vite-plugin-wasm';
import { loroCrdtBundlerAlias, loroCrdtWasmUrlWorkaround } from '../vite-wasm-workarounds.ts';
import { LoroDoc } from 'loro-crdt';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), 'eager-sync-browser-'));
const remote = new LoroDoc();
remote.getList('history').push({ id: 'synthetic' });
remote.commit();
const body = JSON.stringify({
  type: 'joined',
  protocolVersion: 7,
  serverVersion: Buffer.from(remote.oplogVersion().encode()).toString('base64'),
  payload: {
    kind: 'doc-update',
    dataBase64: Buffer.from(remote.export({ mode: 'update' })).toString('base64'),
  },
});
remote.free();
const deadline = new AbortController();
let watchdog;
let browser;
let server;
try {
  await build({
    root,
    configFile: false,
    logLevel: 'error',
    resolve: { alias: loroCrdtBundlerAlias() },
    plugins: [loroCrdtWasmUrlWorkaround(), wasm()],
    worker: { format: 'es', plugins: () => [loroCrdtWasmUrlWorkaround(), wasm()] },
    build: {
      outDir: output,
      target: 'esnext',
      lib: {
        entry: path.join(root, 'tests/eager-sync-browser.fixture.ts'),
        formats: ['es'],
        fileName: () => 'fixture.js',
      },
    },
  });
  const downloads = [];
  let waiting;
  const nextDownload = () => {
    const pending = new Promise((resolve, reject) => {
      const abort = () => reject(deadline.signal.reason);
      if (deadline.signal.aborted) {
        abort();
        return;
      }
      deadline.signal.addEventListener('abort', abort, { once: true });
      waiting = () => {
        deadline.signal.removeEventListener('abort', abort);
        resolve();
      };
    });
    // Observe a watchdog rejection even while a page command is still pending.
    void pending.catch(() => {});
    return pending;
  };
  server = createServer(async (request, response) => {
    if (request.url === '/download') {
      downloads.push(response);
      waiting?.();
      waiting = undefined;
      return;
    }
    if (request.url === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<script type="module" src="/fixture.js"></script>');
      return;
    }
    try {
      const file = path.join(output, new URL(request.url, 'http://localhost').pathname);
      response.setHeader(
        'Content-Type',
        file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript'
      );
      response.end(await readFile(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  let context = await browser.newContext();
  const page = async (options = {}) => {
    const p = await context.newPage();
    p.on('pageerror', (error) => console.error('Page error:', error));
    await p.goto(url);
    await p.waitForFunction(() => typeof globalThis.configure === 'function');
    await p.evaluate((o) => globalThis.configure(o), options);
    return p;
  };
  const start = (p, id, room, activity = 1) =>
    p.evaluate(({ id, room, activity }) => globalThis.start(id, room, activity), {
      id,
      room,
      activity,
    });
  const result = (p, id) => p.evaluate((id) => globalThis.result(id), id);
  const release = (index) => {
    downloads[index].setHeader('Content-Type', 'application/json');
    downloads[index].end(body);
  };
  const a = await page();
  const b = await page();
  // Load the cold build and browser fixture before starting the runner watchdog.
  watchdog = setTimeout(() => {
    const error = new Error('Browser acceptance timed out');
    console.error(error.message);
    deadline.abort(error);
    void browser?.close();
    server?.closeAllConnections();
  }, 60_000);
  let arrived = nextDownload();
  await start(a, 'first', 'room');
  await arrived;
  await start(b, 'overlap', 'room');
  assert.equal(await result(b, 'overlap'), 'skipped');
  assert.equal(downloads.length, 1, 'two windows must not download the same room concurrently');
  assert.equal(
    await a.evaluate(() => globalThis.snapshot('room')),
    null,
    'checkpoint must wait for downloaded data'
  );
  release(0);
  assert.equal(await result(a, 'first'), 'synced');
  assert.ok((await a.evaluate(() => globalThis.snapshot('room'))).size > 0);
  await start(b, 'cache', 'room');
  assert.equal(await result(b, 'cache'), 'synced');
  assert.equal(downloads.length, 1, 'successor must re-read the committed cache under its claim');
  console.log('PASS concurrent dedup and committed cache');

  arrived = nextDownload();
  await start(a, 'cancelled', 'cancel');
  await arrived;
  await a.evaluate(() => globalThis.cancel('cancelled'));
  assert.equal(await result(a, 'cancelled'), 'skipped');
  arrived = nextDownload();
  await start(b, 'after-cancel', 'cancel');
  await arrived;
  release(1);
  release(2);
  assert.equal(await result(b, 'after-cancel'), 'synced');
  console.log('PASS cancellation');

  arrived = nextDownload();
  await start(a, 'closing', 'close');
  await arrived;
  await a.close();
  // Closing a context releases Web Locks asynchronously. Join that actual
  // release before using the production client's non-waiting claim.
  const closedOwnerLock = `lody:eager-sync:${JSON.stringify(['workspace', 'close', 'workspace', 'account', 'local'])}`;
  await b.evaluate((key) => navigator.locks.request(key, () => {}), closedOwnerLock);
  arrived = nextDownload();
  await start(b, 'after-close', 'close');
  await arrived;
  release(3);
  release(4);
  assert.equal(await result(b, 'after-close'), 'synced');
  console.log('PASS owning window close');

  const rejecter = await page({ reject: true });
  arrived = nextDownload();
  await start(rejecter, 'rejected', 'large');
  await arrived;
  release(5);
  assert.equal(await result(rejecter, 'rejected'), 'cache_rejected');
  assert.equal(await b.evaluate(() => globalThis.snapshot('large')), null);
  await start(b, 'cooldown', 'large');
  assert.equal(await result(b, 'cooldown'), 'cache_rejected');
  assert.equal(downloads.length, 6, 'another window must respect persisted rejection');
  await rejecter.close();
  const restarted = await page({ reject: true });
  await start(restarted, 'restart', 'large');
  assert.equal(await result(restarted, 'restart'), 'cache_rejected');
  assert.equal(downloads.length, 6);
  for (let activity = 2; activity <= 20; activity++) {
    await start(b, `active-${activity}`, 'large', activity);
    assert.equal(await result(b, `active-${activity}`), 'cache_rejected');
  }
  assert.equal(downloads.length, 6, 'new messages cannot bypass a refused cache cooldown');
  // Five more refused downloads at 30m, 1.5h, 3.5h, 7.5h, 15.5h.
  let elapsed = 0;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const delay = 30 * 60 * 1000 * 2 ** (attempt - 1);
    elapsed += delay;
    await restarted.evaluate((ms) => globalThis.advance(ms), delay);
    const index = downloads.length;
    arrived = nextDownload();
    await start(restarted, `retry-${attempt}`, 'large', 20 + attempt);
    await arrived;
    release(index);
    assert.equal(await result(restarted, `retry-${attempt}`), 'cache_rejected');
  }
  await restarted.evaluate((ms) => globalThis.advance(ms), 24 * 60 * 60 * 1000 - elapsed);
  await start(restarted, 'at-24h', 'large', 100);
  assert.equal(await result(restarted, 'at-24h'), 'cache_rejected');
  assert.equal(downloads.length, 11, 'a refused room performs only six actual downloads in 24h');
  console.log('PASS persistent exponential refusal backoff and continuous-activity download bound');
  const afterRefusals = downloads.length;

  const unavailable = await page({ locks: null });
  await start(unavailable, 'no-lock', 'no-lock');
  assert.equal(await result(unavailable, 'no-lock'), 'skipped');
  assert.equal(downloads.length, afterRefusals, 'lock-unavailable degradation must not download');
  console.log('PASS unavailable locks');

  await context.close();
  context = await browser.newContext();
  // Claims and refusal records must not spread across authority/plane/workspace.
  const scopes = [
    await page({ reject: true }),
    await page({ reject: true, authorizationScope: 'another-account' }),
    await page({ reject: true, plane: 'cloud' }),
    await page({ reject: true, workspaceId: 'another-workspace' }),
  ];
  for (let i = 0; i < scopes.length; i++) {
    arrived = nextDownload();
    await start(scopes[i], 'isolated', 'scope-room');
    assert.equal(
      await Promise.race([arrived.then(() => 'download'), result(scopes[i], 'isolated')]),
      'download'
    );
    const held = await scopes[i].evaluate(async () =>
      (await navigator.locks.query()).held.map((lock) => lock.name)
    );
    const workspace = i === 3 ? 'another-workspace' : 'workspace';
    const plane = i === 2 ? 'cloud' : 'local';
    const authority = i === 1 ? 'another-account' : 'account';
    const key = [
      workspace,
      'scope-room',
      workspace,
      authority,
      plane,
      ...(plane === 'cloud' ? [`${url}/ds/bucket/scope-room`] : []),
    ];
    assert.ok(held.includes(`lody:eager-sync:${JSON.stringify(key)}`));
    if (i === 0) {
      const contender = await page();
      await start(contender, 'same-scope', 'scope-room');
      assert.equal(await result(contender, 'same-scope'), 'skipped');
      await contender.close();
    }
    release(afterRefusals + i);
    assert.equal(await result(scopes[i], 'isolated'), 'cache_rejected');
  }
  assert.equal(downloads.length, afterRefusals + 4);
  console.log('PASS independent account, plane and workspace claims');

  for (const stage of ['snapshot', 'rejection']) {
    const stalled = await page({ pendingRead: stage });
    const room = `unanswered-${stage}`;
    await start(stalled, 'stalled', room);
    await stalled.evaluate(() => globalThis.enteredRead());
    await stalled.evaluate(() => globalThis.cancel('stalled'));
    assert.equal(await result(stalled, 'stalled'), 'skipped');
    const lock = `lody:eager-sync:${JSON.stringify(['workspace', room, 'workspace', 'account', 'local'])}`;
    // Native lock acquisition is the release receipt, not a sleep/poll heuristic.
    await stalled.evaluate((key) => navigator.locks.request(key, () => {}), lock);
    const successor = await page();
    const index = downloads.length;
    arrived = nextDownload();
    await start(successor, 'successor', room);
    assert.equal(
      await Promise.race([arrived.then(() => 'download'), result(successor, 'successor')]),
      'download'
    );
    release(index);
    assert.equal(await result(successor, 'successor'), 'synced');
    await stalled.close();
    await successor.close();
  }
  console.log('PASS cancelled unanswered cache reads release native claims and queue slots');

  const failing = await page({ fail: true });
  let index = downloads.length;
  arrived = nextDownload();
  await start(failing, 'failed', 'failure-room');
  await arrived;
  release(index);
  assert.equal(await result(failing, 'failed'), 'failed');
  const failureReader = await page();
  await start(failureReader, 'failure-cooldown', 'failure-room', 2);
  assert.equal(await result(failureReader, 'failure-cooldown'), 'failed');
  assert.equal(downloads.length, index + 1);
  await failureReader.evaluate(() => globalThis.advance(60 * 1000));
  index = downloads.length;
  arrived = nextDownload();
  await start(failureReader, 'recovery', 'failure-room', 2);
  await arrived;
  release(index);
  assert.equal(await result(failureReader, 'recovery'), 'synced');
  await failureReader.evaluate(() => globalThis.configure({ fail: true }));
  index = downloads.length;
  arrived = nextDownload();
  await start(failureReader, 'failed-again', 'failure-room', 3);
  await arrived;
  release(index);
  assert.equal(await result(failureReader, 'failed-again'), 'failed');
  assert.equal(
    await failureReader.evaluate(() => globalThis.retryAt('failure-room')),
    2 * 60 * 1000,
    'successful cache resets exponential attempts'
  );

  const timeout = await page({ fail: true });
  index = downloads.length;
  arrived = nextDownload();
  await start(timeout, 'timeout', 'timeout-room');
  await arrived;
  await timeout.evaluate(() => globalThis.timeout('timeout'));
  assert.equal(await result(timeout, 'timeout'), 'failed');
  const timeoutLock = `lody:eager-sync:${JSON.stringify(['workspace', 'timeout-room', 'workspace', 'account', 'local'])}`;
  await timeout.evaluate((key) => navigator.locks.request(key, () => {}), timeoutLock);
  release(index);
  const timeoutReader = await page();
  await start(timeoutReader, 'after-timeout', 'timeout-room', 2);
  assert.equal(await result(timeoutReader, 'after-timeout'), 'failed');
  assert.equal(downloads.length, index + 1, 'timeout cooldown must survive to another window');
  console.log('PASS failure persistence, successful reset and timeout receipts');
} finally {
  clearTimeout(watchdog);
  await browser?.close();
  server?.closeAllConnections();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  await rm(output, { recursive: true, force: true });
}
