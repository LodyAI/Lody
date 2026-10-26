import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .flatMap((value, i, values) =>
      value.startsWith('--') ? [[value.slice(2), values[i + 1]]] : []
    )
);
if (!args.phase || !args.storybook) throw new Error('--phase and --storybook required');
const out = fileURLToPath(new URL(`../../artifacts/visual/${args.phase}/`, import.meta.url));
await mkdir(path.join(out, 'shots'), { recursive: true });
const hash = (value) => createHash('sha256').update(value).digest('hex');
const iframe = await (await fetch(new URL('/iframe.html', args.storybook))).text();
if (iframe.includes('/@vite/client')) throw new Error('Use an immutable Storybook build');
const index = await (await fetch(new URL('/index.json', args.storybook))).json();
const entries = [],
  failures = [],
  observations = [];
const scenes = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'phone', width: 390, height: 844 },
];
const cases = [
  { suffix: 'copy-success' },
  { suffix: 'copy-failure' },
  { suffix: 'long-translation' },
  { suffix: 'copy-success', runtimeVariables: true },
  { suffix: 'copy-success', scopedVariables: true },
];
const command = 'curl -fsSL https://bub.build/install.sh | bash -- --preset acp';
const docsUrl = 'https://bub.build/docs/tutorials/acp-server/?utm_source=lody';
const snapshot = () =>
  [...document.querySelectorAll('#storybook-root, #storybook-root *')].map((element, i) => {
    const rect = element.getBoundingClientRect(),
      style = getComputedStyle(element);
    return {
      path: String(i),
      tag: element.tagName.toLowerCase(),
      rect: [rect.x, rect.y, rect.width, rect.height].map((v) => Math.round(v * 100) / 100),
      text: element.textContent?.trim().slice(0, 120),
      scrollLeft: element.scrollLeft,
      scrollWidth: element.scrollWidth,
      ...Object.fromEntries(
        [
          'display',
          'padding',
          'margin',
          'gap',
          'minWidth',
          'flex',
          'userSelect',
          'fontFamily',
          'fontSize',
          'fontWeight',
          'lineHeight',
          'color',
          'backgroundColor',
          'borderRadius',
          'boxShadow',
          'overflowX',
          'whiteSpace',
        ].map((key) => [key, style[key]])
      ),
    };
  });
