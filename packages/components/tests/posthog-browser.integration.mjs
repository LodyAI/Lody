// Real locked SDK + loopback ingestion. Run `pnpm test:posthog-browser` after
// installing Playwright Chromium/WebKit. --negative-control must fail.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { gunzipSync } from 'node:zlib';
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
  resolve: { alias: { '@': `${root}/src` } },
  build: {
    target: 'esnext',
    write: false,
    minify: false,
    lib: { entry: `${root}/tests/posthog-browser.fixture.ts`, formats: ['es'] },
    rolldownOptions: { output: { codeSplitting: false } },
  },
  logLevel: 'error',
});
const bundle = (Array.isArray(result) ? result[0] : result).output.find(
  (file) => file.type === 'chunk'
).code;
const received = [];
let currentDistinctId;
let rejectNextSnapshot = false;
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
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/s/' && rejectNextSnapshot) {
      rejectNextSnapshot = false;
      res.writeHead(500);
    }
    res.end('{}');
    return;
  }
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
const allEvents = () =>
  received
    .flatMap((request) => request.events)
    .filter((event) => event.properties?.distinct_id === currentDistinctId);
const wire = () => JSON.stringify(allEvents());

async function setup(browser, shell = 'web', late = false, compressed = false) {
  const page = await browser.newPage({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
  });
  if (compressed)
    await page.addInitScript(() => {
      const Native = window.CompressionStream;
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      window.releaseCompression = release;
      window.compressionStarted = 0;
      window.compressionCompleted = 0;
      window.CompressionStream = class {
        constructor(format) {
          const stream = new Native(format);
          const writer = stream.writable.getWriter();
          this.readable = stream.readable;
          this.writable = new WritableStream({
            async write(chunk) {
              window.compressionStarted++;
              await gate;
              await writer.write(chunk);
            },
            async close() {
              await writer.close();
              window.compressionCompleted++;
            },
            abort(reason) {
              return writer.abort(reason);
            },
          });
        }
      };
    });
  let releaseScript;
  let scriptRequested;
  const requested = new Promise((resolve) => {
    scriptRequested = resolve;
  });
  const release = new Promise((resolve) => {
    releaseScript = resolve;
  });
  await page.route('**/*', async (route) => {
    if (!route.request().url().startsWith(origin)) return route.abort();
    if (
      late &&
      route.request().url().includes('/static/') &&
      route.request().url().includes('recorder')
    ) {
      scriptRequested();
      await release;
    }
    return route.continue();
  });
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => console.error('PAGE', error.message));
  await page.goto(origin + (late ? '/?late' : '/'));
  await page.waitForFunction(() => !!window.POSTHOG_OPTIONS);
  await page.evaluate(
    ({
      origin: receiverOrigin,
      shell: shellKind,
      negative: insecure,
      compressed: useCompression,
    }) => {
      if (shellKind === 'electron') window.__LODY_ELECTRON__ = true;
      if (shellKind === 'ios' || shellKind === 'android') {
        window.__LODY_NATIVE__ = true;
        window.__LODY_APP_INFO__ = { native_platform: shellKind };
      }
      window.observed = [];
      window.scope = null;
      window.installWorkspaceTelemetryScope(() => window.scope);
      window.setTelemetryRouteTarget('workspace', true);
      if (!insecure) window.postHogPrivacy.attach(window.posthog);
      const options = window.POSTHOG_OPTIONS;
      window.posthog.init('synthetic-key', {
        ...options,
        api_host: receiverOrigin,
        opt_out_useragent_filter: true,
        on_request_error: () => {
          window.requestFailures = (window.requestFailures ?? 0) + 1;
        },
        person_profiles: 'never',
        disable_compression: true,
        error_tracking: { __capturePostHogExceptions: true },
        session_recording: { ...options.session_recording, compress_events: useCompression },
        ...(insecure
          ? {
              disable_session_recording: false,
              before_send: (e) => e,
              session_recording: {
                ...options.session_recording,
                blockSelector: undefined,
                compress_events: false,
              },
            }
          : {}),
      });
      window.posthog.on('eventCaptured', (event) => window.observed.push(event));
      window.postHogPrivacy.sync(true);
      window.change = (scope) => {
        window.scope = scope;
        window.postHogPrivacy.sync();
      };
      window.privateDom = (label) => {
        document.querySelector('main').innerHTML =
          `<button title="${label}_TITLE" aria-label="${label}_ARIA"><img alt="${label}_ALT"><span>${label}_TEXT</span></button><aside data-private="${label}_BUFFER"></aside>`;
      };
      window.flush = () => {
        window.dispatchEvent(new Event('beforeunload'));
        window.dispatchEvent(new Event('pagehide'));
      };
    },
    { origin, shell, negative, compressed }
  );
  currentDistinctId = await page.evaluate(() => window.posthog.get_distinct_id());
  return { page, requested, releaseScript };
}

