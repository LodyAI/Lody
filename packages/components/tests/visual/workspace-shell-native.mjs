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
    .flatMap((arg, i, all) => (arg.startsWith('--') ? [[arg.slice(2), all[i + 1]]] : []))
);
if (!args.phase || !args.storybook) throw new Error('--phase and --storybook required');
const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(pkg, 'artifacts/visual', args.phase);
await mkdir(path.join(out, 'shots'), { recursive: true });
const iframe = await (await fetch(new URL('/iframe.html', args.storybook))).text();
assert.ok(!iframe.includes('/@vite/client'), 'Immutable Storybook required');
const index = await (await fetch(new URL('/index.json', args.storybook))).text();
const fingerprint = createHash('sha256').update(iframe).update(index).digest('hex');
const browser = await (async () => {
  try {
    return await chromium.launch();
  } catch (error) {
    const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
    if (!existsSync(cache)) throw error;
    const candidates = (await readdir(cache))
      .flatMap((entry) => {
        const match = /^chromium_headless_shell-(\d+)$/.exec(entry);
        const executable = path.join(
          cache,
          entry,
          'chrome-headless-shell-mac-arm64/chrome-headless-shell'
        );
        return match && existsSync(executable) ? [{ executable, revision: Number(match[1]) }] : [];
      })
      .sort((a, b) => b.revision - a.revision);
    if (!candidates.length) throw error;
    return chromium.launch({ executablePath: candidates[0].executable });
  }
})();
const entries = [],
  failures = [],
  externalRequests = [],
  browserErrors = [];
