import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .flatMap((x, i, all) => (x.startsWith('--') ? [[x.slice(2), all[i + 1]]] : []))
);
if (!args.phase || !args.storybook) throw Error('--phase and --storybook required');
const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(pkg, 'artifacts/visual', args.phase);
await mkdir(path.join(out, 'shots'), { recursive: true });
const iframe = await (await fetch(new URL('/iframe.html', args.storybook))).text();
assert.ok(!iframe.includes('/@vite/client'), 'Immutable build required');
const index = await (await fetch(new URL('/index.json', args.storybook))).text();
const buildFingerprint = createHash('sha256').update(iframe).update(index).digest('hex');
const browser = await (async () => {
  try {
    return await chromium.launch();
  } catch (error) {
    const root = path.join(os.homedir(), 'Library/Caches/ms-playwright');
    const candidates = existsSync(root)
      ? (await readdir(root))
          .flatMap((entry) => {
            const match = /^chromium_headless_shell-(\d+)$/.exec(entry);
            const shell = path.join(
              root,
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
const entries = [],
  failures = [],
  externalRequests = [],
  browserErrors = [];
const inspectedProperties = [
  'display',
  'position',
  'width',
  'height',
  'minWidth',
  'maxWidth',
  'flex',
  'alignItems',
  'justifyContent',
  'gap',
  'margin',
  'padding',
  'borderWidth',
  'borderColor',
  'borderRadius',
  'fontSize',
  'fontFamily',
  'fontWeight',
  'lineHeight',
  'color',
  'backgroundColor',
  'opacity',
  'outline',
  'boxShadow',
  'transform',
  'pointerEvents',
  'cursor',
];
const settle = async (page) => {
  await page.evaluate(async () => {
    await document.fonts.ready;
    for (const animation of document.getAnimations()) {
      if (animation.effect?.getTiming().iterations === Infinity) {
        animation.pause();
        animation.currentTime = 0;
      }
    }
  });
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .filter((a) => a.effect?.getTiming().iterations !== Infinity)
      .every((a) => a.playState !== 'running')
  );
  await page.evaluate(() => {
    delete window.__ownedLoginStable;
  });
  await page.waitForFunction(() => {
    const value = JSON.stringify(
      [...document.querySelectorAll('[data-owned-login-ready] *')].map((e) =>
        e.getBoundingClientRect().toJSON()
      )
    );
    const previous = window.__ownedLoginStable ?? { value: '', count: 0 };
    previous.count = previous.value === value ? previous.count + 1 : 0;
    previous.value = value;
    window.__ownedLoginStable = previous;
    return previous.count >= 3;
  });
};
try {
  for (const viewport of [
    { name: 'desktop', width: 1280, height: 900 },
    { name: 'phone', width: 390, height: 844 },
  ]) {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport,
        deviceScaleFactor: 1,
        colorScheme: theme,
        reducedMotion: 'reduce',
      });
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (
          ['http:', 'https:'].includes(url.protocol) &&
          !['localhost', '127.0.0.1'].includes(url.hostname)
        ) {
          externalRequests.push(url.origin + url.pathname);
          return route.abort();
        }
        return route.continue();
      });
      for (const scenario of ['providers', 'email-root', 'email-scoped', 'handoff-root']) {
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        page.on('pageerror', (error) => browserErrors.push(String(error)));
        const prefix = `${scenario}__${viewport.name}__${theme}`;
        const shot = async (state) => {
          await settle(page);
          const key = `${prefix}__${state}`;
          const observation = await page.evaluate((properties) => {
            const scope = document.querySelector('[data-owned-login-ready]');
            return {
              intent: document.querySelector('[data-owned-login-intent]').textContent,
              layout: [...scope.querySelectorAll('*')].map((e, i) => {
                const s = getComputedStyle(e),
                  r = e.getBoundingClientRect();
                return {
                  path: String(i),
                  tag: e.tagName,
                  text: e.textContent?.trim().slice(0, 100),
                  rect: [r.x, r.y, r.width, r.height],
                  styles: Object.fromEntries(properties.map((p) => [p, s[p]])),
                  active: document.activeElement === e,
                  focusVisible: e.matches(':focus-visible'),
                  disabled: e.matches(':disabled'),
                  value: e instanceof HTMLInputElement ? e.value : null,
                };
              }),
              icons: [...scope.querySelectorAll('button span > svg')]
                .filter((e) => e.parentElement.parentElement?.tagName === 'SPAN')
                .map((e) => ({
                  width: getComputedStyle(e).width,
                  height: getComputedStyle(e).height,
                })),
              spinners: [...scope.querySelectorAll('[data-slot="spinner"]')].map((e) => ({
                marginRight: getComputedStyle(e).marginRight,
                width: getComputedStyle(e).width,
                height: getComputedStyle(e).height,
              })),
              viewport: [innerWidth, document.documentElement.scrollWidth],
            };
          }, inspectedProperties);
          if (scenario === 'providers') {
            const icons = await page.getByRole('button').evaluateAll((buttons) =>
              buttons.flatMap((button) =>
                [...button.querySelectorAll('svg')].map((svg) => ({
                  width: getComputedStyle(svg).width,
                  height: getComputedStyle(svg).height,
                }))
              )
            );
            assert.ok(icons.length >= 5);
            assert.ok(
              icons.every((x) => x.width === '18px' && x.height === '18px'),
              'Provider descendant important sizes must stay18px'
            );
          }
          if (state === 'pending') {
            assert.equal(observation.spinners.length, 1);
            assert.deepEqual(observation.spinners[0], {
              marginRight: '10px',
              width: '20px',
              height: '20px',
            });
          }
          await page.screenshot({
            path: path.join(out, 'shots', `${key}.png`),
            animations: 'disabled',
            caret: 'hide',
          });
          entries.push({
            key,
            state,
            scenario,
            viewport: viewport.name,
            theme,
            shot: `shots/${key}.png`,
            ...observation,
          });
          console.log(key);
        };
        try {
          const story =
            scenario === 'providers'
              ? 'scoped-providers'
              : scenario === 'email-scoped'
                ? 'scoped-email-pending'
                : scenario === 'email-root'
                  ? 'email-pending'
                  : 'handoff-pending';
          const url = new URL('/iframe.html', args.storybook);
          url.search = new URLSearchParams({
            id: `components-ownedloginmigration--${story}`,
            viewMode: 'story',
            globals: `theme:${theme};locale:en`,
          });
          await page.goto(url.href);
          await page.locator('[data-owned-login-ready]').waitFor();
          await page.locator('#login-title').waitFor();
          if (scenario.endsWith('root'))
            await page.evaluate(() =>
              document.documentElement.style.setProperty('--spacing', '0.3125rem')
            );
          if (scenario === 'providers') {
            await shot('rest');
            const button = page.getByRole('button', { name: 'Continue with Google', exact: true });
            await button.hover();
            await shot('hover');
            await page.mouse.down();
            await shot('pointer-held');
            await page.mouse.move(-10, -10);
            await page.mouse.up();
            await page.keyboard.press('Tab');
            await button.focus();
            await shot('focus');
          } else if (scenario.startsWith('email')) {
            if (scenario === 'email-root') await shot('rest');
            await page.locator('#email-auth-email').fill('fixture@example.com');
            await page.locator('input[type="password"]').fill('synthetic-password');
            await page.locator('button[type="submit"]').click();
            await page
              .locator('[data-owned-login-intent]')
              .filter({ hasText: 'Synthetic email requested' })
              .waitFor();
            await shot('pending');
          } else {
            await page
              .getByRole('button', { name: 'Continue with this account', exact: true })
              .click();
            await page
              .locator('[data-owned-login-intent]')
              .filter({ hasText: 'Synthetic handoff requested' })
              .waitFor();
            await shot('pending');
          }
        } catch (error) {
          failures.push({ key: prefix, error: String(error) });
          await page
            .screenshot({
              path: path.join(out, 'shots', `${prefix}__failed.png`),
              animations: 'disabled',
            })
            .catch(() => {});
        } finally {
          await page.close();
        }
      }
      await context.close();
    }
  }
} finally {
  await writeFile(
    path.join(out, 'manifest.json'),
    JSON.stringify(
      {
        phase: args.phase,
        baseUrl: args.storybook,
        buildFingerprint,
        harnessFingerprint: createHash('sha256')
          .update(await readFile(fileURLToPath(import.meta.url)))
          .digest('hex'),
        browserVersion: browser.version(),
        animationControl:
          'Infinite CSS animations paused at currentTime0 equally on both builds; finite animations and geometry awaited.',
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
assert.equal(failures.length, 0);
assert.equal(externalRequests.length, 0);
assert.equal(browserErrors.length, 0);
assert.equal(entries.length, 32);
