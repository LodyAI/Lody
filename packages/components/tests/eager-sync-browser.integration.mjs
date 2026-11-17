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
const watchdog = setTimeout(() => {
  console.error('Browser acceptance timed out');
  process.exitCode = 1;
  void browser?.close();
  server?.closeAllConnections();
}, 60_000);
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
  const nextDownload = () =>
    new Promise((resolve) => {
      waiting = resolve;
    });
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
  const context = await browser.newContext();
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
  arrived = nextDownload();
  await start(restarted, 'new-activity', 'large', 2);
  await arrived;
  release(6);
  assert.equal(await result(restarted, 'new-activity'), 'cache_rejected');
  await restarted.evaluate(() => globalThis.advance(30 * 60 * 1000));
  arrived = nextDownload();
  await start(restarted, 'expired', 'large', 2);
  await arrived;
  release(7);
  assert.equal(await result(restarted, 'expired'), 'cache_rejected');
  console.log('PASS persisted rejection, restart, new activity and expiry');

  const unavailable = await page({ locks: null });
  await start(unavailable, 'no-lock', 'no-lock');
  assert.equal(await result(unavailable, 'no-lock'), 'skipped');
  assert.equal(downloads.length, 8, 'lock-unavailable degradation must not download');
  console.log('PASS unavailable locks');

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
    await arrived;
    if (i === 0) {
      await start(b, 'same-scope', 'scope-room');
      assert.equal(await result(b, 'same-scope'), 'skipped');
    }
    // Keep at most two gated HTTP requests open per origin.
    if (i % 2 === 1) {
      release(8 + i - 1);
      release(8 + i);
      assert.equal(await result(scopes[i - 1], 'isolated'), 'cache_rejected');
      assert.equal(await result(scopes[i], 'isolated'), 'cache_rejected');
    }
  }
  assert.equal(downloads.length, 12);
  console.log('PASS independent account, plane and workspace claims');
} finally {
  clearTimeout(watchdog);
  await browser?.close();
  server?.closeAllConnections();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  await rm(output, { recursive: true, force: true });
}