const prefix = 'components-ownedworkspaceshellmigration--';
const properties = [
  'display',
  'position',
  'inset',
  'zIndex',
  'width',
  'height',
  'minWidth',
  'maxWidth',
  'flex',
  'flexDirection',
  'flexShrink',
  'alignItems',
  'justifyContent',
  'gap',
  'margin',
  'padding',
  'borderWidth',
  'borderColor',
  'borderRadius',
  'boxShadow',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'fontVariantLigatures',
  'color',
  'backgroundColor',
  'opacity',
  'pointerEvents',
  'cursor',
  'outline',
  'transform',
  'translate',
  'rotate',
  'whiteSpace',
  'overflow',
  'textOverflow',
];
const settle = async (page) => {
  await page.evaluate(async () => {
    await document.fonts.ready;
    const animations = document
      .getAnimations()
      .filter((animation) => animation.effect?.getTiming().iterations === Infinity);
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = 0;
    }
    await Promise.all(animations.map((animation) => animation.ready));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
      .every((animation) => animation.playState !== 'running')
  );
  await page.evaluate(() => {
    delete window.__workspaceShellStable;
  });
  await page.waitForFunction(() => {
    const value = JSON.stringify(
      [
        ...document.querySelectorAll(
          '#storybook-root *,[role="dialog"] *,[role="alertdialog"] *,[role="menu"] *'
        ),
      ].map((node) => {
        const rect = node.getBoundingClientRect(),
          css = getComputedStyle(node);
        return [
          rect.x,
          rect.y,
          rect.width,
          rect.height,
          css.transform,
          css.color,
          css.backgroundColor,
          css.opacity,
        ];
      })
    );
    const old = window.__workspaceShellStable ?? { value: '', count: 0 };
    old.count = old.value === value ? old.count + 1 : 0;
    old.value = value;
    window.__workspaceShellStable = old;
    return old.count >= 4;
  });
};
let expected = 0;
const descriptors = [
  { name: 'desktop', options: { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 } },
  {
    name: 'iphone-chromium',
    options: {
      ...devices['iPhone 13'],
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
    },
  },
];
try {
  for (const viewport of descriptors)
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        ...viewport.options,
        colorScheme: theme,
        reducedMotion: 'reduce',
        locale: 'en-US',
        timezoneId: 'UTC',
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
      const scenarios =
        viewport.name === 'desktop'
          ? ['default', 'root-variable-scope', 'subtree-variable-scope']
          : ['default'];
      for (const scenario of scenarios) {
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        const id = prefix + scenario,
          keyPrefix = `${scenario}__${viewport.name}__${theme}`;
        page.on('pageerror', (error) =>
          browserErrors.push({ key: keyPrefix, error: String(error) })
        );
        const shot = async (state) => {
          await settle(page);
          const observation = await page.evaluate(
            (names) => ({
              layout: [
                ...document.querySelectorAll(
                  '#storybook-root *,[role="menu"] *,[data-base-ui-focusable][data-side],[data-base-ui-focusable][data-side] *'
                ),
              ].map((node, nodeIndex) => {
                const rect = node.getBoundingClientRect(),
                  css = getComputedStyle(node);
                return {
                  path: String(nodeIndex),
                  tag: node.tagName,
                  text: node.childElementCount ? '' : node.textContent,
                  role: node.getAttribute('role'),
                  label: node.getAttribute('aria-label'),
                  rect: [rect.x, rect.y, rect.width, rect.height],
                  styles: Object.fromEntries(names.map((name) => [name, css[name]])),
                  active: document.activeElement === node,
                  focusVisible: node.matches(':focus-visible'),
                  disabled: node.matches(':disabled'),
                  before: getComputedStyle(node, '::before').content,
                  after: getComputedStyle(node, '::after').content,
                };
              }),
              result: document.querySelector('[data-workspace-shell-result]').textContent,
              width: document
                .querySelector('[data-workspace-shell-result]')
                .getAttribute('data-width'),
              workspace: document
                .querySelector('[data-workspace-shell-result]')
                .getAttribute('data-workspace'),
              collapsed: document
                .querySelector('[data-workspace-shell-result]')
                .getAttribute('data-collapsed'),
              nav: document.querySelector('[data-workspace-shell-result]').getAttribute('data-nav'),
              events: window.__workspaceShellInputs,
              viewportGeometry: [innerWidth, document.documentElement.scrollWidth],
            }),
            properties
          );
          const key = `${keyPrefix}__${state}`;
          await page.screenshot({
            path: path.join(out, 'shots', `${key}.png`),
            animations: 'allow',
            caret: 'hide',
          });
          entries.push({
            id,
            viewport: viewport.name,
            theme,
            state,
            key,
            shot: `shots/${key}.png`,
            ...observation,
          });
          console.log(key);
        };
        expected += scenario !== 'default' ? 2 : viewport.name === 'desktop' ? 10 : 4;
        try {
          await page.clock.setFixedTime(new Date('2026-10-22T09:00:00Z'));
          await page.addInitScript(() => {
            window.__workspaceShellInputs = [];
            for (const type of ['pointerdown', 'pointerup', 'keydown', 'click'])
              document.addEventListener(
                type,
                (event) =>
                  window.__workspaceShellInputs.push({
                    type,
                    trusted: event.isTrusted,
                    key: event.key ?? null,
                    pointerType: event.pointerType ?? null,
                  }),
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
          await page.locator('[data-sidebar-footer]').waitFor();
          const result = page.locator('[data-workspace-shell-result]');
          await page.locator('[data-workspace-switcher-trigger]').click();
          await expect(page.getByRole('menu')).toBeVisible();
          await shot('workspace-menu');
          await page
            .getByRole('menuitemradio')
            .filter({ hasText: 'Second Synthetic Workspace' })
            .click();
          await expect(result).toHaveText('Workspace synthetic-two');
          await expect(page.getByRole('menu')).toHaveCount(0);
          await shot('workspace-selected');
          if (scenario !== 'default') continue;
          const action = (name) => page.getByRole('button', { name, exact: true });
          if (viewport.name === 'desktop') {
            await action('Toggle Sidebar').hover();
            await expect(
              page
                .locator('[data-base-ui-focusable][data-side]')
                .filter({ hasText: /^Toggle Sidebar$/ })
            ).toBeVisible();
            await shot('header-tooltip');
            await page.mouse.move(600, 30);
            await expect(
              page
                .locator('[data-base-ui-focusable][data-side]')
                .filter({ hasText: /^Toggle Sidebar$/ })
            ).toHaveCount(0);
            await action('Help').click();
            await expect(page.getByRole('menu')).toBeVisible();
            await shot('help-menu');
            await page.getByRole('menuitem', { name: 'Docs', exact: true }).click();
            await expect(result).toHaveText('Docs');
            await expect(page.getByRole('menu')).toHaveCount(0);
          }
          await action('Archive').click();
          await expect(result).toHaveText('Archive');
          if (viewport.name === 'desktop') {
            await action('Leave Archive').hover();
            await shot('archive-hover');
            await page.mouse.move(600, 30);
          }
          await action('Help').focus();
          await page.keyboard.press('Tab');
          await expect(action('Leave Archive')).toBeFocused();
          await expect(action('Leave Archive')).toHaveJSProperty('type', 'button');
          await shot('archive-keyboard-focus');
          if (viewport.name !== 'desktop') {
            await action('Settings').click();
            await expect(result).toHaveText('Settings');
            await shot('settings-callback');
            continue;
          }
          const handle = page.locator('[data-sidebar-resize-handle]'),
            box = await handle.boundingBox();
          assert.ok(box);
          await page.mouse.move(box.x + box.width / 2, box.y + 100);
          await page.mouse.down();
          await page.mouse.move(box.x + box.width / 2 + 70, box.y + 100, { steps: 3 });
          await expect(result).toHaveAttribute('data-width', '370');
          await shot('resize-held');
          await page.mouse.up();
          await shot('resize-released');
          await action('Toggle Sidebar').click();
          await expect(result).toHaveAttribute('data-collapsed', 'true');
          await expect(page.locator('[data-sidebar-footer]')).toHaveCount(0);
          await shot('collapsed');
          await action('Restore sidebar').click();
          await expect(page.locator('[data-sidebar-footer]')).toBeVisible();
          await expect(result).toHaveAttribute('data-collapsed', 'false');
          await expect(page.locator('[data-workspace-shell-surface] > div')).toHaveCSS(
            'width',
            '370px'
          );
          await shot('restored');
        } catch (error) {
          failures.push({ key: keyPrefix, error: String(error) });
          console.error(keyPrefix, String(error));
          await page
            .screenshot({
              path: path.join(out, 'shots', `${keyPrefix}__error.png`),
              animations: 'allow',
            })
            .catch(() => {});
        } finally {
          await page.close();
        }
      }
      await context.close();
    }
} finally {
  await writeFile(
    path.join(out, 'manifest.json'),
    JSON.stringify(
      {
        phase: args.phase,
        storybook: args.storybook,
        fingerprint,
        harnessSha: createHash('sha256')
          .update(await readFile(fileURLToPath(import.meta.url)))
          .digest('hex'),
        browserVersion: browser.version(),
        animationControl:
          'Infinite animations paused natively at time0; finite animations, fonts and stable geometry awaited.',
        expected,
        entries,
        failures,
        externalRequests,
        browserErrors,
      },
      null,
      2
    ) + '\n'
  );
  await browser.close();
}
console.log(
  JSON.stringify({ expected, entries: entries.length, failures, externalRequests, browserErrors })
);
assert.equal(failures.length, 0);
assert.equal(entries.length, expected);
assert.equal(externalRequests.length, 0);
assert.equal(browserErrors.length, 0);
