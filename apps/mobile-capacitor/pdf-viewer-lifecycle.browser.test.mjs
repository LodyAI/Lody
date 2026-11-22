import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { webkit } from '@playwright/test';
import { build, loadConfigFromFile, preview } from 'vite';

const mobileRoot = fileURLToPath(new URL('./', import.meta.url));
const requireFromMobile = createRequire(new URL('./package.json', import.meta.url));
const viewerPath = fileURLToPath(
  new URL(
    '../../packages/components/src/components/sessions/session-file-pdf-preview.tsx',
    import.meta.url
  )
);
const polyfillsPath = fileURLToPath(new URL('./src/polyfills.ts', import.meta.url));
const componentsSource = fileURLToPath(new URL('../../packages/components/src/', import.meta.url));

function makePdf() {
  const content = 'BT /F1 20 Tf 30 100 Td (PDF lifecycle works) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let text = '%PDF-1.4\n';
  const offsets = objects.map((body, index) => {
    const offset = text.length;
    text += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = text.length;
  text += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  text += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return [...new TextEncoder().encode(text)];
}

// Current WebKit with the newer APIs removed: validates the actual viewer owner,
// DOM listeners and rendering, not OS-version emulation or physical iOS acceptance.
void test('PDF preview teardown preserves other viewers and retires the last owner', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lody-pdf-viewer-lifecycle-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8"><style>html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script type="module" src="/boot.js"></script></body></html>`
  );
  await writeFile(
    join(root, 'boot.js'),
    `delete AbortSignal.any; delete Promise.withResolvers; import('./main.jsx');`
  );
  await writeFile(
    join(root, 'main.jsx'),
    `
    import ${JSON.stringify(polyfillsPath)};
    import React from ${JSON.stringify(requireFromMobile.resolve('react'))};
    import { createRoot } from ${JSON.stringify(requireFromMobile.resolve('react-dom/client'))};
    import { SessionFilePdfPreview } from ${JSON.stringify(viewerPath)};
    const originalAny = AbortSignal.any;
    const composites = [];
    const domListeners = [];
    const nativeAddEventListener = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function(type, listener, options) {
      if (options?.signal && (
        composites.some(({signal}) => signal === options.signal) ||
        ((this === document || this === window) &&
          ['selectionchange', 'pointerdown', 'pointerup', 'keyup', 'blur'].includes(type))
      )) {
        domListeners.push({ type, signal: options.signal });
      }
      return nativeAddEventListener.call(this, type, listener, options);
    };
    AbortSignal.any = function(signals) {
      const signal = originalAny.call(this, signals);
      const target = new EventTarget();
      const record = { signal, target, received: 0 };
      target.addEventListener('lifecycle-probe', () => { record.received++; }, {signal});
      composites.push(record);
      return signal;
    };
    const roots = new Map();
    window.openPdf = (id = 'a') => {
      if (roots.size === 0) {
        composites.length = 0;
        domListeners.length = 0;
      }
      const host = document.createElement('div');
      host.id = 'preview-' + id;
      host.style.cssText = 'position:relative;width:420px;height:650px;display:inline-block';
      document.getElementById('root').append(host);
      const root = createRoot(host);
      roots.set(id, {root, host});
      root.render(<SessionFilePdfPreview bytes={new Uint8Array(${JSON.stringify(makePdf())})} />);
    };
    window.closePdf = (id = 'a') => {
      const liveBefore = composites.filter(({signal}) => !signal.aborted).length;
      for (const {target} of composites) target.dispatchEvent(new Event('lifecycle-probe'));
      const before = composites.map(({received}) => received);
      const {root, host} = roots.get(id);
      root.unmount();
      host.remove();
      roots.delete(id);
      for (const {target} of composites) target.dispatchEvent(new Event('lifecycle-probe'));
      return {
        liveBefore,
        allAborted: composites.every(({signal}) => signal.aborted),
        domEvents: [...new Set(domListeners.map(({type}) => type))].sort(),
        domSignalsAborted: domListeners.every(({signal}) => signal.aborted),
        before,
        after: composites.map(({received}) => received),
        empty: document.getElementById('root').childElementCount === 0,
      };
    };
    window.openPdf();
  `
  );
  const { config } = await loadConfigFromFile(
    { command: 'build', mode: 'dev' },
    join(mobileRoot, 'vite.config.ts'),
    mobileRoot,
    'silent'
  );
  await build({
    ...config,
    configFile: false,
    root,
    logLevel: 'silent',
    resolve: {
      ...config.resolve,
      alias: [...config.resolve.alias, { find: /^@\//, replacement: componentsSource }],
    },
    build: {
      ...config.build,
      outDir: join(root, 'dist'),
      rollupOptions: { input: join(root, 'index.html') },
    },
  });
  const server = await preview({
    configFile: false,
    root,
    logLevel: 'silent',
    build: { outDir: join(root, 'dist') },
    preview: { host: '127.0.0.1', port: 0 },
  });
  t.after(() => new Promise((resolve) => server.httpServer.close(resolve)));
  const browser = await webkit.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  for (let index = 0; index < 2; index++) {
    if (index > 0) await page.evaluate(() => window.openPdf());
    await page
      .locator('.textLayer span')
      .filter({ hasText: 'PDF lifecycle works' })
      .waitFor({ state: 'visible' });
    const result = await page.evaluate(() => window.closePdf());
    assert.ok(result.liveBefore > 0, 'rendering should install live composite-signal listeners');
    assert.equal(result.allAborted, true, 'unmount must abort every PDF composite signal');
    for (const type of ['keydown', 'keyup', 'selectionchange', 'pointerdown']) {
      assert.ok(result.domEvents.includes(type), `PDF.js must install its real ${type} listener`);
    }
    assert.equal(result.domSignalsAborted, true, 'actual PDF DOM listener signals must abort');
    assert.deepEqual(
      result.after,
      result.before,
      'native DOM listeners must stop responding after unmount'
    );
    assert.equal(result.empty, true);
  }

  const waitForText = (id) =>
    page
      .locator(`#preview-${id} .textLayer span`)
      .filter({ hasText: 'PDF lifecycle works' })
      .waitFor({ state: 'visible' });
  const selectText = (id) =>
    page.evaluate((previewId) => {
      const text = document.querySelector(`#preview-${previewId} .textLayer span`);
      const layer = text.closest('.textLayer');
      const selection = document.getSelection();
      selection.removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
      const cleared = !layer.classList.contains('selecting');
      const range = document.createRange();
      range.selectNodeContents(text);
      selection.addRange(range);
      // Deliver the state change explicitly: no dependence on when WebKit queues
      // its native selectionchange notification relative to evaluate().
      document.dispatchEvent(new Event('selectionchange'));
      return {
        cleared,
        text: selection.toString(),
        selecting: layer.classList.contains('selecting'),
      };
    }, id);
  const assertSelection = async (id) => {
    assert.deepEqual(await selectText(id), {
      cleared: true,
      text: 'PDF lifecycle works',
      selecting: true,
    });
  };

  await page.evaluate(() => window.openPdf('a'));
  await waitForText('a');
  await page.evaluate(() => window.openPdf('b'));
  await waitForText('b');
  await assertSelection('b');
  await page.evaluate(() => {
    document.getSelection().removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page.evaluate(() => window.closePdf('a'));
  await assertSelection('b');
  const lastClose = await page.evaluate(() => window.closePdf('b'));
  assert.equal(lastClose.allAborted, true, 'the final viewer must release all composite owners');
  assert.equal(lastClose.domSignalsAborted, true, 'the final viewer must release global listeners');
  assert.equal(lastClose.empty, true);

  await page.evaluate(() => window.openPdf('c'));
  await waitForText('c');
  await assertSelection('c');
  const reopenedClose = await page.evaluate(() => window.closePdf('c'));
  assert.equal(reopenedClose.domSignalsAborted, true, 'reopened global listeners must also retire');
  assert.deepEqual(errors, []);
});
