import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { webkit } from '@playwright/test';
import ts from 'typescript';

// This test deliberately uses real WebKit: Node's Request/fetch kept these
// signals alive, hiding the browser cancellation regression after GC.
const polyfillSource = ts.transpileModule(
  readFileSync(new URL('./polyfills.ts', import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
).outputText;
const pdfSource = ts.transpileModule(
  readFileSync(new URL('./pdf-abort-signals.ts', import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }
).outputText;

let browser;
let server;
let origin;
const responses = new Set();
const arrivals = new Map();
const waiters = new Map();

before(async () => {
  server = createServer((request, response) => {
    const path = request.url;
    if (path === '/') {
      response.end('<title>Mobile compatibility regression</title>');
      return;
    }
    arrivals.set(path, true);
    waiters.get(path)?.();
    if (path.startsWith('/complete')) {
      response.end('done');
      return;
    }
    responses.add(response);
    if (!path.startsWith('/headers')) {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.flushHeaders();
      response.write('first chunk');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await webkit.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  for (const response of responses) response.destroy();
  server?.closeAllConnections();
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function oldWebKitPage(t) {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(origin);
  await page.evaluate(() => {
    delete Promise.withResolvers;
    delete AbortSignal.any;
  });
  await page.addScriptTag({ content: polyfillSource });
  return page;
}

async function collect(page) {
  // Inspector Heap.gc is an explicit collection operation, not a timed sleep
  // or a heuristic allocation loop. Separate jobs also clear WeakRef keepalive.
  for (let index = 0; index < 4; index++) await page.requestGC();
}

for (const mode of ['headers', 'text', 'reader', 'clone-text', 'clone-reader']) {
  void test(
    `fetch retains cancellation through ${mode} after WebKit GC`,
    { timeout: 15_000 },
    async (t) => {
      const page = await oldWebKitPage(t);
      const path = `/${mode}`;
      const arrived = new Promise((resolve) => {
        if (arrivals.has(path)) resolve();
        else waiters.set(path, resolve);
      });
      await page.evaluate(
        async ({ mode: operation, path: requestPath }) => {
          globalThis.parentController = new AbortController();
          const signal = AbortSignal.any([globalThis.parentController.signal]);
          globalThis.signalRef = new WeakRef(signal);
          let consuming;
          if (operation === 'headers') {
            consuming = fetch(requestPath, { signal });
          } else {
            let response = await fetch(requestPath, { signal });
            if (operation.startsWith('clone')) response = response.clone();
            if (operation.endsWith('reader')) {
              const reader = response.body.getReader();
              await reader.read();
              consuming = reader.read();
            } else {
              consuming = response.text();
            }
          }
          // Only the returned promise survives this function. In particular, don't
          // retain the Response, reader, or signal in the test's globals.
          globalThis.outcome = consuming.then(
            () => ({ resolved: true }),
            (error) => ({ name: error.name, message: error.message })
          );
        },
        { mode, path }
      );
      await arrived;
      await collect(page);
      assert.equal(await page.evaluate(() => !!globalThis.signalRef.deref()), true);
      assert.equal(
        await page.evaluate(() => {
          const signal = globalThis.signalRef.deref();
          globalThis.parentController.abort(new DOMException('cancel probe', 'AbortError'));
          return signal.reason.message;
        }),
        'cancel probe'
      );
      // WebKit's native fetch currently returns its own AbortError message;
      // verify cancellation and preserve the custom reason on the signal.
      assert.equal((await page.evaluate(() => globalThis.outcome)).name, 'AbortError');
    }
  );
}

void test(
  'a completed fetch does not remain rooted by its long-lived source signal',
  { timeout: 15_000 },
  async (t) => {
    const page = await oldWebKitPage(t);
    await page.evaluate(async () => {
      globalThis.parentController = new AbortController();
      const signal = AbortSignal.any([globalThis.parentController.signal]);
      globalThis.signalRef = new WeakRef(signal);
      await (await fetch('/complete', { signal })).text();
    });
    await collect(page);
    assert.equal(await page.evaluate(() => !!globalThis.signalRef.deref()), false);
    assert.equal(await page.evaluate(() => globalThis.parentController.signal.aborted), false);
  }
);

void test(
  'PDF DOM listeners retain cancellation until owner abort, then release the signal',
  { timeout: 15_000 },
  async (t) => {
    const page = await oldWebKitPage(t);
    // Await module evaluation itself; inserting an inline module script does
    // not guarantee that its export is initialized before the next evaluate.
    await page.evaluate(
      async (moduleUrl) => {
        globalThis.pdfAbortSignalAny = (await import(moduleUrl)).pdfAbortSignalAny;
      },
      `data:text/javascript;base64,${Buffer.from(pdfSource).toString('base64')}`
    );
    await page.evaluate(() => {
      globalThis.parentController = new AbortController();
      const signal = globalThis.pdfAbortSignalAny([globalThis.parentController.signal]);
      globalThis.signalRef = new WeakRef(signal);
      globalThis.eventCalls = 0;
      document.addEventListener('pdf-probe', () => globalThis.eventCalls++, { signal });
    });
    await collect(page);
    assert.equal(await page.evaluate(() => !!globalThis.signalRef.deref()), true);
    assert.equal(
      await page.evaluate(() => {
        globalThis.parentController.abort();
        document.dispatchEvent(new Event('pdf-probe'));
        return globalThis.eventCalls;
      }),
      0
    );
    await collect(page);
    assert.equal(await page.evaluate(() => !!globalThis.signalRef.deref()), false);
    assert.equal(
      await page.evaluate(() => {
        const owner = new AbortController();
        owner.abort('already closed');
        return globalThis.pdfAbortSignalAny([owner.signal]).reason;
      }),
      'already closed'
    );
    await page.evaluate(() => {
      globalThis.emptySignalRef = new WeakRef(globalThis.pdfAbortSignalAny([]));
    });
    await collect(page);
    assert.equal(await page.evaluate(() => !!globalThis.emptySignalRef.deref()), false);
  }
);

void test(
  'Request callers can retain the original composite until body completion',
  { timeout: 15_000 },
  async (t) => {
    const page = await oldWebKitPage(t);
    await page.evaluate(async () => {
      globalThis.parentController = new AbortController();
      // Request.signal follows a distinct signal; holding only that copy is not
      // enough in WebKit. This is the required ownership contract for Request use.
      globalThis.requestOwnerSignal = AbortSignal.any([globalThis.parentController.signal]);
      globalThis.signalRef = new WeakRef(globalThis.requestOwnerSignal);
      const response = await fetch(
        new Request('/request-body', { signal: globalThis.requestOwnerSignal })
      );
      globalThis.outcome = response
        .text()
        .then(
          () => 'resolved',
          (error) => error.name
        )
        .finally(() => {
          globalThis.requestOwnerSignal = undefined;
        });
    });
    await collect(page);
    await page.evaluate(() => globalThis.parentController.abort());
    assert.equal(await page.evaluate(() => globalThis.outcome), 'AbortError');
    await collect(page);
    assert.equal(await page.evaluate(() => !!globalThis.signalRef.deref()), false);
  }
);