const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const viewport of scenes)
    for (const theme of ['light', 'dark'])
      for (const fixture of cases) {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: 1,
          reducedMotion: 'reduce',
          colorScheme: theme,
        });
        const page = await context.newPage();
        const storyId = `settings-bubinstallguidemigration--${fixture.suffix}`;
        const key = `${storyId}__${viewport.name}__${theme}${fixture.runtimeVariables ? '__runtime-vars' : ''}${fixture.scopedVariables ? '__scoped-vars' : ''}`;
        const externalRequests = [];
        try {
          await context.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (url.host !== new URL(args.storybook).host) {
              externalRequests.push(url.href);
              return route.abort();
            }
            return route.continue();
          });
          const url = new URL('/iframe.html', args.storybook);
          url.search = new URLSearchParams({
            id: storyId,
            viewMode: 'story',
            globals: `theme:${theme};locale:en`,
          });
          await page.goto(url.href);
          await page.locator('[data-bub-ports-ready="true"]').waitFor({ state: 'visible' });
          await page.evaluate(() => document.fonts.ready);
          if (fixture.runtimeVariables || fixture.scopedVariables)
            await page.evaluate((scoped) => {
              const scope = scoped
                ? document.querySelector('[data-bub-guide]')
                : document.documentElement;
              for (const [name, value] of Object.entries({
                '--spacing': '5px',
                '--radius-md': '13px',
                '--text-xs': '0.8125rem',
                '--text-xs--line-height': '1.6',
                '--muted': '145 50% 37%',
                '--muted-foreground': '270 55% 40%',
              }))
                scope.style.setProperty(name, value);
            }, fixture.scopedVariables === true);
          const copy = page.locator('[data-bub-guide] button[aria-label]');
          const docs = page.locator('[data-bub-guide] button:not([aria-label])');
          const code = page.locator('[data-bub-guide] code');
          await page.evaluate(async () => {
            for (const element of document.querySelectorAll('[data-bub-guide] *'))
              void getComputedStyle(element).font;
            await document.fonts.ready;
          });
          await page.waitForFunction(() => {
            const elements = [...document.querySelectorAll('[data-bub-guide] *')];
            const signature = JSON.stringify(
              elements.map((element) => {
                const rect = element.getBoundingClientRect(),
                  style = getComputedStyle(element);
                return [
                  rect.x,
                  rect.y,
                  rect.width,
                  rect.height,
                  element.scrollWidth,
                  style.font,
                  style.padding,
                  style.margin,
                  style.gap,
                  style.borderRadius,
                ];
              })
            );
            const previous = window.__bubStableGeometry ?? { signature: '', equal: 0 };
            previous.equal = previous.signature === signature ? previous.equal + 1 : 0;
            previous.signature = signature;
            window.__bubStableGeometry = previous;
            return previous.equal >= 3 && document.fonts.status === 'loaded';
          });
          const shot = async (state) => {
            const stateKey = `${key}__${state}`;
            await page.screenshot({
              path: path.join(out, 'shots', `${stateKey}.png`),
              animations: 'disabled',
              caret: 'hide',
            });
            entries.push({
              key: stateKey,
              storyId,
              title: 'Settings/Bub install — browser boundaries',
              state,
              viewport: viewport.name,
              theme,
              shot: `shots/${stateKey}.png`,
              layout: await page.evaluate(snapshot),
            });
          };
          const overflow = await code.evaluate((element) => {
            element.scrollLeft = element.scrollWidth;
            return {
              clientWidth: element.clientWidth,
              scrollWidth: element.scrollWidth,
              scrollLeft: element.scrollLeft,
            };
          });
          await page.waitForFunction(() => {
            const element = document.querySelector('[data-bub-guide] code');
            return Math.abs(element.scrollLeft - (element.scrollWidth - element.clientWidth)) <= 1;
          });
          if (viewport.name === 'phone')
            assert.ok(
              overflow.scrollWidth > overflow.clientWidth,
              'Phone code must overflow within its own box'
            );
          await shot('code-scrolled');
          await copy.hover();
          await page.mouse.down();
          await shot('pointer-held');
          await page.mouse.up();
          const expectedState = fixture.suffix === 'copy-failure' ? 'fallback-rejected' : 'success';
          await page
            .locator(`[data-bub-copy-state="${expectedState}"]`)
            .waitFor({ state: 'visible' });
          const copiedLabel =
            fixture.suffix === 'long-translation' ? 'Command copied / 命令已复制' : 'Copied';
          assert.equal(
            await copy.getAttribute('aria-label'),
            expectedState === 'success' ? copiedLabel : 'Copy'
          );
          const copied = JSON.parse(await page.locator('output').textContent());
          assert.equal(copied.clipboard, command);
          assert.equal(copied.external, '');
          await shot('copy-result');
          await docs.focus();
          await docs.press('Enter');
          await page.locator('[data-bub-external="requested"]').waitFor({ state: 'visible' });
          const result = JSON.parse(await page.locator('output').textContent());
          assert.equal(result.external, docsUrl);
          assert.equal(context.pages().length, 1, 'Docs intent must not open a live page');
          assert.deepEqual(externalRequests, [], 'Fixture must not make external requests');
          await shot('docs-intent');
          observations.push({
            key,
            overflow,
            result,
            runtimeVariables: !!fixture.runtimeVariables,
            scopedVariables: fixture.scopedVariables === true,
            externalRequests,
          });
        } catch (error) {
          const diagnostic = `shots/${key}__failure.png`;
          await page.screenshot({ path: path.join(out, diagnostic) }).catch(() => {});
          failures.push({ key, message: String(error.stack ?? error), diagnostic });
        } finally {
          await context.close();
        }
      }
} finally {
  await browser.close();
}
await writeFile(
  path.join(out, 'manifest.json'),
  JSON.stringify(
    {
      phase: args.phase,
      baseUrl: args.storybook,
      buildFingerprint: hash(iframe + JSON.stringify(index)),
      harnessFingerprint: hash(await readFile(fileURLToPath(import.meta.url))),
      targets: {
        viewports: scenes,
        themes: ['light', 'dark'],
        ids: cases,
        states: ['code-scrolled', 'pointer-held', 'copy-result', 'docs-intent'],
      },
      entries,
    },
    null,
    2
  )
);
await writeFile(path.join(out, 'observations.json'), JSON.stringify(observations, null, 2));
await writeFile(path.join(out, 'failures.json'), JSON.stringify(failures, null, 2));
console.log(`${entries.length} native frames; ${failures.length} failures`);
if (failures.length) process.exitCode = 1;
