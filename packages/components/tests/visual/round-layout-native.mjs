import { chromium, devices } from '@playwright/test';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const base = process.env.LODY_LAYOUT_URL ?? 'http://127.0.0.1:6036';
const phase = process.env.LODY_LAYOUT_PHASE ?? 'round-layout-native-before';
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = new URL(`./artifacts/visual/${phase}/`, new URL(`file://${packageRoot}/`));
await mkdir(out, { recursive: true });
async function launchBrowser() {
  if (process.env.LODY_CHROMIUM_PATH)
    return chromium.launch({ executablePath: process.env.LODY_CHROMIUM_PATH });
  try {
    return await chromium.launch();
  } catch (error) {
    const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
    const candidates = existsSync(cache)
      ? (await readdir(cache))
          .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
          .sort((a, b) => Number(b.split('-').at(-1)) - Number(a.split('-').at(-1)))
      : [];
    for (const entry of candidates) {
      const shell = path.join(
        cache,
        entry,
        'chrome-headless-shell-mac-arm64/chrome-headless-shell'
      );
      if (existsSync(shell)) return chromium.launch({ executablePath: shell });
    }
    throw error;
  }
}
const browser = await launchBrowser();
const buildFingerprint = createHash('sha256')
  .update(await (await fetch(new URL('/iframe.html', base))).text())
  .update(JSON.stringify(await (await fetch(new URL('/index.json', base))).json()))
  .digest('hex');
const runnerFingerprint = createHash('sha256')
  .update(await readFile(fileURLToPath(import.meta.url)))
  .digest('hex');
