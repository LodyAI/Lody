import { chromium, devices } from '@playwright/test';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
const args = Object.fromEntries(
  process.argv.slice(2).flatMap((v, i, a) => (v.startsWith('--') ? [[v.slice(2), a[i + 1]]] : []))
);
if (!args.phase || !args.storybook) throw Error('--phase and --storybook');
const root = path.resolve('artifacts/visual', args.phase);
await mkdir(path.join(root, 'shots'), { recursive: true });
const iframe = await (await fetch(new URL('/iframe.html', args.storybook))).text();
if (iframe.includes('/@vite/client')) throw Error('immutable build required');
const index = await (await fetch(new URL('/index.json', args.storybook))).json();
const hash = (x) => createHash('sha256').update(x).digest('hex');
const entries = [],
  failures = [],
  actions = [];
const cacheRoot = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const cachedShells = (await readdir(cacheRoot))
  .filter((entry) => /^chromium_headless_shell-\d+$/.test(entry))
  .sort((a, b) => Number(b.split('-').at(-1)) - Number(a.split('-').at(-1)));
const browser = await chromium.launch({
  executablePath: path.join(
    cacheRoot,
    cachedShells[0],
    'chrome-headless-shell-mac-arm64/chrome-headless-shell'
  ),
});
const browserVersion = browser.version();
const layout = () =>
  [
    ...document.querySelectorAll(
      '#storybook-root, #storybook-root *, [data-slot="drawer-content"], [data-slot="drawer-content"] *, [data-slot="drawer-overlay"]'
    ),
  ].map((e, i) => {
    const r = e.getBoundingClientRect(),
      s = getComputedStyle(e);
    return {
      path: String(i),
      tag: e.tagName.toLowerCase(),
      rect: [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 100) / 100),
      text: e.textContent?.trim().slice(0, 60),
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
for (const theme of ['light', 'dark'])
  for (const direction of ['bottom', 'top', 'left', 'right']) {
    const context = await browser.newContext({
      ...devices['Pixel 7'],
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    const storyId = 'ui-drawermigration--' + direction;
    const base = storyId + '__android__' + theme;
    try {
      await page.addInitScript(() => {
        window.__drawerEvents = [];
        for (const t of ['pointerdown', 'pointermove', 'pointerup', 'keydown'])
          document.addEventListener(
            t,
            (e) =>
              window.__drawerEvents.push({
                type: t,
                trusted: e.isTrusted,
                pointerType: e.pointerType,
                key: e.key,
              }),
            true
          );
      });
      const url = new URL('/iframe.html', args.storybook);
      url.search = new URLSearchParams({
        id: storyId,
        viewMode: 'story',
        globals: 'theme:' + theme + ';locale:en',
      });
      page.setDefaultTimeout(15000);
      await page.goto(url.href);
      await page.getByRole('button', { name: 'Open drawer', exact: true }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      const content = page.locator('[data-slot="drawer-content"]');
      const settle = async () => {
        await page.waitForFunction(() =>
          document
            .getAnimations()
            .filter((a) => a.effect?.getTiming().iterations !== Infinity)
            .every((a) => a.playState !== 'running')
        );
      };
      const shot = async (state) => {
        await settle();
        const key = base + '__' + state;
        await page.screenshot({
          path: path.join(root, 'shots', key + '.png'),
          animations: 'disabled',
          caret: 'hide',
        });
        entries.push({
          key,
          state,
          storyId,
          title: 'UI/DrawerMigration — native touch',
          viewport: 'android',
          theme,
          shot: 'shots/' + key + '.png',
          layout: await page.evaluate(layout),
        });
        actions.push({
          key,
          events: await page.evaluate(() => window.__drawerEvents),
          status: await page.getByRole('status').count(),
          content: await content.count(),
          viewport: await page.evaluate(() => ({
            width: innerWidth,
            height: innerHeight,
            visualHeight: visualViewport?.height,
            scale: visualViewport?.scale,
          })),
        });
      };
      const open = async () => {
        await page.evaluate(() => (window.__drawerOpenAt = performance.now()));
        await page.getByRole('button', { name: 'Open drawer', exact: true }).tap();
        await content.waitFor();
        await settle();
        await page.waitForFunction(() => {
          return performance.now() - window.__drawerOpenAt >= 510;
        });
      };
      await open();
      await shot('opened');
      const client = await context.newCDPSession(page);
      const touch = async (type, x, y) =>
        client.send('Input.dispatchTouchEvent', {
          type,
          touchPoints:
            type === 'touchEnd' ? [] : [{ x, y, id: 1, radiusX: 1, radiusY: 1, force: 1 }],
        });
      const r = await content.boundingBox();
      const p = { x: r.x + r.width / 2, y: r.y + 8 };
      const delta = {
        x: direction === 'left' ? -40 : direction === 'right' ? 40 : 0,
        y: direction === 'top' ? -40 : direction === 'bottom' ? 40 : 0,
      };
      await touch('touchStart', p.x, p.y);
      for (let i = 1; i <= 4; i++)
        await touch('touchMove', p.x + (delta.x * i) / 4, p.y + (delta.y * i) / 4);
      await page.waitForFunction(
        () => document.querySelector('[data-slot="drawer-content"]').style.transform !== ''
      );
      await shot('touch-drag-held');
      const distance = direction === 'left' || direction === 'right' ? r.width : r.height;
      const sign = direction === 'left' || direction === 'top' ? -1 : 1;
      for (let i = 1; i <= 6; i++) {
        const d = 40 + ((distance * 0.9 - 40) * i) / 6;
        await touch('touchMove', p.x + (delta.x ? sign * d : 0), p.y + (delta.y ? sign * d : 0));
      }
      await touch('touchEnd', 0, 0);
      await content.waitFor({ state: 'hidden' });
      await shot('touch-dismissed');
      await open();
      const cr = await content.boundingBox();
      const outside =
        direction === 'bottom'
          ? { x: 10, y: Math.max(1, cr.y / 2) }
          : direction === 'top'
            ? { x: 10, y: Math.min(840, cr.y + cr.height + 40) }
            : direction === 'left'
              ? { x: Math.min(385, cr.x + cr.width + 30), y: 50 }
              : { x: Math.max(5, cr.x - 30), y: 50 };
      await page.touchscreen.tap(outside.x, outside.y);
      await content.waitFor({ state: 'hidden' });
      await shot('overlay-dismissed');
      await open();
      await page.keyboard.press('Escape');
      await content.waitFor({ state: 'hidden' });
      await shot('escape-dismissed');
      const events = await page.evaluate(() => window.__drawerEvents);
      if (!events.some((e) => e.type === 'pointermove' && e.pointerType === 'touch' && e.trusted))
        throw Error('Missing trusted touch movement');
      if (!events.some((e) => e.type === 'keydown' && e.key === 'Escape' && e.trusted))
        throw Error('Missing trusted Escape');
    } catch (e) {
      failures.push({ key: base, message: String(e.stack ?? e) });
      await page
        .screenshot({ path: path.join(root, base + '-error.png'), caret: 'hide' })
        .catch(() => {});
    } finally {
      console.log(JSON.stringify({ case: base, count: entries.length, failures: failures.length }));
      await context.close();
    }
  }
await writeFile(
  path.join(root, 'manifest.json'),
  JSON.stringify(
    {
      phase: args.phase,
      browserVersion,
      baseUrl: args.storybook,
      buildFingerprint: hash(iframe + JSON.stringify(index)),
      harnessFingerprint: hash(await readFile(new URL(import.meta.url))),
      targets: {
        viewports: [{ name: 'android', width: 390, height: 844, device: 'Pixel 7' }],
        themes: ['light', 'dark'],
        ids: ['bottom', 'top', 'left', 'right'].map((x) => 'ui-drawermigration--' + x),
      },
      expected: 40,
      entries,
    },
    null,
    2
  )
);
await writeFile(path.join(root, 'failures.json'), JSON.stringify(failures, null, 2));
await writeFile(path.join(root, 'actions.json'), JSON.stringify(actions, null, 2));
console.log(JSON.stringify({ phase: args.phase, browserVersion, count: entries.length, failures }));
if (failures.length) process.exitCode = 1;
await browser.close();