async function barrier(page) {
  const response = page.waitForResponse((res) => res.url().includes('/barrier/'));
  await page.evaluate(() => {
    window.flush();
    window.posthog.capture(
      'probe/barrier',
      {},
      { send_instantly: true, _url: location.origin + '/barrier/' }
    );
  });
  await response;
}
async function flushRecording(page) {
  await page.click('body > button');
  await page.evaluate(() => window.dispatchEvent(new Event('beforeunload')));
}
async function receiveRecording(page) {
  const response = page.waitForResponse((res) => res.url().includes('/s/'));
  await flushRecording(page);
  await barrier(page);
  await response;
}

try {
  for (const [name, engine, shells] of [
    ['chromium', chromium, ['web', 'electron', 'android']],
    ['webkit', webkit, ['web', 'ios']],
  ]) {
    const browser = await engine.launch({ headless: true });
    try {
      for (const shell of shells) {
        received.length = 0;
        const { page } = await setup(browser, shell);
        try {
          await page.evaluate(() => {
            window.privateDom('UNKNOWN_SECRET');
            window.capturedUnknown = window.posthog.captureException(
              new Error('UNKNOWN_EXCEPTION_SECRET'),
              { error_code: 'e2ee_feature_unavailable', extra: { file: 'UNKNOWN_EXTRA_SECRET' } }
            );
          });
          if (process.env.DEBUG_PROBE)
            console.log(
              'capture',
              await page.evaluate(() => ({
                result: window.capturedUnknown,
                exceptions: !!window.posthog.exceptions,
                config: window.posthog.config.capture_exceptions,
              }))
            );
          await barrier(page);
          assert.equal(
            allEvents().some((event) => event.event === '$snapshot'),
            false,
            `${name}/${shell}: unknown mode recorded`
          );
          assert.equal(wire().includes('UNKNOWN_'), false, 'unknown exception or DOM escaped');
          assert.ok(
            allEvents().some((event) => event.properties.error_code === 'e2ee_feature_unavailable')
          );

          await page.evaluate(() => {
            window.privateDom('PLAIN');
            window.change('account/plain/workspace');
          });
          await page.waitForFunction(() => window.posthog.sessionRecordingStarted());
          const ordinaryResponse = page.waitForResponse((response) =>
            response.url().includes('/s/')
          );
          await flushRecording(page);
          await page.evaluate(() =>
            window.posthog.captureException(new Error('ordinary error preserved'))
          );
          await barrier(page);
          await ordinaryResponse;
          assert.ok(
            allEvents().some((event) => event.event === '$snapshot'),
            'confirmed ordinary workspace must record'
          );
          assert.ok(wire().includes('ordinary error preserved'), 'ordinary errors unchanged');
          assert.equal(wire().includes('PLAIN_TITLE'), false, 'title defense');
          assert.equal(wire().includes('PLAIN_ALT'), false, 'alt defense');
          assert.equal(wire().includes('PLAIN_ARIA'), false, 'aria defense');

          // Put a real rrweb mutation into the SDK buffer, then into its request
          // queue. Change scope before that queue can send; a fresh recording
          // must never bless the old event object with a new generation.
          received.length = 0;
          await page.evaluate(() =>
            document.querySelector('aside').setAttribute('data-private', 'QUEUED_OLD_SECRET')
          );
          await page.evaluate(() => new Promise(requestAnimationFrame));
          await flushRecording(page);
          assert.ok(
            await page.evaluate(() =>
              JSON.stringify(window.observed).includes('QUEUED_OLD_SECRET')
            ),
            'mutation reached real recorder buffer'
          );
          await page.evaluate(() => {
            window.posthog.captureException(new Error('QUEUED_EXCEPTION_SECRET'), {
              arbitrary: { secret: 'QUEUED_EXTRA_SECRET' },
            });
            window.change(null);
            window.privateDom('E2EE_SECRET');
          });
          await barrier(page);
          assert.equal(
            allEvents().some((event) => event.event === '$snapshot'),
            false,
            'queued recording uploaded after pause'
          );
          assert.equal(wire().includes('QUEUED_'), false, 'queued exception was not redacted');
          await page.evaluate(() => {
            window.privateDom('RETURN');
            window.change('account/plain/workspace');
          });
          await page.waitForFunction(() => window.posthog.sessionRecordingStarted());
          await receiveRecording(page);
          assert.equal(wire().includes('QUEUED_'), false, 'old queue revived');
          assert.equal(wire().includes('E2EE_SECRET'), false, 'encrypted buffer revived');
          assert.ok(
            allEvents().some((event) => event.event === '$snapshot'),
            'ordinary replay must resume'
          );
          if (shell === 'web') {
            // A failed ordinary upload enters the SDK's real retry queue. After
            // pause/resume, pagehide must discard it rather than send it again.
            const failed = page.waitForResponse(
              (response) => response.url().includes('/s/') && response.status() === 500
            );
            rejectNextSnapshot = true;
            await page.evaluate(() => {
              const snapshot = window.observed.findLast((event) => event.event === '$snapshot');
              if (!snapshot) throw new Error('no real recorder frame');
              window.posthog.capture('$snapshot', snapshot.properties, {
                _url: location.origin + '/s/',
                send_instantly: true,
              });
            });
            await failed;
            await page.waitForFunction(() => window.requestFailures > 0);
            const oldIds = new Set(
              allEvents()
                .filter((event) => event.event === '$snapshot')
                .map((event) => event.uuid)
            );
            const beforeRetry = allEvents().filter((event) => oldIds.has(event.uuid)).length;
            await page.evaluate(() => {
              window.change(null);
              window.privateDom('RETRY_NEW');
              window.change('account/plain/workspace');
            });
            await page.waitForFunction(() => window.posthog.sessionRecordingStarted());
            await barrier(page);
            assert.equal(
              allEvents().filter((event) => oldIds.has(event.uuid)).length,
              beforeRetry,
              'old network retry revived'
            );
          }
          console.log(
            `${name}/${shell}: unknown, ordinary, attributes, buffered switch, resume, retry PASS`
          );
        } finally {
          await page.close();
        }
      }
      received.length = 0;
      const compressedPage = (await setup(browser, 'web', false, true)).page;
      try {
        await compressedPage.evaluate(() => {
          window.privateDom('COMPRESS_OLD_SECRET');
          window.change('account/plain/workspace');
        });
        await compressedPage.waitForFunction(() => window.compressionStarted > 0);
        await compressedPage.evaluate(() => {
          window.change(null);
          window.privateDom('COMPRESS_NEW');
          window.change('account/plain/workspace');
          window.releaseCompression();
        });
        await compressedPage.waitForFunction(() => window.compressionCompleted > 0);
        await receiveRecording(compressedPage);
        const expanded = JSON.stringify(allEvents(), (_key, value) => {
          if (
            typeof value === 'string' &&
            value.charCodeAt(0) === 31 &&
            value.charCodeAt(1) === 139
          ) {
            return JSON.parse(gunzipSync(Buffer.from(value, 'latin1')).toString());
          }
          return value;
        });
        assert.ok(expanded.includes('COMPRESS_NEW_BUFFER'), 'new compressed recording received');
        assert.equal(
          expanded.includes('COMPRESS_OLD_SECRET'),
          false,
          'old async compression revived'
        );
        console.log(`${name}: held native recording compression PASS`);
      } finally {
        await compressedPage.close();
      }
      received.length = 0;
      const { page, requested, releaseScript } = await setup(browser, 'web', true);
      try {
        await page.evaluate(() => {
          window.privateDom('SAFE');
          window.change('account/plain/workspace');
        });
        await Promise.race([requested, page.waitForRequest('**/static/*recorder*')]);
        await page.evaluate(() => {
          window.change(null);
          window.privateDom('LATE_UNKNOWN_SECRET');
        });
        releaseScript();
        await page.waitForFunction(() => !!window.__PosthogExtensions__?.initSessionRecording);
        await barrier(page);
        assert.equal(
          await page.evaluate(() => window.posthog.sessionRecordingStarted()),
          false,
          'late script restarted recording'
        );
        await page.evaluate(() => {
          window.privateDom('LATE_RETURN');
          window.change('account/plain/workspace');
        });
        await page.waitForFunction(() => window.posthog.sessionRecordingStarted());
        await receiveRecording(page);
        assert.equal(
          wire().includes('LATE_UNKNOWN_SECRET'),
          false,
          'late script retained unknown DOM'
        );
        console.log(`${name}: delayed recorder PASS`);
      } finally {
        releaseScript();
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}