async function installInput(context) {
  await context.addInitScript(() => {
    window.__layoutInput = [];
    for (const type of [
      'pointerdown',
      'pointermove',
      'pointerup',
      'touchstart',
      'touchmove',
      'touchend',
      'wheel',
      'keydown',
    ])
      document.addEventListener(
        type,
        (e) =>
          window.__layoutInput.push({
            type,
            isTrusted: e.isTrusted,
            pointerType: e.pointerType ?? null,
            key: e.key ?? null,
          }),
        true
      );
  });
}
const results = [];
async function stable(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    let previous = '',
      count = 0;
    for (let i = 0; i < 240; i++) {
      await new Promise(requestAnimationFrame);
      const next = JSON.stringify(
        [...document.body.querySelectorAll('*')].map((e) => {
          const r = e.getBoundingClientRect();
          return [r.x, r.y, r.width, r.height];
        })
      );
      if (previous === next) count++;
      else count = 0;
      if (count >= 6) return;
      previous = next;
    }
    throw Error('unstable layout');
  });
}
async function snapshot(page, key, extra = {}) {
  await stable(page);
  const png = await page.screenshot({
    animations: 'disabled',
    caret: 'hide',
    path: new URL(`${key}.png`, out).pathname,
  });
  const nodes = await page.evaluate(() =>
    [
      ...document.querySelectorAll(
        '[data-panel], [data-resize-handle], [data-layout-card], [data-layout-content], [data-layout-header], [data-side=top]'
      ),
    ].map((e) => {
      let s = getComputedStyle(e),
        r = e.getBoundingClientRect(),
        a = getComputedStyle(e, '::after');
      return {
        slot: e.getAttribute('data-slot'),
        id: e.id,
        card: e.getAttribute('data-layout-card'),
        header: e.getAttribute('data-layout-header'),
        content: e.getAttribute('data-layout-content'),
        state: e.getAttribute('data-state'),
        panelSize: e.getAttribute('data-panel-size'),
        value: e.getAttribute('aria-valuenow'),
        enabled: e.getAttribute('data-resize-handle-enabled'),
        rect: [r.x, r.y, r.width, r.height],
        scroll: [e.scrollTop, e.scrollLeft, e.scrollHeight, e.scrollWidth],
        overflow: [s.overflowX, s.overflowY],
        shadow: s.boxShadow,
        outline: s.outline,
        after: [a.content, a.width, a.height, a.left, a.top, a.translate],
        focus: e.matches(':focus-visible'),
        opacity: s.opacity,
        rotate: s.rotate,
        font: [s.fontFamily, s.fontSize, s.lineHeight],
      };
    })
  );
  const input = await page.evaluate(() => window.__layoutInput);
  results.push({
    key,
    input,
    file: `${key}.png`,
    sha256: createHash('sha256').update(png).digest('hex'),
    nodes,
    ...extra,
  });
  console.log(key);
}
for (const theme of ['light', 'dark']) {
  for (const kind of [
    'horizontal',
    'vertical',
    'nested',
    'consumer-handle',
    'disabled',
    'touch-horizontal',
    'touch-vertical',
  ]) {
    const touch = kind.startsWith('touch-'),
      story = kind.replace('touch-', '');
    const context = await browser.newContext({
      ...(touch ? devices['iPhone 13'] : {}),
      viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 900 },
      deviceScaleFactor: 1,
      colorScheme: theme,
      reducedMotion: 'no-preference',
    });
    await installInput(context);
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date('2026-10-22T09:00:00Z'));
    await page.goto(
      `${base}/iframe.html?id=ui-roundlayoutmigration--${story}&viewMode=story&globals=theme:${theme};locale:en`,
      { waitUntil: 'load' }
    );
    await page.locator('#layout-handle').waitFor();
    await stable(page);
    const vertical = story === 'vertical',
      selector = story === 'nested' ? '#layout-inner-handle' : '#layout-handle';
    const box = await page.locator(selector).boundingBox(),
      x = box.x + box.width / 2,
      y = box.y + box.height / 2;
    const before = await page.locator(selector).getAttribute('aria-valuenow');
    const k = `${kind}-${theme}`;
    await snapshot(page, `${k}-rest`, { input: touch ? 'CDP trusted touch' : 'mouse' });
    if (touch) {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let n = 1; n <= 8; n++) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [
            { x: x + (vertical ? 0 : (48 * n) / 8), y: y + (vertical ? (48 * n) / 8 : 0) },
          ],
        });
        await page.evaluate(() => new Promise(requestAnimationFrame));
      }
      await snapshot(page, `${k}-drag`);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(
        x + (vertical || story === 'nested' ? 0 : 60),
        y + (vertical || story === 'nested' ? 60 : 0),
        { steps: 8 }
      );
      await snapshot(page, `${k}-drag`);
      await page.mouse.up();
    }
    const after = await page.locator(selector).getAttribute('aria-valuenow');
    if (story !== 'disabled' && before === after)
      throw Error(`${k} resize did not change value ${before}`);
    if (story === 'disabled' && before !== after) throw Error('disabled handle resized');
    await page.mouse.move(1, 1);
    await snapshot(page, `${k}-released`, { beforeValue: before, afterValue: after });
    await context.close();
  }
  for (const kind of ['inner-scroll', 'outer-scroll', 'horizontal-scroll', 'disabled-toggle']) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 1,
      colorScheme: theme,
      reducedMotion: 'no-preference',
    });
    await installInput(context);
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date('2026-10-22T09:00:00Z'));
    const story =
      kind === 'inner-scroll' || kind === 'disabled-toggle' ? 'card-states' : 'card-sticky';
    await page.goto(
      `${base}/iframe.html?id=ui-roundlayoutmigration--${story}&viewMode=story&globals=theme:${theme};locale:en`,
      { waitUntil: 'load' }
    );
    await page.locator('[data-layout-card]').first().waitFor();
    await stable(page);
    const key = `${kind}-${theme}`;
    if (kind === 'disabled-toggle') {
      const root = page.locator('[data-layout-card=disabled]');
      const before = await root.getAttribute('data-state');
      await root.locator('button[aria-label="Toggle section"]').click();
      await snapshot(page, key, {
        beforeState: before,
        afterState: await root.getAttribute('data-state'),
        note: 'Original Radix asChild div does not disable its enabled descendant button; record behavior without changing it.',
      });
    } else {
      const target = page
        .locator(
          kind === 'inner-scroll'
            ? '[data-layout-content=open]'
            : kind === 'outer-scroll'
              ? '[data-layout-outer-scroll]'
              : '[data-layout-card=wide] > [data-state]:not([aria-expanded])'
        )
        .first();
      const box = await target.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height - 10, 100));
      await page.mouse.wheel(
        kind === 'horizontal-scroll' ? 240 : 0,
        kind === 'horizontal-scroll' ? 0 : 200
      );
      await page.waitForFunction(
        ({ selector, axis }) => document.querySelector(selector)?.[axis] > 0,
        {
          selector:
            kind === 'inner-scroll'
              ? '[data-layout-content=open]'
              : kind === 'outer-scroll'
                ? '[data-layout-outer-scroll]'
                : '[data-layout-card=wide] > [data-state]:not([aria-expanded])',
          axis: kind === 'horizontal-scroll' ? 'scrollLeft' : 'scrollTop',
        }
      );
      await snapshot(page, key, {
        scroll: await target.evaluate((e) => ({ top: e.scrollTop, left: e.scrollLeft })),
      });
    }
    await context.close();
  }
}
await writeFile(
  new URL('results.json', out),
  JSON.stringify(
    {
      base,
      phase,
      buildFingerprint,
      runnerFingerprint,
      browserVersion: browser.version(),
      reducedMotion: 'no-preference',
      frames: results.length,
      results,
    },
    null,
    2
  ) + '\n'
);
await browser.close();
console.log(`captured ${results.length}`);
