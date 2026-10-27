/** Trusted input and real Clipboard API coverage for DiffViewer leaf controls. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from '@playwright/test';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .flatMap((arg, i, all) => (arg.startsWith('--') ? [[arg.slice(2), all[i + 1]]] : []))
);
if (!args.phase || !args.storybook)
  throw new Error(
    'Usage: diff-leaves-native.mjs --phase <phase> --storybook <immutable URL> [--probe true]'
  );
const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(pkg, 'artifacts/visual', args.phase);
await mkdir(path.join(out, 'shots'), { recursive: true });
const hash = (data) => createHash('sha256').update(data).digest('hex');
const iframe = await (await fetch(new URL('/iframe.html', args.storybook))).text();
if (iframe.includes('/@vite/client'))
  throw new Error('Native acceptance requires an immutable build');
const index = await (await fetch(new URL('/index.json', args.storybook))).json();
let browser;
try {
  browser = await chromium.launch();
} catch {
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const revisions = (await readdir(cache))
    .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
    .sort((a, b) => Number(b.split('-').at(-1)) - Number(a.split('-').at(-1)));
  if (!revisions.length) throw new Error('No Chromium is installed');
  browser = await chromium.launch({
    executablePath: path.join(
      cache,
      revisions[0],
      'chrome-headless-shell-mac-arm64/chrome-headless-shell'
    ),
  });
}
const allViews = [
  { name: 'native-desktop', width: 1280, height: 1000 },
  { name: 'native-iphone', device: 'iPhone 13', width: 390, height: 1000 },
];
const views = args.probe ? allViews.slice(0, 1) : allViews;
const themes = args.probe ? ['light'] : ['light', 'dark'];
const cases = [
  'header-success',
  'header-empty',
  'header-denied',
  'add-default',
  'add-override',
].filter((n) => !args.only || n.includes(args.only));
const entries = [],
  failures = [],
  observations = [];
const layout = () =>
  [...document.querySelectorAll('#storybook-root,#storybook-root *')].map((el, i) => {
    const c = getComputedStyle(el),
      r = el.getBoundingClientRect();
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
        ].map((k) => [k, c[k]])
      ),
    };
  });
for (const viewport of views)
  for (const theme of themes)
    for (const kind of cases) {
      const context = await browser.newContext({
        ...(viewport.device ? devices[viewport.device] : {}),
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
        reducedMotion: 'no-preference',
        permissions: ['clipboard-read', 'clipboard-write'],
      });
      const header = kind.startsWith('header-');
      const page = await context.newPage();
      if (header) await page.clock.install({ time: new Date('2026-10-25T09:00:00Z') });
      else await page.clock.setFixedTime(new Date('2026-10-25T09:00:00Z'));
      await page.addInitScript(() => {
        window.__diffLeafEvents = [];
        for (const type of ['pointerdown', 'pointerup', 'click', 'keydown'])
          document.addEventListener(
            type,
            (e) =>
              window.__diffLeafEvents.push({
                type,
                trusted: e.isTrusted,
                pointerType: e.pointerType ?? null,
                key: e.key ?? null,
                target: e.target.tagName,
              }),
            true
          );
      });
      const suffix = header
        ? kind === 'header-empty'
          ? 'empty-path'
          : 'header-actions'
        : 'add-buttons';
      const storyId = `ui-diffleavesmigration--${suffix}`;
      const key = `${storyId}__${viewport.name}__${theme}__${kind}`;
      let activeState = 'rest';
      try {
        const url = new URL('/iframe.html', args.storybook);
        url.search = new URLSearchParams({
          id: storyId,
          viewMode: 'story',
          globals: `theme:${theme};locale:en`,
        });
        await page.goto(url.href);
        const button = page.locator(
          header ? 'button[aria-label="Copy file path"]' : `[data-${kind}] button`
        );
        await button.waitFor({ state: 'visible' });
        await page.evaluate(() => document.fonts.ready);
        if (header)
          await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 1000));
        const shot = async (state, allowAnimations = false) => {
          activeState = state;
          const frameKey = `${key}__${state}`;
          await page.screenshot({
            path: path.join(out, 'shots', `${frameKey}.png`),
            animations: allowAnimations ? 'allow' : 'disabled',
            caret: 'hide',
          });
          entries.push({
            key: frameKey,
            state,
            storyId,
            title: 'UI/DiffLeavesMigration — trusted input',
            viewport: viewport.name,
            theme,
            shot: `shots/${frameKey}.png`,
            layout: await page.evaluate(layout),
          });
          observations.push({
            key: frameKey,
            paint: await button.evaluate((el) => {
              const c = getComputedStyle(el),
                r = el.getBoundingClientRect();
              return {
                hover: el.matches(':hover'),
                active: el.matches(':active'),
                focusVisible: el.matches(':focus-visible'),
                scale: c.scale,
                transform: c.transform,
                background: c.backgroundColor,
                color: c.color,
                boxShadow: c.boxShadow,
                touchAction: c.touchAction,
                transition: c.transition,
                width: r.width,
                height: r.height,
                rectGlyph: !!el.querySelector('svg rect'),
              };
            }),
            output: await page
              .locator(header ? '[data-header-output]' : '[data-add-output]')
              .textContent(),
            events: await page.evaluate(() => window.__diffLeafEvents),
          });
        };
        const activate = async (target) => (viewport.device ? target.tap() : target.click());
        const pauseTransitions = async (target) =>
          target.evaluate((el) =>
            el.getAnimations({ subtree: true }).map((a) => {
              const duration = Number(a.effect?.getTiming().duration);
              a.pause();
              a.currentTime = duration / 2;
              return {
                property: a.transitionProperty ?? null,
                duration,
                currentTime: a.currentTime,
              };
            })
          );
        const finishTransitions = async (target) =>
          target.evaluate((el) => {
            for (const a of el.getAnimations({ subtree: true })) a.finish();
          });
        const keyboard = async () => {
          await button.focus();
          await button.press('ArrowLeft');
          await page.mouse.move(0, 0);
          if (!(await button.evaluate((el) => el.matches(':focus-visible'))))
            throw new Error('Real key did not establish focus-visible');
        };
        await shot('rest');
        if (header) {
          await page.evaluate(() => navigator.clipboard.writeText('synthetic clipboard sentinel'));
          if (kind === 'header-success') {
            await button.hover();
            const transition = await pauseTransitions(button);
            observations.push({ key, transitionMidpoint: transition });
            await shot(viewport.device ? 'hover-media-bypass' : 'hover-midpoint', true);
            await finishTransitions(button);
            await shot('hover-settled');
            await keyboard();
            await shot('keyboard-focused');
          }
          if (kind === 'header-denied') {
            const session = await browser.newBrowserCDPSession();
            const { browserContextIds } = await session.send('Target.getBrowserContexts');
            if (browserContextIds.length !== 1)
              throw new Error('Clipboard denial needs the unique owned context');
            await session.send('Browser.setPermission', {
              permission: { name: 'clipboard-write' },
              setting: 'denied',
              origin: new URL(args.storybook).origin,
              browserContextId: browserContextIds[0],
            });
            const permission = await page.evaluate(
              async () => (await navigator.permissions.query({ name: 'clipboard-write' })).state
            );
            if (permission !== 'denied')
              throw new Error('Browser did not deny clipboard-write permission');
            observations.push({ key, actualClipboardPermission: permission });
            await session.detach();
          }
          await activate(button);
          if (kind === 'header-success') {
            await page.waitForFunction(
              () => document.querySelector('button[aria-label="Copy file path"] svg rect') === null
            );
            const expected = await page.locator('[data-header-host] span').textContent();
            const clipboard = await page.evaluate(() => navigator.clipboard.readText());
            if (clipboard !== expected) throw new Error('Clipboard path bytes changed');
            observations.push({ key, clipboard, expected });
            await shot('copied');
            await page.clock.runFor(1999);
            if (await button.locator('svg rect').count())
              throw new Error('Copied feedback expired early');
            await shot('deadline-1999');
            await page.clock.runFor(1);
            if (!(await button.locator('svg rect').count()))
              throw new Error('Copied feedback did not expire at2000ms');
            await shot('deadline-2000');
            await activate(page.getByRole('button', { name: 'Open file', exact: true }));
            if (
              !(await page.locator('[data-header-output]').textContent()).includes(
                `Opened: ${expected}`
              )
            )
              throw new Error('Open callback lost the path');
            await shot('opened-file');
          } else {
            await page.clock.runFor(2000);
            if (kind === 'header-denied')
              await context.grantPermissions(['clipboard-read', 'clipboard-write']);
            const clipboard = await page.evaluate(() => navigator.clipboard.readText());
            if (clipboard !== 'synthetic clipboard sentinel')
              throw new Error('Failed/empty copy altered clipboard');
            if (!(await button.locator('svg rect').count()))
              throw new Error('Failed/empty copy showed success feedback');
            await shot(kind === 'header-empty' ? 'empty-copy-noop' : 'permission-denied');
          }
          if (
            !(await page.locator('[data-header-content]').isVisible()) ||
            !(await page.locator('[data-header-output]').textContent()).endsWith(
              'parent pointerdowns=0'
            )
          )
            throw new Error('Header action changed parent expansion or pointer propagation');
        } else {
          await button.hover();
          await finishTransitions(button);
          await shot('hover');
          const box = await button.boundingBox(),
            x = box.x + box.width / 2,
            y = box.y + box.height / 2;
          const cdp = viewport.device ? await context.newCDPSession(page) : null;
          if (cdp)
            await cdp.send('Input.dispatchTouchEvent', {
              type: 'touchStart',
              touchPoints: [{ x, y, id: 1, radiusX: 1, radiusY: 1, force: 1 }],
            });
          else await page.mouse.down();
          await page.evaluate(() => new Promise(requestAnimationFrame));
          if (viewport.device) {
            await shot('touch-held');
          } else {
            const transition = await pauseTransitions(button);
            observations.push({ key, activeMidpoint: transition });
            await shot('active-midpoint', true);
            await finishTransitions(button);
            await shot('active-held');
            const active = await button.evaluate((el) => el.matches(':active'));
            if (!active) throw new Error('Trusted mouse press did not enter :active');
          }
          if (cdp)
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          else await page.mouse.up();
          await page.waitForFunction(
            (expected) =>
              document.querySelector('[data-add-output]').textContent.includes(expected),
            kind === 'add-default' ? 'Default add activated' : 'Override add activated'
          );
          await finishTransitions(button);
          await shot('released');
          await keyboard();
          await shot('keyboard-focused');
          if (!(await page.locator('[data-add-output]').textContent()).includes('parent clicks=0'))
            throw new Error('Add button bubbled to parent');
        }
        if (!(await page.evaluate(() => window.__diffLeafEvents)).some((e) => e.trusted))
          throw new Error('No trusted browser input recorded');
        console.log(`[diff-leaf] ${key}: passed`);
      } catch (error) {
        failures.push({ key: `${key}__${activeState}`, message: String(error.stack ?? error) });
        console.error(`[diff-leaf] ${key}: ${error.message}`);
      } finally {
        await context.close();
      }
    }
const browserVersion = browser.version();
await browser.close();
const expected = views.reduce(
  (total, view) =>
    total +
    themes.length *
      cases.reduce(
        (sum, kind) =>
          sum +
          (kind === 'header-success' ? 8 : kind.startsWith('header-') ? 2 : view.device ? 5 : 6),
        0
      ),
  0
);
await writeFile(path.join(out, 'observations.json'), JSON.stringify(observations, null, 2));
await writeFile(path.join(out, 'failures.json'), JSON.stringify(failures, null, 2));
await writeFile(
  path.join(out, 'manifest.json'),
  JSON.stringify(
    {
      phase: args.phase,
      baseUrl: args.storybook,
      buildFingerprint: hash(iframe + JSON.stringify(index)),
      harnessFingerprint: hash(await readFile(fileURLToPath(import.meta.url))),
      browser: { engine: 'chromium', version: browserVersion },
      targets: { viewports: views, themes, cases },
      expected,
      capturedAt: new Date().toISOString(),
      entries,
    },
    null,
    2
  )
);
console.log(`${entries.length}/${expected} actual frames,${failures.length} failures`);
if (failures.length || entries.length !== expected) process.exitCode = 1;
