import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { webkit } from '@playwright/test';
import { build, createServer, loadConfigFromFile } from 'vite';
import { diffCssCompatPlugin } from './vite-diff-css-compat.ts';

// Run with an installed Playwright WebKit. This checks transform semantics in
// current WebKit; it does not impersonate or replace a real iOS 16.4 device.
void test('diff colors survive lowering across system and forced app themes', async () => {
  const entry = realpathSync(
    new URL('../../packages/components/node_modules/@pierre/diffs/dist/style.js', import.meta.url)
  );
  const original = (await import(pathToFileURL(entry).href)).default;
  const wrapperEntry = fileURLToPath(new URL('./utils/cssWrappers.js', pathToFileURL(entry)));
  const { wrapThemeCSS: originalTheme } = await import(pathToFileURL(wrapperEntry).href);
  const output = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [diffCssCompatPlugin()],
    build: { write: false, minify: false, lib: { entry, formats: ['es'] } },
  });
  const chunk = output[0].output.find((item) => item.type === 'chunk');
  const compatible = (
    await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`)
  ).default;
  const wrapperOutput = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [diffCssCompatPlugin()],
    build: { write: false, minify: false, lib: { entry: wrapperEntry, formats: ['es'] } },
  });
  const wrapperChunk = wrapperOutput[0].output.find((item) => item.type === 'chunk');
  const { wrapThemeCSS: compatibleTheme } = await import(
    `data:text/javascript;base64,${Buffer.from(wrapperChunk.code).toString('base64')}`
  );

  const browser = await webkit.launch({ headless: true });
  try {
    for (const system of ['light', 'dark']) {
      const page = await browser.newPage({ colorScheme: system });
      try {
        for (const appTheme of ['light', 'dark', 'system']) {
          const samples = [];
          for (const stylesheet of [
            original + originalTheme('', appTheme),
            compatible + compatibleTheme('', appTheme),
          ]) {
            samples.push(
              await page.evaluate(
                ({ css, theme }) => {
                  document.body.replaceChildren();
                  const host = document.createElement('div');
                  document.body.append(host);
                  host.style.cssText =
                    '--diffs-light:#112233;--diffs-dark:#ddeeff;' +
                    '--diffs-light-bg:#fff;--diffs-dark-bg:#111;' +
                    '--diffs-light-addition-color:#007700;--diffs-dark-addition-color:#66ff66';
                  const root = host.attachShadow({ mode: 'open' });
                  const sheet = new CSSStyleSheet();
                  sheet.replaceSync(css);
                  root.adoptedStyleSheets = [sheet];
                  root.innerHTML = `
                    <pre data-diffs data-type="file" data-background ${theme === 'system' ? '' : `data-theme-type="${theme}"`}>
                      <code data-code>
                        <div data-line data-line-type="context" data-selected-line>
                          <span data-column-number>1</span>
                          <span data-column-content><span style="--diffs-token-light:#aa0000;--diffs-token-dark:#00aa00">token</span></span>
                        </div>
                        <div data-line data-line-type="change-addition">
                          <span data-column-number>2</span><span data-column-content>added</span>
                        </div>
                        <div data-line data-line-type="change-deletion">
                          <span data-column-number>3</span><span data-column-content>removed</span>
                        </div>
                      </code>
                    </pre>`;
                  return [
                    '[data-diffs]',
                    '[data-column-content] span',
                    '[data-selected-line] [data-column-content]',
                    '[data-selected-line] [data-column-number]',
                    '[data-line-type="change-addition"] [data-column-content]',
                    '[data-line-type="change-deletion"] [data-column-content]',
                  ].map((selector) => {
                    const style = getComputedStyle(root.querySelector(selector));
                    return {
                      selector,
                      color: style.color,
                      background: style.backgroundColor,
                      columns: style.gridTemplateColumns,
                    };
                  });
                },
                { css: stylesheet, theme: appTheme }
              )
            );
          }
          assert.deepEqual(samples[1], samples[0], `system=${system}, app=${appTheme}`);
          const effectiveTheme = appTheme === 'system' ? system : appTheme;
          assert.equal(
            samples[1][1].color,
            effectiveTheme === 'light' ? 'rgb(170, 0, 0)' : 'rgb(0, 170, 0)',
            `token follows the selected theme: system=${system}, app=${appTheme}`
          );
        }
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});

void test('mobile development loads the diff worker module and lowers its stylesheet', async (t) => {
  const mobileRoot = fileURLToPath(new URL('./', import.meta.url));
  const workerModule = fileURLToPath(
    new URL('../../packages/components/src/ui/diff-viewer/diff-render-worker.ts', import.meta.url)
  );
  const stylesheet = realpathSync(
    new URL('../../packages/components/node_modules/@pierre/diffs/dist/style.js', import.meta.url)
  );
  const cacheDir = await mkdtemp(join(tmpdir(), 'lody-mobile-diff-dev-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  const { config } = await loadConfigFromFile(
    { command: 'serve', mode: 'dev' },
    join(mobileRoot, 'vite.config.ts'),
    mobileRoot,
    'silent'
  );
  const server = await createServer({
    ...config,
    configFile: false,
    root: join(mobileRoot, 'src'),
    cacheDir,
    logLevel: 'silent',
    // Exercise the real dev pipeline and dependencies, without starting the
    // authenticated app or scanning unrelated routes in this focused fixture.
    optimizeDeps: { ...config.optimizeDeps, entries: [workerModule] },
    server: { host: '127.0.0.1', port: 0 },
    plugins: [
      ...config.plugins,
      {
        name: 'diff-dev-test-page',
        configureServer(vite) {
          vite.middlewares.use('/__diff_compat__', (_request, response) => {
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><title>Diff development compatibility</title>');
          });
        },
      },
    ],
  });
  t.after(() => server.close());
  await server.listen();
  const browser = await webkit.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__diff_compat__`);
  const result = await page.evaluate(
    async ({ workerUrl, stylesheetUrl }) => {
      const worker = await import(workerUrl);
      const { default: css } = await import(stylesheetUrl);
      return { createPool: typeof worker.createDiffRenderWorkerPool, css };
    },
    {
      workerUrl: `/@fs${workerModule}`,
      // Explicitly exercise the versioned URL that Vite serves for excluded
      // dependencies, independently of whether its scanner adds one here.
      stylesheetUrl: `/@fs${stylesheet}?v=compat-probe`,
    }
  );
  assert.equal(result.createPool, 'function');
  assert.ok(!result.css.includes('light-dark('), 'dev CSS must also pass through compatibility');
});
