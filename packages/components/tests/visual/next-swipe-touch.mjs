/** Real Chromium touch input supplements the shared harness's click/tap steps. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from '@playwright/test';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, token, i, all) => {
    if (token.startsWith('--')) pairs.push([token.slice(2), all[i + 1]]);
    return pairs;
  }, [])
);
if (!args.phase || !args.storybook)
  throw new Error(
    'usage: next-swipe-touch.mjs --phase <phase> --storybook <immutable-url> [--only <story-suffix>]'
  );
const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '../../artifacts/visual', args.phase);
await mkdir(path.join(outDir, 'shots'), { recursive: true });
const hash = (value) => createHash('sha256').update(value).digest('hex');
const harnessFingerprint = hash(await readFile(fileURLToPath(import.meta.url)));
const index = await (await fetch(new URL('/index.json', args.storybook))).json();
const iframe = await (await fetch(new URL('/iframe.html', args.storybook))).text();
const viewports = [
  { name: 'iphone-touch', device: 'iPhone 13', width: 390, height: 844 },
  { name: 'android-touch', device: 'Pixel 5', width: 393, height: 851 },
];
const themes = args.probe ? ['light'] : ['light', 'dark'];
const cases = [
  'single-archive',
  'multiple-actions',
  'long-labels',
  'commit',
  'independent-rows',
  'disabled',
  'empty-actions',
].filter((name) => !args.only || name.includes(args.only));
const caseStates = {
  'single-archive': [
    'vertical-pan-preserved',
    'below-reveal-threshold',
    'actions-open',
    'action-keyboard-focus',
    'action-activated',
  ],
  'multiple-actions': ['two-actions-open', 'restore-activated', 'swipe-closed'],
  'long-labels': ['long-label-open'],
  commit: ['commit-ready', 'commit-stretched', 'committed'],
  'independent-rows': ['first-open', 'second-closes-first', 'outside-dismissed'],
  disabled: ['touch-bypass'],
  'empty-actions': ['touch-bypass'],
};
const entries = [],
  failures = [],
  actionRecords = [];

const snapshot = () => {
  const rows = [];
  const visit = (element, key) => {
    const css = getComputedStyle(element),
      rect = element.getBoundingClientRect();
    rows.push({
      path: key,
      tag: element.tagName.toLowerCase(),
      rect: [rect.x, rect.y, rect.width, rect.height].map((v) => Math.round(v * 100) / 100),
      text: (element.textContent ?? '').trim().slice(0, 60),
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
        ].map((prop) => [prop, css[prop]])
      ),
    });
    [...element.children].forEach((child, i) => visit(child, `${key}>${i}`));
  };
  [...document.body.children]
    .filter(
      (el) =>
        el.id === 'storybook-root' ||
        (!['SCRIPT', 'STYLE', 'LINK'].includes(el.tagName) &&
          !el.className?.toString().includes('sb-'))
    )
    .forEach((el, i) => visit(el, String(i)));
  return rows;
};

async function settled(page) {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
      .every((animation) => animation.playState !== 'running')
  );
  await page.waitForFunction(
    () => {
      const current = JSON.stringify(
        [...document.body.querySelectorAll('*')].map((el) => {
          const r = el.getBoundingClientRect();
          return [r.x, r.y, r.width, r.height];
        })
      );
      const previous = window.__swipeStable ?? { current: '', equal: 0 };
      window.__swipeStable = {
        current,
        equal: previous.current === current ? previous.equal + 1 : 0,
      };
      return window.__swipeStable.equal >= 3;
    },
    undefined,
    { polling: 50 }
  );
}

let browser;
try {
  browser = await chromium.launch();
} catch {
  // Match the shared harness's installed browser when the pinned revision is absent.
  const { readdir } = await import('node:fs/promises');
  const os = await import('node:os');
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const revisions = (await readdir(cache))
    .filter((name) => /^chromium_headless_shell-\d+$/.test(name))
    .sort((a, b) => Number(b.split('-').at(-1)) - Number(a.split('-').at(-1)));
  if (!revisions.length) throw new Error('No installed Chromium for touch validation');
  browser = await chromium.launch({
    executablePath: path.join(
      cache,
      revisions[0],
      'chrome-headless-shell-mac-arm64/chrome-headless-shell'
    ),
  });
}

for (const viewport of args.probe ? viewports.slice(0, 1) : viewports)
  for (const theme of themes) {
    for (const suffix of cases) {
      const context = await browser.newContext({
        ...devices[viewport.device],
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
        colorScheme: theme,
        reducedMotion: 'no-preference',
      });
      const page = await context.newPage();
      await page.clock.setFixedTime(new Date('2026-10-22T09:00:00Z'));
      const storyId = `shared-swipeactionmigration--${suffix}`;
      const key = `${storyId}__${viewport.name}__${theme}`;
      let state = 'rest';
      try {
        await page.addInitScript(() => {
          window.__swipeEvents = [];
          for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'click'])
            document.addEventListener(
              type,
              (event) => {
                window.__swipeEvents.push({
                  type,
                  pointerType: event.pointerType,
                  isTrusted: event.isTrusted,
                  x: event.clientX,
                  y: event.clientY,
                  target:
                    event.target
                      ?.closest?.('[data-swipe-fixture]')
                      ?.getAttribute('data-swipe-fixture') ?? null,
                });
              },
              true
            );
        });
        const url = new URL('/iframe.html', args.storybook);
        url.search = new URLSearchParams({
          id: storyId,
          viewMode: 'story',
          globals: `theme:${theme};locale:en`,
        }).toString();
        await page.goto(url.href, { waitUntil: 'load' });
        await page.locator('[data-swipe-face="primary"]').waitFor({ state: 'visible' });
        await page.evaluate(() => document.fonts.ready);
        const cdp = await context.newCDPSession(page);
        const face = (id = 'primary') => page.locator(`[data-swipe-face="${id}"]`);
        const content = (id = 'primary') =>
          page.locator(`[data-swipe-fixture="${id}"] > div > div:last-child`);
        const assertOffset = async (expectedOffset, id = 'primary') => {
          await page.waitForFunction(
            ({ selector, offset }) => {
              const element = document.querySelector(selector);
              return (
                !!element &&
                Math.abs(new DOMMatrixReadOnly(getComputedStyle(element).transform).m41 - offset) <
                  0.01
              );
            },
            {
              selector: `[data-swipe-fixture="${id}"] > div > div:last-child`,
              offset: expectedOffset,
            }
          );
        };
        const shot = async (name) => {
          state = name;
          await settled(page);
          const stateKey = name === 'rest' ? key : `${key}__${name}`;
          await page.screenshot({
            path: path.join(outDir, 'shots', `${stateKey}.png`),
            caret: 'hide',
            animations: 'allow',
          });
          entries.push({
            key: stateKey,
            state: name,
            storyId,
            title: 'Shared/SwipeActionMigration',
            viewport: viewport.name,
            theme,
            shot: `shots/${stateKey}.png`,
            layout: await page.evaluate(snapshot),
          });
          actionRecords.push({
            key: stateKey,
            events: await page.evaluate(() => window.__swipeEvents),
            output: await page.locator('[data-swipe-events]').textContent(),
            content: await content().evaluateAll((els) =>
              els.map((el) => ({
                transform: getComputedStyle(el).transform,
                touchAction: getComputedStyle(el).touchAction,
                transition: getComputedStyle(el).transition,
                rect: el.getBoundingClientRect().toJSON(),
              }))
            ),
          });
        };
        const drag = async (deltaX, deltaY = 0, id = 'primary', hold = false) => {
          const box = await face(id).boundingBox();
          if (!box) throw new Error('Swipe face has no visible box');
          const x = Math.min(viewport.width - 24, box.x + box.width - 24),
            y = box.y + box.height / 2;
          const send = (type, points) =>
            cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points, modifiers: 0 });
          const point = (px, py) => [{ x: px, y: py, radiusX: 1, radiusY: 1, force: 1, id: 1 }];
          await send('touchStart', point(x, y));
          for (let i = 1; i <= 10; i++) {
            await send('touchMove', point(x + (deltaX * i) / 10, y + (deltaY * i) / 10));
            await page.evaluate(() => new Promise(requestAnimationFrame));
          }
          actionRecords.push({
            key,
            action: 'CDP touch drag',
            from: [x, y],
            to: [x + deltaX, y + deltaY],
            delta: [deltaX, deltaY],
            hold,
          });
          if (!hold) await send('touchEnd', []);
        };
        await shot('rest');
        if (['disabled', 'empty-actions'].includes(suffix)) {
          await drag(-80);
          if (await content().count())
            throw new Error('Disabled or empty swipe unexpectedly mounted gesture wrapper');
          await shot('touch-bypass');
        } else if (suffix === 'single-archive') {
          await drag(0, 60);
          await assertOffset(0);
          await shot('vertical-pan-preserved');
          await drag(-20);
          await assertOffset(0);
          await shot('below-reveal-threshold');
          await drag(-60);
          await assertOffset(-72);
          await shot('actions-open');
          await page.getByRole('button', { name: 'Archive conversation', exact: true }).focus();
          await page.keyboard.press('Tab');
          await page.keyboard.press('Shift+Tab');
          await page.waitForFunction(
            () =>
              document.activeElement?.getAttribute('aria-label') === 'Archive conversation' &&
              document.activeElement.matches(':focus-visible')
          );
          await shot('action-keyboard-focus');
          await page
            .getByRole('button', { name: 'Archive conversation', exact: true })
            .press('Enter');
          await assertOffset(0);
          await page.waitForFunction(() =>
            document.querySelector('[data-swipe-events]')?.textContent?.includes('primary:archive')
          );
          await shot('action-activated');
        } else if (suffix === 'multiple-actions') {
          await drag(-110);
          await assertOffset(-144);
          await shot('two-actions-open');
          await page.getByRole('button', { name: 'Restore', exact: true }).tap();
          await assertOffset(0);
          await shot('restore-activated');
          await drag(-110);
          await assertOffset(-144);
          await drag(90);
          await assertOffset(0);
          await shot('swipe-closed');
        } else if (suffix === 'commit') {
          await drag(-60);
          await assertOffset(-72);
          await shot('commit-ready');
          await drag(-100, 0, 'primary', true);
          await assertOffset(-124);
          await shot('commit-stretched');
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await assertOffset(0);
          await page.waitForFunction(() =>
            document.querySelector('[data-swipe-events]')?.textContent?.includes('primary:commit')
          );
          await shot('committed');
        } else if (suffix === 'independent-rows') {
          await drag(-60);
          await assertOffset(-72);
          await shot('first-open');
          await drag(-60, 0, 'secondary');
          await assertOffset(0);
          await assertOffset(-72, 'secondary');
          await shot('second-closes-first');
          await page.locator('[data-swipe-outside]').tap();
          await assertOffset(0, 'secondary');
          await shot('outside-dismissed');
        } else {
          await drag(-60);
          await assertOffset(-72);
          await shot('long-label-open');
        }
        const pointerEvents = await page.evaluate(() =>
          window.__swipeEvents.filter((event) => event.type.startsWith('pointer'))
        );
        if (!pointerEvents.some((event) => event.pointerType === 'touch' && event.isTrusted))
          throw new Error('No trusted touch pointer input observed');
        console.log(`[swipe-touch] ${key}: passed`);
      } catch (error) {
        const errorShot = `shots/${key}__${state}__error.png`;
        await page.screenshot({ path: path.join(outDir, errorShot) }).catch(() => {});
        failures.push({
          key: `${key}__${state}`,
          message: String(error?.stack ?? error),
          shot: errorShot,
        });
        console.error(`[swipe-touch] ${key}: ${error.message}`);
      } finally {
        await context.close();
      }
    }
  }
await browser.close();
await writeFile(path.join(outDir, 'actions.json'), JSON.stringify(actionRecords, null, 2));
await writeFile(path.join(outDir, 'failures.json'), JSON.stringify(failures, null, 2));
await writeFile(
  path.join(outDir, 'manifest.json'),
  JSON.stringify(
    {
      phase: args.phase,
      baseUrl: args.storybook,
      buildFingerprint: hash(iframe + JSON.stringify(index)),
      harnessFingerprint,
      browserInput:
        'CDP Input.dispatchTouchEvent; trusted real touch pointer events, normal motion, transitions settled before snapshots',
      targets: {
        viewports: args.probe ? viewports.slice(0, 1) : viewports,
        themes,
        ids: cases.map((suffix) => `shared-swipeactionmigration--${suffix}`),
        states: Object.fromEntries(
          cases.map((suffix) => [
            `shared-swipeactionmigration--${suffix}`,
            caseStates[suffix].map((name) => ({ name })),
          ])
        ),
        reducedMotion: 'no-preference',
      },
      expected:
        cases.reduce((sum, suffix) => sum + caseStates[suffix].length + 1, 0) *
        (args.probe ? 1 : viewports.length) *
        themes.length,
      capturedAt: new Date().toISOString(),
      entries,
    },
    null,
    2
  )
);
if (failures.length) process.exitCode = 1;
