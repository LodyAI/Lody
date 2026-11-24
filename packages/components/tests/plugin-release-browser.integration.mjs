import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:https';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'vite';
import { chromium, webkit } from '@playwright/test';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'plugin-browser-'));
const exec = promisify(execFile);
const servers = [];
async function serve(tls, handler) {
  const server = createServer(tls, handler);
  servers.push(server);
  await new Promise((resolve, reject) =>
    server.once('error', reject).listen(0, '127.0.0.1', resolve)
  );
  return `https://127.0.0.1:${server.address().port}`;
}
try {
  const output = await build({
    configFile: false,
    logLevel: 'warn',
    build: {
      write: false,
      target: 'esnext',
      lib: {
        entry: join(root, 'packages/components/tests/browser/plugin-release-fixture.ts'),
        formats: ['es'],
      },
    },
  });
  const js = (Array.isArray(output) ? output[0] : output).output.find(
    (o) => o.type === 'chunk' && o.isEntry
  ).code;
  const source = join(dir, 'source');
  await mkdir(source);
  await writeFile(
    join(source, 'lody.plugin.json'),
    JSON.stringify({
      id: 'ci-clock',
      version: '1.0.0',
      sdk: '^1.0.0',
      title: 'Clock',
      client: 'client.js',
    })
  );
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: '@lody-fixture/clock' }));
  await writeFile(
    join(source, 'client.js'),
    `export default {kind:'client-plugin',register(){const marker=document.createElement('output');marker.textContent='Verified clock';document.body.append(marker);return ()=>marker.remove();}}`
  );
  const { stdout } = await exec(
    process.execPath,
    [
      join(root, 'apps/cli/dist/index.js'),
      'plugin',
      'pack',
      source,
      '-o',
      join(dir, 'release.tgz'),
    ],
    { cwd: dir, env: { HOME: dir, PATH: process.env.PATH, LODY_DATA_DIR: join(dir, 'data') } }
  );
  const { workspaceEntry: pin } = JSON.parse(stdout);
  const archive = await readFile(join(dir, 'release.tgz'));
  await exec('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-keyout',
    join(dir, 'key'),
    '-out',
    join(dir, 'cert'),
  ]);
  const tls = { key: await readFile(join(dir, 'key')), cert: await readFile(join(dir, 'cert')) };
  const app = await serve(tls, (req, res) => {
    if (req.url === '/fixture.js') {
      res.setHeader('Content-Type', 'application/javascript');
      res.end(js);
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><title>Plugin release integration</title>');
    }
  });
  let requests = 0,
    bad = false;
  const registry = await serve(tls, (req, res) => {
    requests++;
    if (
      req.headers.origin !== app ||
      req.url !==
        `/${pin.source.package_name}/-/${pin.source.package_name.split('/').at(-1)}-${pin.source.exact_version}.tgz`
    ) {
      res.writeHead(403).end();
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', app);
    res.setHeader('Cache-Control', 'no-store');
    res.end(bad ? Buffer.from('corrupt') : archive);
  });
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
      const a = await ctx.newPage(),
        b = await ctx.newPage();
      const open = async (page) => {
        await page.goto(app);
        return page.evaluate(async (pin) => {
          const api = await import('/fixture.js');
          const lifetime = new AbortController();
          window.release = {
            api,
            pin: api.workspacePluginEntrySchema.parse(pin),
            signal: lifetime.signal,
            changed: false,
            store: await api.workspaceReleaseStore(
              'synthetic/space/genesis/key',
              lifetime.signal,
              () => {
                window.release.changed = true;
              }
            ),
          };
          return (await window.release.store.list()).length;
        }, pin);
      };
      const before = requests;
      assert.equal(await open(a), 0);
      assert.equal(await open(b), 0);
      assert.equal(requests, before);
      const approve = async (page) =>
        page.evaluate(async (registry) => {
          const { api, pin, signal, store } = window.release;
          const row = await api.fetchWorkspaceNpmRelease(pin, signal, registry);
          await store.put({ ...row, npm: pin });
        }, registry);
      bad = true;
      await assert.rejects(approve(a), /integrity mismatch/);
      assert.equal(await a.evaluate(async () => (await window.release.store.list()).length), 0);
      bad = false;
      await approve(a);
      assert.equal(requests, before + 2);
      await b.waitForFunction(() => window.release.changed, {}, { timeout: 10000 });
      assert.equal(await open(b), 1);
      await b.evaluate(async () => {
        const { api, store, pin, signal } = window.release;
        const [row] = await store.list();
        const page = api.workspacePage(row);
        const bytes = await api.receiveClientBundle(pin.client_digest, (offset) =>
          page(offset, signal)
        );
        const source = new TextDecoder().decode(
          api.unpackClientBundle(bytes)(pin.manifest_summary.client)
        );
        const plugin = await api.evaluateModule(
          source,
          signal,
          (name) => {
            throw Error('Unexpected external: ' + name);
          },
          (s) => URL.createObjectURL(new Blob([s], { type: 'text/javascript' })),
          (url) => URL.revokeObjectURL(url)
        );
        window.unmount = plugin.register();
      });
      assert.equal(await b.locator('output').textContent(), 'Verified clock');
      await b.evaluate(() => window.unmount());
      assert.equal(await b.locator('output').count(), 0);
      assert.equal(requests, before + 2);
    } finally {
      await browser.close();
    }
  }
} finally {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(dir, { recursive: true, force: true });
}
