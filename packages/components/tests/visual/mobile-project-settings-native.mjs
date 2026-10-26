import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from '@playwright/test';

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
assert.ok(!iframe.includes('/@vite/client'), 'Immutable Storybook required');
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
  'flexShrink',
  'flexGrow',
  'flexBasis',
  'alignItems',
  'justifyContent',
  'gap',
  'margin',
  'padding',
  'borderWidth',
  'borderColor',
  'borderStyle',
  'borderRadius',
  'fontSize',
  'fontFamily',
  'fontWeight',
  'lineHeight',
  'letterSpacing',
  'fontVariantLigatures',
  'color',
  'backgroundColor',
  'opacity',
  'outline',
  'outlineOffset',
  'boxShadow',
  'transform',
  'translate',
  'rotate',
  'overflow',
  'overflowX',
  'overflowY',
  'textOverflow',
  'whiteSpace',
  'pointerEvents',
  'cursor',
  'transitionProperty',
  'transitionDuration',
  'transitionTimingFunction',
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
    delete window.__mobileProjectStable;
  });
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .filter((a) => a.effect?.getTiming().iterations !== Infinity)
      .every((a) => a.playState !== 'running')
  );
  await page.waitForFunction((properties) => {
    const value = JSON.stringify(
      [...document.querySelectorAll('[data-mobile-project-settings] *')].map((e) => {
        const s = getComputedStyle(e);
        return [e.getBoundingClientRect().toJSON(), properties.map((p) => s[p])];
      })
    );
    const previous = window.__mobileProjectStable ?? { value: '', count: 0 };
    previous.count = previous.value === value ? previous.count + 1 : 0;
    previous.value = value;
    window.__mobileProjectStable = previous;
    return previous.count >= 4;
  }, inspectedProperties);
};
try {
  for (const viewport of [
    { name: 'desktop', width: 1280, height: 900 },
    { name: 'iphone', width: 390, height: 844, device: 'iPhone 13' },
  ]) {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        ...(viewport.device ? devices[viewport.device] : {}),
        viewport: { width: viewport.width, height: viewport.height },
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
      for (const scenario of [
        'multiple',
        'root-vars',
        'subtree-vars',
        'local',
        'readonly',
        'pending',
      ]) {
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        page.on('pageerror', (error) => browserErrors.push(String(error)));
        const story =
          scenario === 'local'
            ? 'local-editors'
            : scenario === 'readonly'
              ? 'read-only'
              : scenario === 'pending'
                ? 'pending'
                : 'multiple-machines';
        const id = `mobile-ownedmobileprojectsettingsmigration--${story}`;
        const prefix = `${id}__${viewport.name}__${theme}`;
        const shot = async (name) => {
          await settle(page);
          const state = `${scenario}-${name}`,
            key = `${prefix}__${state}`;
          const observation = await page.evaluate((properties) => {
            const scope = document.querySelector('[data-mobile-project-settings]');
            return {
              intent: document.querySelector('[data-mobile-project-intent]').textContent,
              inputs: window.__mobileProjectInputs ?? [],
              media: {
                hover: matchMedia('(hover: hover)').matches,
                pointerFine: matchMedia('(pointer: fine)').matches,
                reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
              },
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
                  pressed: e.matches(':active'),
                  disabled: e.matches(':disabled'),
                  checked: e.getAttribute('aria-checked'),
                  value:
                    e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement
                      ? e.value
                      : null,
                  scroll: [e.scrollLeft, e.scrollTop, e.scrollWidth, e.clientWidth],
                };
              }),
              pageGeometry: {
                width: innerWidth,
                documentWidth: document.documentElement.scrollWidth,
                scrollX,
                scrollY,
              },
            };
          }, inspectedProperties);
          await page.screenshot({
            path: path.join(out, 'shots', `${key}.png`),
            animations: 'disabled',
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
          return observation;
        };
        try {
          await page.addInitScript(() => {
            window.__mobileProjectInputs = [];
            for (const type of [
              'pointerdown',
              'touchstart',
              'pointerup',
              'touchend',
              'mousedown',
              'mouseup',
              'click',
            ])
              document.addEventListener(
                type,
                (event) => {
                  const target = event.target instanceof Element ? event.target : null;
                  if (target?.closest('[data-mobile-project-settings]'))
                    window.__mobileProjectInputs.push({
                      type,
                      trusted: event.isTrusted,
                      target: target.tagName,
                      text: target.textContent?.slice(0, 40),
                      active: !!target.closest('button')?.matches(':active'),
                    });
                },
                { capture: true, passive: true }
              );
          });
          const url = new URL('/iframe.html', args.storybook);
          url.search = new URLSearchParams({
            id,
            viewMode: 'story',
            globals: `theme:${theme};locale:en`,
          });
          await page.goto(url.href);
          await page.locator('[data-mobile-project-settings] section').first().waitFor();
          const project = page.locator(
            '[data-mobile-project-settings] section:first-of-type button:last-of-type'
          );
          const intent = page.locator('[data-mobile-project-intent]');
          if (scenario.endsWith('vars'))
            await page.evaluate((scope) => {
              const target =
                scope === 'root-vars'
                  ? document.documentElement
                  : document.querySelector('[data-mobile-project-settings]');
              for (const [name, value] of Object.entries({
                '--spacing': '0.3125rem',
                '--radius-xl': '21px',
                '--font-weight-medium': '650',
                '--leading-tight': '1.6',
                '--primary': '28 80% 40%',
                '--foreground': '280 60% 35%',
                '--muted-foreground': '190 40% 40%',
              }))
                target.style.setProperty(name, value);
            }, scenario);
          await shot('rest');
          if (scenario === 'multiple') {
            const restBackground = await project.evaluate(
              (element) => getComputedStyle(element).backgroundColor
            );
            if (!viewport.device) {
              await project.hover();
              await shot('hover');
              await page.mouse.down();
              await shot('pressed');
              await page.mouse.up();
            } else {
              const rect = await project.boundingBox();
              assert.ok(rect);
              const cdp = await context.newCDPSession(page);
              await cdp.send('Input.dispatchTouchEvent', {
                type: 'touchStart',
                touchPoints: [{ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }],
              });
              const held = await shot('touch-held');
              assert.ok(
                held.inputs.some((event) => event.type === 'touchstart' && event.trusted),
                'Native contact must produce a trusted touchstart'
              );
              await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
              await cdp.detach();
            }
            await intent.filter({ hasText: 'open:studio-project' }).waitFor();
            await page.waitForFunction((background) => {
              const button = document.querySelector(
                '[data-mobile-project-settings] section:first-of-type button:last-of-type'
              );
              return (
                button &&
                !button.matches(':active') &&
                getComputedStyle(button).backgroundColor === background
              );
            }, restBackground);
            await page.mouse.move(0, 0);
            await shot('opened');
            await project.focus();
            await page.keyboard.press('Tab');
            await page.keyboard.press('Shift+Tab');
            await shot('keyboard-focus');
            await page.keyboard.press('Enter');
            await page
              .getByRole('button', { name: 'Several repositories or folders', exact: true })
              .click();
            await intent.filter({ hasText: 'create' }).waitFor();
            await shot('created');
            await page
              .locator('section:first-of-type')
              .getByRole('button', { name: 'Add folder', exact: true })
              .click();
            await intent.filter({ hasText: 'add:synthetic-studio' }).waitFor();
            await shot('added');
          } else if (scenario.endsWith('vars')) {
            const computed = await project.locator('svg.lucide-folders').evaluate((e) => {
              const tile = e.parentElement;
              const label = tile.nextElementSibling.firstElementChild;
              return {
                width: getComputedStyle(tile).width,
                radius: getComputedStyle(tile).borderRadius,
                weight: getComputedStyle(label).fontWeight,
                lineHeight: getComputedStyle(label).lineHeight,
              };
            });
            assert.deepEqual(computed, {
              width: '45px',
              radius: '21px',
              weight: '650',
              lineHeight: '24.32px',
            });
            await project.focus();
            await shot('focus');
          } else if (scenario === 'local') {
            await page.getByRole('switch').click();
            await intent.filter({ hasText: 'share:true' }).waitFor();
            assert.equal(await page.getByRole('switch').getAttribute('aria-checked'), 'true');
            await shot('shared');
            const field = page.locator('textarea').first();
            await field.fill('printf "synthetic edited"');
            await field.press('Tab');
            await intent.filter({ hasText: 'setup:printf "synthetic edited"' }).waitFor();
            await shot('edited');
            await page.getByRole('tab', { name: 'Claude Code', exact: true }).click();
            assert.equal(
              await page
                .getByRole('tab', { name: 'Claude Code', exact: true })
                .getAttribute('aria-selected'),
              'true'
            );
            await shot('provider');
          } else {
            assert.equal(await page.getByRole('switch').isDisabled(), true);
          }
        } catch (error) {
          failures.push({ id, viewport: viewport.name, theme, scenario, message: String(error) });
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
  }
} finally {
  const version = browser.version();
  await browser.close();
  const harnessSha256 = createHash('sha256')
    .update(await readFile(fileURLToPath(import.meta.url)))
    .digest('hex');
  await writeFile(
    path.join(out, 'manifest.json'),
    JSON.stringify(
      {
        phase: args.phase,
        storybook: args.storybook,
        buildFingerprint,
        browserVersion: version,
        harnessSha256,
        entries,
        failures,
        externalRequests,
        browserErrors,
      },
      null,
      2
    )
  );
}
assert.equal(failures.length, 0, JSON.stringify(failures));
assert.equal(externalRequests.length, 0);
assert.equal(browserErrors.length, 0);
