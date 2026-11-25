// Real locked SDK + loopback ingestion. Run `pnpm test:posthog-browser` after
// installing Playwright Chromium/WebKit. --negative-control must fail.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter, on, once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'vite';
import { chromium, webkit } from '@playwright/test';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const sdkDir = fileURLToPath(
  new URL('./dist/', `file://${require.resolve('posthog-js/package.json')}`)
);
const result = await build({
  configFile: false,
  root,
  define: { 'import.meta.env': '{}', 'process.env.NODE_ENV': '"production"' },
  resolve: {
    alias: [
      { find: '@/components/error-boundary-fallback', replacement: 'fixture:boundary-fallback' },
      { find: '@', replacement: `${root}/src` },
      { find: 'posthog-js', replacement: 'fixture:posthog' },
    ],
  },
  plugins: [
    {
      name: 'locked-global-posthog',
      resolveId(id) {
        if (id === 'fixture:posthog' || id === 'fixture:boundary-fallback') return id;
      },
      load(id) {
        if (id === 'fixture:posthog') return 'export default window.posthog;';
        // Probe supplies fallbackRender; avoid bundling unrelated support UI.
        if (id === 'fixture:boundary-fallback')
          return 'export function ErrorBoundaryFallback() { throw new Error("probe requires fallbackRender"); }';
      },
    },
  ],
  build: {
    target: 'esnext',
    write: false,
    minify: false,
    lib: {
      entry: `${root}/tests/posthog-sync-stuck-browser.fixture.ts`,
      formats: ['es'],
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  worker: { format: 'es' },
  logLevel: 'error',
});
const bundle = (Array.isArray(result) ? result[0] : result).output.find(
  (file) => file.type === 'chunk'
).code;
const received = [];
const ingestion = new EventEmitter();
const handleRequest = async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (process.env.DEBUG_PROBE) console.log(req.method, url.pathname);
  if (url.pathname === '/fixture.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(bundle);
    return;
  }
  if (url.pathname === '/sdk.js' || url.pathname.startsWith('/static/')) {
    const file =
      url.pathname === '/sdk.js'
        ? url.searchParams.has('late')
          ? 'array.js'
          : 'array.full.js'
        : url.pathname.split('/').pop();
    try {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(await readFile(`${sdkDir}/${file}`));
    } catch {
      res.writeHead(404);
      res.end();
    }
    return;
  }
  const config = {
    featureFlags: {},
    sessionRecording: { endpoint: '/s/', sampleRate: 1, minimumDurationMilliseconds: 0 },
    supportedCompression: [],
  };
  if (url.pathname.startsWith('/array/')) {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(`window._POSTHOG_REMOTE_CONFIG={"synthetic-key":{config:${JSON.stringify(config)}}};`);
    return;
  }
  if (url.pathname.startsWith('/flags') || url.pathname.startsWith('/decide')) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(config));
    return;
  }
  if (req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    let events;
    try {
      events = JSON.parse(raw);
    } catch {
      events = JSON.parse(Buffer.from(new URLSearchParams(raw).get('data'), 'base64').toString());
    }
    received.push({ path: url.pathname, events: Array.isArray(events) ? events : [events] });
    ingestion.emit('batch');
    res.setHeader('Content-Type', 'application/json');
    res.end('{}');
    return;
  }
  // Network interception in WebKit can strip the body from sendBeacon's Blob.
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'");
  res.setHeader('Content-Type', 'text/html');
  res.end(
    `<!doctype html><button>interact</button><main></main><script src="/sdk.js${url.searchParams.has('late') ? '?late' : ''}"></script><script type="module" src="/fixture.js"></script>`
  );
};
const server = createServer((req, res) => {
  void handleRequest(req, res).catch((error) => res.destroy(error));
});

server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const negative = process.argv.includes('--negative-control');

async function observe(page, action, eventName) {
  if (process.env.DEBUG_PROBE) console.log('waiting for', eventName);
  const start = received.length;
  const batches = on(ingestion, 'batch', { signal: AbortSignal.timeout(10000) });
  try {
    await action();
    for await (const _ of batches) {
      const event = received
        .slice(start)
        .flatMap((request) => request.events)
        .find((event) => event.event === eventName);
      if (event) return event;
    }
  } finally {
    await batches.return();
  }
}

