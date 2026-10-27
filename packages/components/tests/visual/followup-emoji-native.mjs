/** Real bundled-data loading, scrolling and keyboard evidence for frimousse. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .flatMap((t, i, all) => (t.startsWith('--') ? [[t.slice(2), all[i + 1]]] : []))
);
if (!args.phase || !args.storybook) throw new Error('--phase and --storybook required');
const out = fileURLToPath(new URL(`../../artifacts/visual/${args.phase}/`, import.meta.url));
await mkdir(path.join(out, 'shots'), { recursive: true });
const hash = (value) => createHash('sha256').update(value).digest('hex');
const iframe = await (await fetch(new URL('/iframe.html', args.storybook))).text();
if (iframe.includes('/@vite/client')) throw new Error('Immutable static build required');
const index = await (await fetch(new URL('/index.json', args.storybook))).json();
const entries = [],
  failures = [],
  actions = [];
const browser = await chromium.launch({ channel: 'chrome' });
const viewports = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'compact', width: 390, height: 844 },
];
const themes = ['light', 'dark'];
const snapshot = () =>
  [...document.querySelectorAll('#storybook-root, #storybook-root *')].map((el, i) => {
    const r = el.getBoundingClientRect(),
      s = getComputedStyle(el);
    return {
      path: String(i),
      tag: el.tagName.toLowerCase(),
      rect: [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 100) / 100),
      text: (el.textContent ?? '').trim().slice(0, 60),
      ...Object.fromEntries(
        [
          'fontSize',
          'fontFamily',
          'fontWeight',
          'lineHeight',
          'color',
          'backgroundColor',
          'borderRadius',
          'boxShadow',
          'opacity',
        ].map((k) => [k, s[k]])
      ),
    };
  });
for (const viewport of viewports)
  for (const theme of themes) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const storyId = 'ui-emojipickermigration--inline',
      key = `${storyId}__${viewport.name}__${theme}`;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const requests = [];
    try {
      await page.addInitScript(() => {
        window.__emojiInputs = [];
        for (const type of ['wheel', 'keydown', 'pointerdown'])
          document.addEventListener(
            type,
            (e) => window.__emojiInputs.push({ type, trusted: e.isTrusted, key: e.key ?? null }),
            true
          );
      });
      await page.route('**/emojibase/**', async (route) => {
        requests.push({ url: route.request().url(), method: route.request().method() });
        await gate;
        await route.continue();
      });
      const url = new URL('/iframe.html', args.storybook);
      url.search = new URLSearchParams({
        id: storyId,
        viewMode: 'story',
        globals: `theme:${theme};locale:en`,
      });
      await page.goto(url.href);
      const loading = page.locator('[data-slot="emoji-picker-loading"]');
      await loading.waitFor({ state: 'visible' });
      await page.evaluate(() => document.fonts.ready);
      const shot = async (state) => {
        await page.waitForFunction(() =>
          document
            .getAnimations()
            .filter((a) => a.effect?.getTiming().iterations !== Infinity)
            .every((a) => a.playState !== 'running')
        );
        const stateKey = `${key}__${state}`;
        await page.screenshot({
          path: path.join(out, 'shots', `${stateKey}.png`),
          animations: 'disabled',
          caret: 'hide',
        });
        entries.push({
          key: stateKey,
          state,
          storyId,
          title: 'Ui/EmojiPickerMigration — native controls',
          viewport: viewport.name,
          theme,
          shot: `shots/${stateKey}.png`,
          layout: await page.evaluate(snapshot),
        });
        actions.push({
          key: stateKey,
          requests: [...requests],
          events: await page.evaluate(() => window.__emojiInputs),
          state: await page.evaluate(() => {
            const v = document.querySelector('[data-slot="emoji-picker-viewport"]'),
              h = [
                ...document.querySelectorAll('[data-slot="emoji-picker-category-header"]'),
              ].filter((e) => getComputedStyle(e).visibility !== 'hidden');
            return {
              scrollTop: v.scrollTop,
              scrollHeight: v.scrollHeight,
              clientHeight: v.clientHeight,
              visibleRows: document.querySelectorAll('[frimousse-row][role="row"]').length,
              headers: h.map((e) => ({
                text: e.textContent,
                rect: e.getBoundingClientRect().toJSON(),
                background: getComputedStyle(e).backgroundColor,
              })),
              selected: document.querySelector('[data-emoji-result]').textContent,
              active: [
                ...document.querySelectorAll('[data-slot="emoji-picker-emoji"][data-active]'),
              ].map((e) => ({
                label: e.getAttribute('aria-label'),
                background: getComputedStyle(e).backgroundColor,
              })),
              spinner: [...document.querySelectorAll('[data-slot="spinner"]')].map((e) =>
                e.getBoundingClientRect().toJSON()
              ),
            };
          }),
        });
      };
      await shot('loading');
      release();
      await page
        .locator('[data-slot="emoji-picker-emoji"]:visible')
        .first()
        .waitFor({ state: 'visible' });
      await loading.waitFor({ state: 'hidden' });
      const vp = page.locator('[data-slot="emoji-picker-viewport"]');
      await vp.hover();
      await page.mouse.wheel(0, 420);
      await page.waitForFunction(
        () => document.querySelector('[data-slot="emoji-picker-viewport"]').scrollTop === 420
      );
      await page.mouse.move(0, 0);
      await shot('wheel-sticky');
      // Keep keyboard navigation independent of the original filter-after-scroll behavior.
      await page.reload();
      await page.locator('[data-slot="emoji-picker-emoji"]:visible').first().waitFor();
      await page.locator('[data-slot="emoji-picker-search"]').fill('heart');
      await page.locator('[data-slot="emoji-picker-emoji"]:visible').first().waitFor();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-slot="emoji-picker-list"]')
            ?.getAttribute('aria-rowcount') === '9' &&
          document.querySelector('[data-slot="emoji-picker-viewport"]').scrollTop === 0
      );
      await page.locator('[data-slot="emoji-picker-search"]').press('ArrowDown');
      await page.locator('[data-slot="emoji-picker-emoji"][data-active]:visible').first().waitFor();
      await shot('keyboard-active');
      await page.locator('[data-slot="emoji-picker-search"]').press('Enter');
      await page.waitForFunction(
        () => document.querySelector('[data-emoji-result]').textContent !== 'Selected: none'
      );
      await shot('keyboard-selected');
      await page.emulateMedia({ forcedColors: 'active' });
      await shot('forced-colors');
    } catch (error) {
      failures.push({ key, message: String(error.stack ?? error) });
    } finally {
      release();
      await context.close();
    }
  }
await browser.close();
await writeFile(
  path.join(out, 'manifest.json'),
  JSON.stringify(
    {
      phase: args.phase,
      baseUrl: args.storybook,
      buildFingerprint: hash(iframe + JSON.stringify(index)),
      harnessFingerprint: hash(await readFile(fileURLToPath(import.meta.url))),
      targets: {
        viewports,
        themes,
        ids: ['ui-emojipickermigration--inline'],
        states: [
          'loading',
          'wheel-sticky',
          'keyboard-active',
          'keyboard-selected',
          'forced-colors',
        ],
      },
      expected: viewports.length * themes.length * 5,
      capturedAt: new Date().toISOString(),
      entries,
    },
    null,
    2
  )
);
await writeFile(path.join(out, 'failures.json'), JSON.stringify(failures, null, 2));
await writeFile(path.join(out, 'actions.json'), JSON.stringify(actions, null, 2));
console.log(`${entries.length} native frames; ${failures.length} failures`);
if (failures.length) process.exitCode = 1;
