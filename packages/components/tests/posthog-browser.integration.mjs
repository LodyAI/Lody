// Real locked SDK + loopback ingestion. Run `pnpm test:posthog-browser` after
// installing Playwright Chromium/WebKit. --negative-control must fail.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter, on, once } from 'node:events';
import { gunzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'vite';
import { chromium, webkit } from '@playwright/test';

const shortcutOnly = process.argv.includes('--shortcut-only');
const boundaryOnly = process.argv.includes('--boundary-only');
const dailyOnly = process.argv.includes('--daily-only');
const tokenDiagnosticsOnly = process.argv.includes('--token-diagnostics-only');
const stuckOnly = process.argv.includes('--stuck-only');
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
      // Boundary/deferred probes use the script SDK; sync-stuck keeps its real ESM singleton.
      ...(!stuckOnly ? [{ find: 'posthog-js', replacement: 'fixture:posthog' }] : []),
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
      entry: `${root}/tests/${stuckOnly ? 'posthog-sync-stuck-browser' : 'posthog-browser'}.fixture.ts`,
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
let currentDistinctId;
let rejectNextSnapshot = false;
let rejectNextBoundary = false;
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
    if (
      rejectNextBoundary &&
      events &&
      (Array.isArray(events) ? events : [events]).some(
        (event) => event.event === '$exception' && event.properties?.source === 'errorBoundary'
      )
    ) {
      rejectNextBoundary = false;
      res.writeHead(500);
    } else if (url.pathname === '/s/' && rejectNextSnapshot) {
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

async function setup(
  browser,
  shell = 'web',
  late = false,
  compressed = false,
  boundaryDeferred = false
) {
  const context = browser.newContext
    ? await browser.newContext({
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
      })
    : browser;
  const page = await context.newPage();
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
  if (boundaryDeferred) await page.clock.install();
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
      boundaryDeferred: deferBoundary,
      stuckOnly: useStuckClient,
    }) => {
      // The hook's deferred facade and the guarded transport must share one SDK.
      if (useStuckClient) window.posthog = window.stuckPostHog;
      if (shellKind === 'electron') window.__LODY_ELECTRON__ = true;
      if (shellKind === 'ios' || shellKind === 'android') {
        window.__LODY_NATIVE__ = true;
        window.__LODY_APP_INFO__ = { native_platform: shellKind };
      }
      window.__LODY_APP_INFO__ = { ...window.__LODY_APP_INFO__, app_version: '1.2.3' };
      window.observed = [];
      window.scope = null;
      window.installWorkspaceTelemetryScope(() => window.scope);
      window.setTelemetryRouteTarget('workspace', true);
      if (!insecure) window.postHogPrivacy.attach(window.posthog);
      window.failedRequest = new Promise((resolve) => {
        window.resolveFailedRequest = resolve;
      });
      const options = window.POSTHOG_OPTIONS;
      const init = deferBoundary
        ? window.scheduleDeferredPostHogInitialization
        : window.posthog.init.bind(window.posthog);
      init('synthetic-key', {
        ...options,
        api_host: receiverOrigin,
        opt_out_useragent_filter: true,
        // The test must measure our boundary, not the SDK's default burst limiter.
        rate_limiting: { events_per_second: 10000, events_burst_limit: 10000 },
        on_request_error: () => {
          window.requestFailures = (window.requestFailures ?? 0) + 1;
          window.resolveFailedRequest();
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
    { origin, shell, negative, compressed, boundaryDeferred, stuckOnly }
  );
  currentDistinctId = boundaryDeferred
    ? undefined
    : await page.evaluate(() => window.posthog.get_distinct_id());
  return { page, requested, releaseScript };
}

async function barrier(page) {
  // Observe the receiver, not a private SDK URL option (the locked SDK routes
  // capture requests to /e/). Subscribe before triggering the flush.
  const id = crypto.randomUUID();
  const batches = on(ingestion, 'batch', { signal: AbortSignal.timeout(10_000) });
  const delivered = (async () => {
    for await (const _ of batches) {
      // A cross-window probe can temporarily have different SDK identities.
      // The unique barrier ID identifies this request without borrowing another tab's ID.
      if (
        received
          .flatMap((request) => request.events)
          .some((event) => event.properties?.barrier_id === id)
      )
        return;
    }
  })();
  await page.evaluate((barrierId) => {
    window.flush();
    window.posthog.capture('probe/barrier', { barrier_id: barrierId }, { send_instantly: true });
  }, id);
  await delivered;
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

async function checkSyncStuck(page, label) {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
  currentDistinctId = await page.evaluate(() => {
    window.stuckProbe = window.createWorkspaceSyncStuckProbe();
    return window.stuckProbe.client.get_distinct_id();
  });
  const reports = () => allEvents().filter((event) => event.event === '$exception');
  const flush = async (expected = 0) => {
    const response = page.waitForResponse((res) => res.url().includes('/barrier/'));
    await page.evaluate(() => {
      window.flush();
      window.stuckProbe.client.capture(
        'probe/barrier',
        {},
        {
          send_instantly: true,
          _url: location.origin + '/barrier/',
        }
      );
    });
    await response;
    // Exception batches have their own queue; a barrier response alone is not
    // evidence that those batches reached the receiver.
    if (reports().length < expected) {
      try {
        for await (const _ of on(ingestion, 'batch', { signal: AbortSignal.timeout(15_000) })) {
          if (reports().length >= expected) break;
        }
      } catch {
        throw new Error(
          `${label}: expected ${expected} exception reports, received ${reports().length}`
        );
      }
    }
  };
  const render = (stage) => page.evaluate((value) => window.stuckProbe.render(value), stage);
  await render('runtime_missing');
  await page.clock.runFor(29_999);
  await flush();
  assert.equal(reports().length, 0, 'no premature report');
  // Progress between blockers must retain the original episode deadline.
  await render('doc_meta_scan_pending');
  await page.clock.runFor(1);
  await flush(1);
  assert.equal(reports().length, 1);
  assert.equal(reports()[0].properties.stage, 'doc_meta_scan_pending');
  await page.evaluate(() => window.stuckProbe.connection('reconnecting'));
  await render('doc_meta_scan_failed');
  await page.evaluate(() => window.stuckProbe.connection('online'));
  await page.clock.runFor(120_000);
  await flush();
  assert.equal(reports().length, 1, 'retries and stage changes do not create another report');
  const stages = [
    ['runtime_missing', 'unknown', 'unknown'],
    ['runtime_init_failed', 'rejected', 'unknown'],
    ['runtime_other_workspace', 'scope_mismatch', 'unknown'],
    ['doc_meta_scan_pending', 'unknown', 'unknown'],
    ['doc_meta_scan_failed', 'rejected', 'not_scheduled'],
    ['workspace_not_in_organizations', 'target_not_listed', 'unknown'],
    ['workspace_id_mismatch', 'scope_mismatch', 'unknown'],
  ];
  for (const [stage, failure, retry] of stages) {
    const expected = reports().length + 1;
    await render(null);
    await render(stage);
    await page.clock.runFor(30_000);
    await flush(expected);
    const properties = reports().at(-1).properties;
    assert.equal(properties.operation, 'workspace_sync');
    assert.equal(properties.stage, stage);
    assert.equal(properties.failure_kind, failure);
    assert.equal(properties.handling_state, 'observed');
    assert.equal(properties.retry_state, retry);
  }
  assert.equal(reports().length, 8, 'each recovered episode can report independently');
  await page.evaluate(() => {
    const error = new AggregateError(
      [new DOMException('STUCK_ABORT_SECRET', 'AbortError'), new Error('STUCK_CLEANUP_SECRET')],
      'STUCK_MIXED_SECRET'
    );
    window.stuckProbe.client.captureException(error, {
      operation: 'workspace_sync',
      stage: 'STUCK_STAGE_SECRET',
      failure_kind: 'STUCK_FAILURE_SECRET',
      handling_state: 'STUCK_HANDLING_SECRET',
      retry_state: 'STUCK_RETRY_SECRET',
      unexpected: 'STUCK_EXTRA_SECRET',
    });
  });
  await flush(9);
  assert.equal(reports().length, 9, 'mixed interruption/cleanup failure remains visible');
  for (const field of ['stage', 'failure_kind', 'handling_state', 'retry_state'])
    assert.equal(reports().at(-1).properties[field], 'unknown');
  assert.equal(
    wire().includes('STUCK_'),
    false,
    'no workspace, error, or unknown diagnostic text escapes'
  );
  await page.evaluate(() => window.stuckProbe.close());
  await flush();
  assert.equal(reports().length, 9, 'cleanup adds no exception');
  assert.equal(allEvents().filter((event) => event.event === 'workspace/sync_stuck').length, 8);
  assert.equal(
    allEvents().filter((event) => event.event === 'workspace/sync_stuck_resolved').length,
    8
  );
  console.log(`${label}: sync-stuck real hook + fake clock + SDK ingestion PASS`);
}

try {
  for (const [name, engine, shells] of [
    ['chromium', chromium, ['web', 'electron', 'android']],
    ['webkit', webkit, ['web', 'ios']],
  ]) {
    const browser = await engine.launch({ headless: true });
    try {
      if (!dailyOnly && !stuckOnly && !boundaryOnly && !shortcutOnly && !negative) {
        received.length = 0;
        const { page } = await setup(browser);
        try {
          await page.evaluate(() => {
            for (let attempt = 0; attempt < 100; attempt++) {
              window.logTokenProviderEvent({ type: 'fetch-cancelled', reason: 'owner_released' });
              window.logTokenProviderEvent({
                type: 'fetch-failure',
                workspaceId: 'synthetic-workspace',
                error: new TypeError('synthetic handled retry failure'),
              });
            }
            if (window.observed.some((event) => event.event === '$exception'))
              throw new Error('handled token diagnostics entered the SDK exception queue');
          });
          await barrier(page);
          const exceptions = () => allEvents().filter((event) => event.event === '$exception');
          assert.equal(exceptions().length, 0, 'retry/cancellation diagnostics sent exceptions');
          // Separate terminal episodes may share a message/fingerprint. Neither is hidden.
          for (let episode = 1; episode <= 2; episode++) {
            await page.evaluate(() => {
              window.posthog.captureException(new Error('synthetic unrecovered failure'));
            });
            await barrier(page);
            if (exceptions().length < episode) {
              for await (const _ of on(ingestion, 'batch', {
                signal: AbortSignal.timeout(15_000),
              })) {
                if (exceptions().length >= episode) break;
              }
            }
            assert.equal(exceptions().length, episode, 'terminal exception wire count changed');
          }
          assert.equal(new Set(exceptions().map((event) => event.uuid)).size, 2);
          const exceptionPosts = received.filter((request) =>
            request.events.some(
              (event) =>
                event.event === '$exception' && event.properties?.distinct_id === currentDistinctId
            )
          ).length;
          console.log(
            `${name}: 100 cancellations + 100 handled retry diagnostics -> 0 exceptions; two terminal captures -> 2 wire events in ${exceptionPosts} exception-bearing POSTs PASS`
          );
        } finally {
          await page.close();
        }
      }
      if (tokenDiagnosticsOnly) continue;
      if (!dailyOnly && !stuckOnly && !boundaryOnly && !negative) {
        received.length = 0;
        const { page } = await setup(browser);
        try {
          await page.evaluate(async () => {
            window.change('account/plain/workspace');
            window.shortcutReply = {
              ok: false,
              failure: { kind: 'retryable', code: 'exchange_unavailable', phase: 'exchange' },
            };
            window.shortcutRequest = {
              workspaceId: 'LOCAL_WORKSPACE_SECRET',
              target: { kind: 'body', bodyDocId: 'LOCAL_BODY_SECRET' },
              write: false,
            };
            window.shortcutOwner = new window.ShortcutTokenAttempts({
              attempt: async () => window.shortcutReply,
              legacy: async () => {
                throw new Error('unexpected fallback');
              },
              report: (failure) => {
                const diagnostic = window.shortcutTokenDiagnostic(failure);
                window.posthog.captureException(diagnostic.error, diagnostic.properties);
              },
              active: () => true,
              authRejected: () => {},
            });
            for (let i = 0; i < 100; i++)
              try {
                await window.shortcutOwner.grant(window.shortcutRequest);
              } catch (error) {
                // Exercise both explicit SDK capture and its global rejection listener.
                window.posthog.captureException(error);
                window.dispatchEvent(
                  new PromiseRejectionEvent('unhandledrejection', {
                    reason: error,
                    promise: Promise.resolve(),
                  })
                );
              }
          });
          const exceptions = () => allEvents().filter((event) => event.event === '$exception');
          const waitForExceptionCount = async (count) => {
            const batches = on(ingestion, 'batch', { signal: AbortSignal.timeout(10_000) });
            try {
              // The barrier simulates unload and stops the SDK poller. React /
              // deferred capture can commit later than page.evaluate returns;
              // observe capture completion before flushing that queue. Receipt
              // is still asserted at the HTTP receiver below.
              await page.waitForFunction(
                (expected) =>
                  window.observed.filter((event) => event.event === '$exception').length >=
                  expected,
                count
              );
              await barrier(page);
              while (exceptions().length < count) await batches.next();
            } catch (cause) {
              const captured = await page.evaluate(
                () => window.observed.filter((event) => event.event === '$exception').length
              );
              throw new Error(
                `${name}: expected ${count} Shortcut probe exceptions, received ${exceptions().length}, SDK captured ${captured}`,
                { cause }
              );
            } finally {
              await batches.return();
            }
          };
          await waitForExceptionCount(1);
          assert.equal(
            exceptions().length,
            1,
            '100 handled retries must send exactly one exception'
          );
          assert.equal(exceptions()[0].properties.error_code, 'shortcut_exchange_unavailable');
          assert.equal(exceptions()[0].properties.shortcut_phase, 'exchange');
          assert.equal(wire().includes('LOCAL_WORKSPACE_SECRET'), false);
          assert.equal(wire().includes('LOCAL_BODY_SECRET'), false);
          assert.deepEqual(await page.evaluate(() => window.shortcutOwner.counts()), [100]);
          await page.evaluate(async () => {
            window.shortcutReply = {
              ok: true,
              grant: {
                token: 'LOCAL_TOKEN_SECRET',
                expiresIn: 900,
                gatewayBaseUrl: 'https://gateway.test',
                streamId: 'LOCAL_BODY_SECRET',
              },
            };
            await window.shortcutOwner.grant(window.shortcutRequest);
            window.shortcutReply = {
              ok: false,
              failure: { kind: 'retryable', code: 'exchange_unavailable', phase: 'exchange' },
            };
            try {
              await window.shortcutOwner.grant(window.shortcutRequest);
            } catch (error) {
              window.posthog.captureException(error);
            }
            window.shortcutReply = {
              ok: false,
              failure: { kind: 'fatal', code: 'exchange_invalid', phase: 'exchange' },
            };
            try {
              await window.shortcutOwner.grant(window.shortcutRequest);
            } catch (error) {
              window.posthog.captureException(error);
            }
            window.shortcutOwner.dispose();
          });
          await waitForExceptionCount(3);
          assert.equal(
            exceptions().length,
            3,
            'recovery and a distinct fault each retain their diagnostic'
          );
          await page.evaluate(async () => {
            const peer = new window.ShortcutTokenAttempts({
              attempt: async () => window.shortcutReply,
              legacy: async () => {
                throw new Error('unexpected fallback');
              },
              report: (failure) => {
                const diagnostic = window.shortcutTokenDiagnostic(failure);
                window.posthog.captureException(diagnostic.error, diagnostic.properties);
              },
              active: () => true,
              authRejected: () => {},
            });
            try {
              await peer.grant(window.shortcutRequest);
            } catch (error) {
              window.posthog.captureException(error);
            }
            window.shortcutReply = {
              ok: false,
              failure: { kind: 'denied', code: 'unauthenticated', phase: 'authorize' },
            };
            for (let i = 0; i < 100; i++)
              try {
                await peer.grant(window.shortcutRequest);
              } catch (error) {
                window.posthog.captureException(error);
              }
            peer.dispose();
            window.posthog.captureException(new Error('Independent synthetic platform fault'));
          });
          await waitForExceptionCount(5);
          assert.equal(
            exceptions().length,
            5,
            'independent owner and unknown fault stay visible; expected auth denials add no exceptions'
          );
          assert.equal(wire().includes('LOCAL_TOKEN_SECRET'), false);
          assert.equal(
            allEvents().some((event) => event.event.startsWith('shortcut/')),
            false,
            'no per-retry analytics replacement'
          );
          await page.evaluate(() => {
            window.boundary = window.mountBoundaryProbe('shortcut');
            for (let i = 0; i < 100; i++) window.boundary.retry();
            window.captureShortcutProbe(window.shortcutProbeError());
          });
          await barrier(page);
          assert.equal(
            exceptions().length,
            5,
            'owned Shortcut failures add no boundary/deferred/global reports'
          );
          await page.evaluate(() => window.boundary.changeFailure('unknown'));
          await waitForExceptionCount(6);
          assert.equal(
            exceptions().length,
            6,
            'handled early return must not consume the boundary episode'
          );
          await page.evaluate(() => {
            window.boundary.recover();
            window.boundary.render();
          });
          assert.equal(await page.locator('main').textContent(), 'boundary recovered');
          await page.evaluate(() => window.boundary.changeFailure('mixed'));
          await waitForExceptionCount(7);
          assert.equal(
            exceptions().length,
            7,
            'independent cause in an owned root remains visible to boundary'
          );
          await page.evaluate(() => {
            window.boundary.close();
            window.captureShortcutProbe(window.shortcutProbeError(true));
          });
          await waitForExceptionCount(8);
          assert.equal(
            exceptions().length,
            8,
            'deferred capture must retain mixed independent causes'
          );
          await page.evaluate(() => {
            window.change(null);
            window.posthog.captureException(
              new AggregateError(
                [window.shortcutProbeError(), new Error('BOUNDARY_SYNTHETIC_GLOBAL_CAUSE')],
                'BOUNDARY_SYNTHETIC_GLOBAL_MIXED'
              )
            );
          });
          await waitForExceptionCount(9);
          assert.equal(
            exceptions().length,
            9,
            'SDK global path must retain a mixed exception chain'
          );
          assert.equal(
            wire().includes('BOUNDARY_SYNTHETIC_'),
            false,
            'boundary and restricted mixed diagnostics remain content-free'
          );
          console.log(
            `${name}: Shortcut 100 retries -> 1; recovery/distinct/independent -> 5; composed boundary/deferred/global mixed causes -> 9 PASS`
          );
        } finally {
          await page.close();
        }
      }
      if (shortcutOnly) continue;
      // Real product ErrorBoundary -> deferred controller -> locked SDK -> HTTP.
      // One failed upload retries the same UUID; React retries enqueue no extra event.
      if (!dailyOnly && !stuckOnly && !shortcutOnly && !negative) {
        for (const initialScope of [null, 'account/plain/workspace']) {
          received.length = 0;
          const { page } = await setup(browser, 'web', false, false, true);
          try {
            await page.evaluate((scope) => {
              window.change(scope);
              window.boundary = window.mountBoundaryProbe();
              window.boundary.render();
              for (let i = 0; i < 20; i++) window.boundary.retry();
            }, initialScope);
            assert.equal(
              received
                .flatMap((request) => request.events)
                .filter((event) => event.event === '$exception').length,
              0,
              'boundary stays deferred before startup'
            );
            rejectNextBoundary = true;
            const failed = page.waitForResponse((response) => response.status() === 500);
            await page.clock.runFor(15_050);
            currentDistinctId = await page.evaluate(() => window.posthog.get_distinct_id());
            await failed;
            await page.evaluate(() => window.failedRequest);
            await page.evaluate(() => {
              window.change(null);
              window.change('account/plain/workspace');
              // Simulate an old SDK queue entering the final transport directly.
              window.posthog._send_request({
                method: 'POST',
                url: location.origin + '/legacy-boundary/',
                data: {
                  event: 'app/error_boundary_triggered',
                  properties: { error_fingerprint: 'BOUNDARY_SYNTHETIC_HASH' },
                },
                callback: () => {
                  window.legacyBoundarySettled = true;
                },
              });
              window.posthog.capture('app/error_boundary_triggered', {
                error_type: 'BOUNDARY_SYNTHETIC_NAME',
                reason_code: 'BOUNDARY_SYNTHETIC_CODE',
                error_fingerprint: 'BOUNDARY_SYNTHETIC_HASH',
              });
            });
            assert.equal(await page.evaluate(() => window.legacyBoundarySettled), true);
            // Fake clock drives the SDK backoff, including its jitter, within its
            // bounded retry interval. HTTP response is the completion signal.
            const retried = page.waitForResponse((response) => response.url().includes('/e/'));
            await page.clock.runFor(30_000);
            await barrier(page);
            await retried;
            const boundaryEvents = () =>
              allEvents().filter(
                (event) =>
                  event.event === '$exception' && event.properties?.source === 'errorBoundary'
              );
            assert.equal(new Set(boundaryEvents().map((event) => event.uuid)).size, 1);
            assert.equal(
              boundaryEvents().length,
              2,
              'one upload plus one real SDK transport retry'
            );
            assert.equal(
              allEvents().filter((event) => event.event === '$exception').length,
              boundaryEvents().length,
              'no companion automatic exception'
            );
            assert.equal(wire().includes('BOUNDARY_SYNTHETIC_'), false);
            assert.equal(
              allEvents().some((event) => event.event === 'app/error_boundary_triggered'),
              false
            );
            assert.equal(await page.locator('main').textContent(), 'BOUNDARY_SYNTHETIC_MESSAGE');
            await page.evaluate(() => {
              window.boundary.recover();
            });
            assert.equal(await page.locator('main').textContent(), 'boundary recovered');
            await page.evaluate(() => window.boundary.fail());
            await barrier(page);
            assert.equal(
              new Set(boundaryEvents().map((event) => event.uuid)).size,
              2,
              'independent post-recovery failure remains visible'
            );
            assert.equal(wire().includes('BOUNDARY_SYNTHETIC_'), false);
            console.log(
              `${name}/${initialScope ? 'ordinary' : 'restricted'}: boundary deferred, retries, privacy, recovery PASS`
            );
          } finally {
            // Retire this probe's fake-clock context before other SDK modes run.
            await page.context().close();
          }
        }
      }
      if (boundaryOnly) continue;
      for (const shell of shells) {
        if (dailyOnly && shell === 'web') continue;
        received.length = 0;
        const { page } = await setup(browser, shell);
        try {
          if (stuckOnly) {
            await checkSyncStuck(page, `${name}/${shell}`);
            continue;
          }
          if (shell !== 'web' && !negative) {
            const { page: peer } = await setup(page.context(), shell);
            try {
              for (const windowPage of [page, peer])
                await windowPage.evaluate((platform) => {
                  window.dailyNow = 1000;
                  window.posthog.group('workspace', 'DAILY_WORKSPACE_SECRET');
                  window.daily = window.createIrohDaily({
                    now: () => window.dailyNow,
                    storage: localStorage,
                    exclusive: (run) => navigator.locks.request('daily-browser-test', run),
                    digest: async (text) =>
                      Array.from(
                        new Uint8Array(
                          await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
                        ),
                        (b) => b.toString(16).padStart(2, '0')
                      ).join(''),
                    random: () => crypto.randomUUID(),
                    online: () => true,
                    enqueue: (props, uuid) =>
                      !!window.posthog.capture('e2ee/iroh_daily', props, {
                        uuid,
                        $set: { workspaceId: 'DAILY_WORKSPACE_SECRET' },
                        $set_once: { url: location.href },
                      }),
                    platform: platform === 'electron' ? 'desktop' : platform,
                    version: () => '1.2.3',
                  });
                }, shell);
              await Promise.all(
                [page, peer].map((windowPage) =>
                  windowPage.evaluate(() =>
                    Promise.all(
                      Array.from({ length: 25 }, () =>
                        window.daily.record({
                          kind: 'dispatch',
                          outcome: 'iroh_ok',
                          target: 'DAILY_TARGET_SECRET',
                          elapsedMs: 100,
                          path: 'direct',
                        })
                      )
                    )
                  )
                )
              );
              await Promise.all(
                [page, peer].map((windowPage) =>
                  windowPage.evaluate(async () => {
                    window.dailyNow += 24 * 60 * 60 * 1000;
                    await window.daily.check();
                    await window.daily.check();
                    window.flush();
                  })
                )
              );
              await barrier(page);
              await barrier(peer);
              const daily = received
                .flatMap((entry) => entry.events)
                .filter((event) => event.event === 'e2ee/iroh_daily');
              assert.equal(daily.length, 1);
              assert.equal(daily[0].properties.dispatch_iroh_ok, 50);
              assert.equal(daily[0].properties.iroh_attempts, 50);
              assert.equal(daily[0].properties.iroh_ready, 50);
              assert.equal(daily[0].properties.iroh_success, 50);
              assert.equal(daily[0].properties.streams_attempts, 0);
              assert.equal(daily[0].properties.streams_success, 0);
              assert.equal(daily[0].properties.fallback_streams_attempts, 0);
              assert.equal(daily[0].properties.fallback_streams_success, 0);
              assert.equal(daily[0].properties.dispatch_direct, 50);
              assert.equal(daily[0].properties.platform, shell === 'electron' ? 'desktop' : shell);
              assert.equal(daily[0].properties.$groups, undefined);
              assert.equal(daily[0].$set, undefined);
              assert.equal(daily[0].$set_once, undefined);
              assert.equal(daily[0].properties.$geoip_disable, true);
              assert(!JSON.stringify(daily[0]).includes('DAILY_WORKSPACE_SECRET'));
              assert(!JSON.stringify(daily[0]).includes('DAILY_TARGET_SECRET'));
              assert(!JSON.stringify(daily[0]).includes(origin));
              console.log(`${name}/${shell}: daily real SDK + cross-window Web Locks PASS`);
            } finally {
              await page.evaluate(() => window.posthog.resetGroups());
              await peer.close();
            }
            currentDistinctId = await page.evaluate(() => window.posthog.get_distinct_id());
          }
          if (dailyOnly) continue;
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
          const unknownArrived = () =>
            allEvents().some((event) => event.properties.error_code === 'e2ee_feature_unavailable');
          if (!negative && !unknownArrived()) {
            for await (const _ of on(ingestion, 'batch', { signal: AbortSignal.timeout(15_000) })) {
              if (unknownArrived()) break;
            }
          }
          assert.equal(
            allEvents().some((event) => event.event === '$snapshot'),
            false,
            `${name}/${shell}: unknown mode recorded`
          );
          assert.equal(wire().includes('UNKNOWN_'), false, 'unknown exception or DOM escaped');
          assert.ok(
            allEvents().some((event) => event.properties.error_code === 'e2ee_feature_unavailable')
          );

          if (!negative) {
            await page.evaluate(() => {
              window.posthog.captureException(new TypeError('CATEGORY_PRIVATE_TYPE'));
              window.posthog.captureException(new RangeError('CATEGORY_PRIVATE_RANGE'));
            });
            await barrier(page);
            const categoriesArrived = () =>
              ['TypeError', 'RangeError'].every((type) =>
                allEvents().some((event) => event.properties.error_type === type)
              );
            if (!categoriesArrived()) {
              for await (const _ of on(ingestion, 'batch', {
                signal: AbortSignal.timeout(15_000),
              })) {
                if (categoriesArrived()) break;
              }
            }
            const restricted = allEvents().filter((event) => event.event === '$exception');
            const type = restricted.find((event) => event.properties.error_type === 'TypeError');
            const range = restricted.find((event) => event.properties.error_type === 'RangeError');
            assert.ok(type && range, 'restricted built-in categories reach ingestion');
            assert.notEqual(
              type.properties.$exception_fingerprint,
              range.properties.$exception_fingerprint
            );
            assert.equal(type.properties.app_version, '1.2.3');
            assert.equal(
              type.properties.platform,
              shell === 'web' ? 'web' : shell === 'electron' ? 'electron' : 'mobile'
            );
            assert.equal(wire().includes('CATEGORY_PRIVATE_'), false);
          }

          await page.evaluate(() => {
            window.privateDom('PLAIN');
            window.change('account/plain/workspace');
          });
          await page.waitForFunction(() => window.posthog.sessionRecordingStarted());
          const ordinaryResponse = page.waitForResponse((response) =>
            response.url().includes('/s/')
          );
          await flushRecording(page);
          const ordinaryUuid = await page.evaluate(
            () => window.posthog.captureException(new Error('ordinary error preserved'))?.uuid
          );
          assert.ok(ordinaryUuid, 'ordinary exception accepted by SDK');
          await barrier(page);
          await ordinaryResponse;
          // Exceptions have their own SDK batch; a replay/barrier response does
          // not establish that this event has reached the loopback receiver.
          if (!allEvents().some((event) => event.uuid === ordinaryUuid)) {
            for await (const _ of on(ingestion, 'batch', { signal: AbortSignal.timeout(15_000) })) {
              if (allEvents().some((event) => event.uuid === ordinaryUuid)) break;
            }
          }
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
      if (dailyOnly || stuckOnly) continue;
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
