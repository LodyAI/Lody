import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices, expect } from '@playwright/test';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .flatMap((value, index, all) =>
      value.startsWith('--') ? [[value.slice(2), all[index + 1]]] : []
    )
);
assert.ok(args.phase && args.storybook, '--phase and --storybook required');
const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(pkg, 'artifacts/visual', args.phase);
await mkdir(path.join(out, 'shots'), { recursive: true });
const iframe = await (await fetch(new URL('/iframe.html', args.storybook))).text();
assert.ok(!iframe.includes('/@vite/client'), 'Immutable Storybook required');
const index = await (await fetch(new URL('/index.json', args.storybook))).text();
const buildFingerprint = createHash('sha256').update(iframe).update(index).digest('hex');
const browser = await (async () => {
  try {
    return await chromium.launch();
  } catch (error) {
    const dir = path.join(os.homedir(), 'Library/Caches/ms-playwright');
    const candidates = existsSync(dir)
      ? (await readdir(dir))
          .flatMap((entry) => {
            const match = /^chromium_headless_shell-(\d+)$/.exec(entry);
            const shell = path.join(
              dir,
              entry,
              'chrome-headless-shell-mac-arm64/chrome-headless-shell'
            );
            return match && existsSync(shell) ? [{ shell, revision: Number(match[1]) }] : [];
          })
          .sort((a, b) => b.revision - a.revision)
      : [];
    if (!candidates.length) throw error;
    return chromium.launch({ executablePath: candidates[0].shell });
  }
})();
const properties = [
  'display',
  'position',
  'width',
  'height',
  'minWidth',
  'maxWidth',
  'minHeight',
  'maxHeight',
  'flex',
  'gap',
  'alignItems',
  'justifyContent',
  'margin',
  'padding',
  'borderWidth',
  'borderStyle',
  'borderColor',
  'borderRadius',
  'boxSizing',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'color',
  'backgroundColor',
  'backgroundImage',
  'whiteSpace',
  'overflow',
  'overflowX',
  'overflowY',
  'opacity',
  'boxShadow',
  'outline',
  'outlineOffset',
  'transitionProperty',
  'transitionDuration',
  'transitionTimingFunction',
  'cursor',
  'pointerEvents',
  '--tw-ring-color',
  '--tw-ring-shadow',
  '--tw-ring-offset-shadow',
  '--tw-ring-offset-width',
  '--tw-ring-offset-color',
  '--tw-shadow',
  '--tw-shadow-color',
];
const inspect = (keys) =>
  [...document.querySelectorAll('[data-search-table-fixture], [data-search-table-fixture] *')].map(
    (element, itemIndex) => {
      const css = getComputedStyle(element),
        rect = element.getBoundingClientRect();
      return {
        path: String(itemIndex),
        tag: element.tagName,
        text: element.textContent?.trim().slice(0, 180),
        label: element.getAttribute('aria-label'),
        role: element.getAttribute('role'),
        result: element.getAttribute('data-search-result-id'),
        rect: [rect.x, rect.y, rect.width, rect.height],
        styles: Object.fromEntries(
          keys.map((key) => [
            key,
            css.getPropertyValue(key.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase())),
          ])
        ),
        active: document.activeElement === element,
        focusVisible: element.matches(':focus-visible'),
        scroll: [element.scrollLeft, element.scrollTop, element.scrollWidth, element.clientWidth],
      };
    }
  );
const settle = async (page) => {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
      .every((animation) => animation.playState !== 'running')
  );
  await page.evaluate(() => delete window.__searchTableStable);
  await page.waitForFunction((keys) => {
    const value = JSON.stringify(
      [
        ...document.querySelectorAll('[data-search-table-fixture], [data-search-table-fixture] *'),
      ].map((element) => [
        element.getBoundingClientRect().toJSON(),
        keys.map((key) =>
          getComputedStyle(element).getPropertyValue(
            key.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase())
          )
        ),
        element.scrollLeft,
      ])
    );
    const state = window.__searchTableStable ?? { value: '', count: 0 };
    state.count = state.value === value ? state.count + 1 : 0;
    state.value = value;
    window.__searchTableStable = state;
    return state.count >= 4;
  }, properties);
};
const entries = [],
  failures = [],
  browserErrors = [],
  externalRequests = [];