try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage();
      await page.goto(origin + '/SYNTHETIC_PRIVATE_PATH');
      await page.waitForFunction(() => !!window.POSTHOG_OPTIONS);
      if (!negative) {
        const before = received.length;
        const initialized = await page.evaluate(() => {
          window.__LODY_ELECTRON__ = true;
          window.scheduleDeferredPostHogInitialization('synthetic-key', {
            ...window.POSTHOG_OPTIONS,
            api_host: location.origin,
          });
          window.dispatchEvent(new Event('pagehide'));
          return !!window.posthog.__loaded;
        });
        assert.equal(initialized, false);
        assert.equal(received.length, before);
        await page.evaluate(() => window.writeDeviceUsageSharing(true));
      }
      await page.evaluate(
        ({ origin, negative }) => {
          document.title = 'SYNTHETIC_PRIVATE_TITLE';
          const init = negative
            ? window.posthog.init.bind(window.posthog)
            : window.scheduleDeferredPostHogInitialization;
          init('synthetic-key', {
            ...window.POSTHOG_OPTIONS,
            api_host: origin,
            opt_out_useragent_filter: true,
            disable_compression: true,
            ...(negative ? { before_send: (e) => e } : {}),
          });
          window.dispatchEvent(new Event('pagehide'));
        },
        { origin, negative }
      );
      await page.waitForFunction(() => window.posthog.__loaded);
      await page.evaluate(() => {
        window.posthog.register({ legacy: 'SYNTHETIC_PRIVATE_LEGACY' });
        window.installWorkspaceTelemetryScope(() => 'ordinary');
        window.setTelemetryRouteTarget('workspace', true);
      });
      const who = await observe(
        page,
        () =>
          page.evaluate(() => {
            window.posthog.identify('opaque_user_42', { email: 'SYNTHETIC_PRIVATE_EMAIL' });
            window.dispatchEvent(new Event('pagehide'));
          }),
        '$identify'
      );
      assert.equal(who.properties.distinct_id, 'opaque_user_42');
      const event = await observe(
        page,
        () =>
          page.evaluate(() => {
            window.posthog.capture(
              '$pageview',
              { title: document.title },
              { send_instantly: true }
            );
          }),
        '$pageview'
      );
      assert.ok(event.properties.$lib_version);
      const err = await observe(
        page,
        () =>
          page.evaluate(() => {
            window.posthog.captureException(new Error('SYNTHETIC_PRIVATE_STACK'));
            window.dispatchEvent(new Event('pagehide'));
          }),
        '$exception'
      );
      assert.ok(err.properties.$exception_list.length);
      await page.evaluate(() => {
        window.posthog.capture(
          '$snapshot',
          { snapshot_data: document.title },
          { send_instantly: true }
        );
      });
      if (!negative) {
        await observe(
          page,
          () =>
            page.evaluate(() => {
              window.boundary = window.mountBoundaryProbe();
              window.dispatchEvent(new Event('pagehide'));
            }),
          '$exception'
        );
        assert.match(await page.locator('main').innerText(), /BOUNDARY_SYNTHETIC_MESSAGE/);
        await page.evaluate(() => {
          window.boundary.recover();
          window.boundary.close();
        });
        await page.clock.install();
        await page.evaluate(async () => {
          window.stuckProbe = window.createWorkspaceSyncStuckProbe();
          await window.stuckProbe.render('runtime_missing');
        });
        await observe(
          page,
          async () => {
            await page.clock.fastForward(30001);
            await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
          },
          'workspace/sync_stuck'
        );
        await observe(
          page,
          () =>
            page.evaluate(async () => {
              await window.stuckProbe.render(null);
              window.dispatchEvent(new Event('pagehide'));
            }),
          'workspace/sync_stuck_resolved'
        );
      }
      if (!negative) {
        const first = received.length;
        await observe(
          page,
          () =>
            page.evaluate(() => {
              window.posthog.capture('app/active');
              window.writeDeviceUsageSharing(false);
              window.posthog.capture('app/launch', {}, { send_instantly: true });
              window.posthog.captureException(new Error('SYNTHETIC_PRIVATE_DISABLED'));
              window.dispatchEvent(new Event('pagehide'));
              window.writeDeviceUsageSharing(true);
              window.posthog.capture('session/open_in_ide_clicked', {}, { send_instantly: true });
            }),
          'session/open_in_ide_clicked'
        );
        const delivered = received
          .slice(first)
          .flatMap((request) => request.events)
          .map((event) => event.event);
        assert.ok(
          !delivered.includes('app/active') &&
            !delivered.includes('app/launch') &&
            !delivered.includes('$exception')
        );
        await page.evaluate(() => window.writeDeviceUsageSharing(false));
        await page.reload();
        await page.waitForFunction(() => !!window.POSTHOG_OPTIONS);
        assert.equal(
          await page.evaluate(() => {
            window.scheduleDeferredPostHogInitialization('synthetic-key', {
              ...window.POSTHOG_OPTIONS,
              api_host: location.origin,
            });
            window.dispatchEvent(new Event('pagehide'));
            return !!window.posthog.__loaded;
          }),
          false
        );
      }
      assert.doesNotMatch(
        JSON.stringify(received),
        /SYNTHETIC_PRIVATE|snapshot_data|BOUNDARY_SYNTHETIC|STUCK_.*?SECRET/
      );
      assert.ok(received.every((request) => request.path !== '/s/'));
    } finally {
      await browser.close();
    }
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}