try {
  for (const viewport of [
    { name: 'desktop', width: 1280, height: 900 },
    { name: 'iphone', width: 390, height: 844, device: 'iPhone 13' },
  ])
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        ...(viewport.device ? devices[viewport.device] : {}),
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
        colorScheme: theme,
        reducedMotion: 'reduce',
        permissions: ['clipboard-read', 'clipboard-write'],
      });
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (
          ['http:', 'https:'].includes(url.protocol) &&
          !['127.0.0.1', 'localhost'].includes(url.hostname)
        ) {
          externalRequests.push(url.origin + url.pathname);
          return route.abort();
        }
        return route.continue();
      });
      for (const scenario of ['table', 'active', 'cjk', 'root-palette', 'subtree-palette']) {
        if (args.only && !new RegExp(args.only).test(`${scenario}__${viewport.name}__${theme}`))
          continue;
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        page.on('pageerror', (error) => browserErrors.push(String(error)));
        let paused = false;
        const id = `components-ownedsearchtablemigration--${scenario}`;
        const press = async (locator) => (viewport.device ? locator.tap() : locator.click());
        const shot = async (state, assertions = {}) => {
          if (!paused) await settle(page);
          const key = `${id}__${viewport.name}__${theme}__${state}`;
          await page.screenshot({
            path: path.join(out, 'shots', key + '.png'),
            animations: 'disabled',
            caret: 'hide',
          });
          entries.push({
            id,
            key,
            viewport: viewport.name,
            theme,
            state,
            shot: `shots/${key}.png`,
            assertions,
            layout: await page.evaluate(inspect, properties),
            events: await page.evaluate(() => window.__searchTableEvents),
            observation: await page.evaluate(() => ({
              result: document.querySelector('[data-search-table-result]').textContent,
              payload: document.querySelector('[data-search-table-payload]').textContent,
              marks: [...document.querySelectorAll('[data-search-result-id]')].map((mark) => ({
                id: mark.dataset.searchResultId,
                text: mark.textContent,
              })),
              media: {
                hover: matchMedia('(hover:hover)').matches,
                touch: 'ontouchstart' in window,
                reduced: matchMedia('(prefers-reduced-motion:reduce)').matches,
              },
              geometry: {
                viewport: [innerWidth, innerHeight],
                documentWidth: document.documentElement.scrollWidth,
              },
            })),
          });
          console.log(key);
        };
        try {
          await page.clock.install({ time: new Date('2026-10-27T09:00:00Z') });
          await page.addInitScript(() => {
            window.__searchTableEvents = [];
            for (const type of ['pointerdown', 'pointerup', 'keydown', 'click'])
              document.addEventListener(
                type,
                (event) => {
                  if (
                    event.target instanceof Element &&
                    event.target.closest('[data-search-table-fixture]')
                  )
                    window.__searchTableEvents.push({
                      type,
                      trusted: event.isTrusted,
                      key: event.key ?? null,
                      pointerType: event.pointerType ?? null,
                      target: event.target.tagName,
                      label: event.target.getAttribute('aria-label'),
                    });
                },
                true
              );
          });
          const url = new URL('/iframe.html', args.storybook);
          url.search = new URLSearchParams({
            id,
            viewMode: 'story',
            globals: `theme:${theme};locale:en`,
          });
          await page.goto(url.href);
          await page.waitForFunction(
            () => window.__STORYBOOK_PREVIEW__?.currentRender?.phase === 'finished'
          );
          await expect(page.locator('[data-search-table-result]')).toHaveText('Ready');
          await settle(page);
          if (scenario === 'table') {
            const frame = page.locator('[data-search-table-long] [data-markdown-table-frame]');
            const button = frame.getByRole('button', { name: 'Copy table', exact: true });
            const scroller = frame.locator('[data-markdown-table]');
            await expect(frame.locator('table')).toBeVisible();
            assert.equal(
              await page
                .locator('[data-search-table-direct] table')
                .evaluate((element) => getComputedStyle(element).letterSpacing),
              '0.4px'
            );
            await shot('rest');
            if (!viewport.device) {
              await page
                .locator('[data-search-table-fixture]')
                .evaluate((element) => element.classList.add('group/table'));
              await page.mouse.move(5, 5);
              await expect(button).toHaveCSS('opacity', '1');
              await shot('outer-named-group-hover', {
                publicAncestor: 'group/table',
                pointerOutsideOwnedFrame: true,
              });
              await page
                .locator('[data-search-table-fixture]')
                .evaluate((element) => element.classList.remove('group/table'));
              await expect(button).toHaveCSS('opacity', '0');
              await shot('outer-named-group-cleared', { opacity: 0 });
              await frame.hover();
              await expect(button).toHaveCSS('opacity', '1');
              await shot('hover');
              await page.mouse.move(2, 2);
              await page.locator('[data-search-toggle-open]').focus();
              await page.keyboard.press('Tab');
              await expect(button).toBeFocused();
              await shot('keyboard-focus');
            } else {
              await expect(button).toHaveCSS('opacity', '1');
              await shot('touch-visible');
            }
            await press(button);
            await expect(page.locator('[data-search-table-result]')).toHaveText('Copy pending');
            await expect(button).toHaveAttribute('aria-label', 'Copy table');
            await shot('copy-pending');
            const payload = JSON.parse(
              await page.locator('[data-search-table-payload]').textContent()
            );
            assert.ok(
              payload.hasTable && payload.text.includes('| Key |') && payload.text.includes('\\|')
            );
            assert.deepEqual([...payload.types].sort(), ['text/html', 'text/plain']);
            await page.evaluate(() =>
              window.dispatchEvent(
                new CustomEvent('search-table-copy-settle', { detail: 'reject' })
              )
            );
            await expect(page.locator('[data-search-table-result]')).toHaveText('Copy rejected');
            await expect(button).toHaveAttribute('aria-label', 'Copy table');
            await expect(page.locator('textarea')).toHaveCount(0);
            await shot('copy-rejected', { fallbackRemoved: true });
            await press(button);
            await expect(page.locator('[data-search-table-result]')).toHaveText('Copy pending');
            if (!viewport.device) {
              await page.mouse.move(5, 5);
              await page.locator('[data-search-toggle-open]').focus();
            }
            await page.clock.pauseAt(await page.evaluate(() => Date.now() + 16));
            paused = true;
            await page.evaluate(() =>
              window.dispatchEvent(
                new CustomEvent('search-table-copy-settle', { detail: 'resolve' })
              )
            );
            await page.clock.runFor(16);
            await expect(frame.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
            await shot('copy-success', { richPayload: payload, elapsed: 16 });
            await page.clock.runFor(1483);
            await expect(frame.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
            await shot('deadline-1499', { elapsed: 1499 });
            await page.clock.runFor(1);
            await expect(button).toBeVisible();
            await expect(button).toHaveCSS('opacity', viewport.device ? '1' : '0');
            await shot('deadline-1500', { elapsed: 1500, opacity: viewport.device ? 1 : 0 });
            await page.clock.resume();
            paused = false;
            const overflow = await scroller.evaluate(
              (element) => element.scrollWidth - element.clientWidth
            );
            if (overflow > 0) {
              await scroller.evaluate((element) => {
                element.scrollLeft = element.scrollWidth;
              });
              assert.ok(await scroller.evaluate((element) => element.scrollLeft > 0));
              await shot('horizontal-scroll', { overflow });
            } else await shot('table-fits', { overflow: 0 });
            await page.evaluate(() => Reflect.deleteProperty(navigator, 'clipboard'));
            await press(button);
            await expect(frame.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
            const actual = await page.evaluate(async () => {
              const items = await navigator.clipboard.read();
              const item = items.find((entry) => entry.types.includes('text/plain'));
              return {
                types: item.types,
                text: await (await item.getType('text/plain')).text(),
                html: await (await item.getType('text/html')).text(),
              };
            });
            assert.equal(actual.text, payload.text);
            assert.ok(actual.html.includes('<table'));
            await shot('real-rich-clipboard', {
              text: actual.text,
              types: [...actual.types].sort(),
              hasTable: true,
            });
            if (viewport.device)
              assert.ok(
                (await page.evaluate(() => window.__searchTableEvents)).some(
                  (event) => event.pointerType === 'touch' && event.trusted
                )
              );
          } else {
            await page.waitForFunction(
              () =>
                document.querySelectorAll('[data-search-plain] mark').length === 3 &&
                document.querySelectorAll('[data-search-markdown] mark').length === 3
            );
            await shot('rest');
            if (scenario === 'active') {
              await press(page.locator('[data-search-toggle-active]'));
              await shot('markdown-active');
              await press(page.locator('[data-search-toggle-active]'));
              await shot('all-inactive');
              await press(page.locator('[data-search-toggle-open]'));
              await expect(
                page.locator('[data-search-plain] mark,[data-search-markdown] mark')
              ).toHaveCount(0);
              await shot('search-closed');
              await page.locator('[data-public-active]').evaluate((element) => {
                element.style.setProperty('--tw-ring-offset-width', '3px');
                element.style.setProperty('--tw-ring-offset-color', 'rgb(120, 180, 210)');
                element.style.setProperty('--tw-shadow-color', 'rgb(80, 30, 90)');
              });
              await shot('public-element-variables', {
                ringOffsetWidth: '3px',
                shadowColor: 'rgb(80, 30, 90)',
              });
              for (const name of ['active', 'caller', 'container']) {
                await page.locator(`[data-public-${name}]`).focus();
                await shot(`public-${name}-focused`);
              }
            }
          }
        } catch (error) {
          failures.push({
            id,
            viewport: viewport.name,
            theme,
            message: String(error),
            observation: await page
              .evaluate(() => ({
                result: document.querySelector('[data-search-table-result]')?.textContent,
                events: window.__searchTableEvents,
                marks: document.querySelectorAll('mark').length,
              }))
              .catch(() => null),
          });
          await page
            .screenshot({
              path: path.join(out, `failure-${scenario}-${viewport.name}-${theme}.png`),
            })
            .catch(() => {});
        } finally {
          await page.close();
        }
      }
      await context.close();
    }
} finally {
  const browserVersion = browser.version();
  await browser.close();
  await writeFile(
    path.join(out, 'manifest.json'),
    JSON.stringify(
      {
        phase: args.phase,
        storybook: args.storybook,
        buildFingerprint,
        browserVersion,
        harnessSha256: createHash('sha256')
          .update(await readFile(fileURLToPath(import.meta.url)))
          .digest('hex'),
        entries,
        failures,
        browserErrors,
        externalRequests,
      },
      null,
      2
    )
  );
}
assert.equal(failures.length, 0, JSON.stringify(failures));
assert.equal(browserErrors.length, 0);
assert.equal(externalRequests.length, 0);
