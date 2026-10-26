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
    const dir = path.join(os.homedir(), 'Library/Caches/ms-playwright');
    const candidates = existsSync(dir)
      ? (await readdir(dir))
          .flatMap((entry) => {
            const match = /^chromium_headless_shell-(\d+)$/.exec(entry),
              shell = path.join(
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
const entries = [],
  sourceMetadata = [],
  failures = [],
  externalRequests = [],
  browserErrors = [];
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
  'flexDirection',
  'flexGrow',
  'flexShrink',
  'flexBasis',
  'alignItems',
  'justifyContent',
  'gap',
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
  'objectFit',
  'objectPosition',
  'overflow',
  'overflowX',
  'overflowY',
  'whiteSpace',
  'opacity',
  'outline',
  'boxShadow',
  'transform',
  'transformOrigin',
  'translate',
  'scale',
  'transitionProperty',
  'transitionDuration',
  'transitionTimingFunction',
  'cursor',
  'pointerEvents',
  'touchAction',
  'willChange',
  'contain',
  'filter',
  'backdropFilter',
];
const settle = async (page) => {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-file-image-host] img, img.lody-photo-slider-image')].every(
      (image) => image.complete && image.naturalWidth > 0
    )
  );
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .filter((a) => a.effect?.getTiming().iterations !== Infinity)
      .every((a) => a.playState !== 'running')
  );
  await page.evaluate(() => delete window.__fileImageStable);
  await page.waitForFunction((inspected) => {
    const nodes = [
      ...document.querySelectorAll(
        '[data-file-image-fixture], [data-file-image-fixture] *, [role="dialog"], [role="dialog"] *'
      ),
    ];
    const value = JSON.stringify(
      nodes.map((e) => {
        const css = getComputedStyle(e);
        return [
          e.getBoundingClientRect().toJSON(),
          inspected.map((p) => css[p]),
          e.scrollLeft,
          e.scrollTop,
        ];
      })
    );
    const previous = window.__fileImageStable ?? { value: '', count: 0 };
    previous.count = previous.value === value ? previous.count + 1 : 0;
    previous.value = value;
    window.__fileImageStable = previous;
    return previous.count >= 5;
  }, properties);
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
        reducedMotion: 'no-preference',
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
      for (const scenario of ['raster', 'svg', 'url', 'root-vars', 'subtree-vars']) {
        if (args.only && !new RegExp(args.only).test(`${scenario}__${viewport.name}__${theme}`))
          continue;
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        page.on('pageerror', (error) => browserErrors.push(String(error)));
        const id =
          'sessions-ownedfileimagemigration--' +
          (scenario === 'raster' ? 'raster-bytes' : scenario === 'url' ? 'url-image' : 'svg-text');
        const shot = async (state, assertions = {}) => {
          await settle(page);
          const key = `${id}__${viewport.name}__${theme}__${scenario}-${state}`;
          const observation = await page.evaluate((inspected) => {
            const inline = document.querySelector('[data-file-image-host] img');
            return {
              layout: [...document.body.querySelectorAll('*')]
                .filter((e) => !['SCRIPT', 'STYLE', 'LINK'].includes(e.tagName))
                .map((e, i) => {
                  const css = getComputedStyle(e),
                    r = e.getBoundingClientRect();
                  return {
                    path: String(i),
                    tag: e.tagName,
                    text: e.textContent?.trim().slice(0, 100),
                    label: e.getAttribute('aria-label'),
                    role: e.getAttribute('role'),
                    rect: [r.x, r.y, r.width, r.height],
                    styles: Object.fromEntries(inspected.map((p) => [p, css[p]])),
                    active: document.activeElement === e,
                    focusVisible: e.matches(':focus-visible'),
                    inert: e.inert,
                    scroll: [e.scrollLeft, e.scrollTop, e.scrollWidth, e.clientWidth],
                    image:
                      e instanceof HTMLImageElement
                        ? {
                            complete: e.complete,
                            natural: [e.naturalWidth, e.naturalHeight],
                            sourceKind: e.currentSrc.startsWith('blob:')
                              ? 'blob'
                              : e.currentSrc.startsWith('data:')
                                ? 'data'
                                : 'other',
                            sameSourceAsInline: e.currentSrc === inline.currentSrc,
                          }
                        : null,
                  };
                }),
              events: window.__fileImageEvents,
              dialogs: document.querySelectorAll('[role="dialog"]').length,
              focus: {
                tag: document.activeElement?.tagName,
                label: document.activeElement?.getAttribute('aria-label'),
              },
              media: {
                hover: matchMedia('(hover:hover)').matches,
                pointerFine: matchMedia('(pointer:fine)').matches,
                reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
              },
              viewportGeometry: {
                width: innerWidth,
                documentWidth: document.documentElement.scrollWidth,
                visualScale: visualViewport.scale,
              },
            };
          }, properties);
          const assets = await page.evaluate(async () =>
            Promise.all(
              [
                ...document.querySelectorAll(
                  '[data-file-image-host] img, img.lody-photo-slider-image'
                ),
              ].map(async (image) => {
                const response = await fetch(image.currentSrc),
                  bytes = await response.arrayBuffer();
                const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
                  .map((value) => value.toString(16).padStart(2, '0'))
                  .join('');
                return {
                  sha256,
                  bytes: bytes.byteLength,
                  mime: response.headers.get('content-type'),
                  url: image.currentSrc,
                  natural: [image.naturalWidth, image.naturalHeight],
                };
              })
            )
          );
          sourceMetadata.push({
            key,
            loadedUrls: assets.map((asset) => ({ url: asset.url, sha256: asset.sha256 })),
          });
          observation.mediaAssets = assets.map(({ url: _url, ...asset }) => asset);
          await page.screenshot({
            path: path.join(out, 'shots', key + '.png'),
            animations: 'disabled',
            caret: 'hide',
          });
          entries.push({
            id,
            key,
            state: `${scenario}-${state}`,
            viewport: viewport.name,
            theme,
            shot: `shots/${key}.png`,
            assertions,
            ...observation,
          });
          console.log(key);
          return observation;
        };
        try {
          await page.addInitScript(() => {
            window.__fileImageEvents = [];
            for (const type of [
              'pointerdown',
              'pointerup',
              'touchstart',
              'touchmove',
              'touchend',
              'click',
              'dblclick',
              'keydown',
            ])
              document.addEventListener(
                type,
                (event) => {
                  const target = event.target instanceof Element ? event.target : null;
                  if (target?.closest('[data-file-image-fixture], [role="dialog"]'))
                    window.__fileImageEvents.push({
                      type,
                      trusted: event.isTrusted,
                      pointerType: event.pointerType ?? null,
                      touches: event.touches?.length ?? null,
                      key: event.key ?? null,
                      target: target.tagName,
                      label: target.getAttribute('aria-label'),
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
          await page.waitForFunction(
            () => window.__STORYBOOK_PREVIEW__?.currentRender?.phase === 'finished'
          );
          await page.locator('[data-file-image-host] img').waitFor();
          await settle(page);
          const opener = page.getByRole('button', {
            name: 'Open image in full screen',
            exact: true,
          });
          if (scenario.endsWith('vars')) {
            await page.evaluate((scope) => {
              const target =
                scope === 'root-vars'
                  ? document.documentElement
                  : document.querySelector('[data-file-image-host]');
              target.style.setProperty('--spacing', '0.3125rem');
            }, scenario);
            await page.waitForFunction(
              () =>
                getComputedStyle(document.querySelector('[data-file-image-host] > div')).padding ===
                '15px'
            );
            await settle(page);
            assert.equal(
              await page
                .locator('[data-file-image-host] > div')
                .evaluate((e) => getComputedStyle(e).padding),
              '15px'
            );
            await shot('rest');
            continue;
          }
          await shot('rest');
          if (scenario === 'raster') continue;
          if (!viewport.device && scenario === 'svg') {
            await opener.focus();
            await shot('focus');
            await opener.press('Enter');
          } else if (viewport.device) await opener.tap();
          else await opener.click();
          const dialog = page.getByRole('dialog', { name: 'Image preview', exact: true }),
            close = dialog.getByRole('button', { name: 'Close image preview', exact: true });
          await dialog.waitFor();
          await expect(close).toBeFocused();
          if (!viewport.device) {
            await page.keyboard.press('Tab');
            await expect(close).toBeFocused();
            await page.keyboard.press('Shift+Tab');
            await expect(close).toBeFocused();
          }
          await shot('opened');
          const photo = page.locator('img.lody-photo-slider-image');
          if (viewport.device && scenario === 'svg') {
            await photo.tap();
            await expect(dialog).toHaveCount(1);
            await settle(page);
            const start = await photo.boundingBox();
            assert.ok(start);
            const x = viewport.width / 2,
              y = viewport.height / 2,
              cdp = await context.newCDPSession(page);
            await cdp.send('Input.dispatchTouchEvent', {
              type: 'touchStart',
              touchPoints: [
                { id: 1, x: x - 40, y },
                { id: 2, x: x + 40, y },
              ],
            });
            await page.evaluate(() => new Promise(requestAnimationFrame));
            let expectedScale = 1;
            let previousSpan = 80;
            for (const distance of [60, 80, 100]) {
              const span = distance * 2;
              expectedScale *= 1 + (span - previousSpan) / 200;
              await cdp.send('Input.dispatchTouchEvent', {
                type: 'touchMove',
                touchPoints: [
                  { id: 1, x: x - distance, y },
                  { id: 2, x: x + distance, y },
                ],
              });
              await page.waitForFunction(
                ({ width, height, centerX, centerY }) => {
                  const r = document
                    .querySelector('img.lody-photo-slider-image')
                    .getBoundingClientRect();
                  return (
                    Math.abs(r.width - width) < 0.1 &&
                    Math.abs(r.height - height) < 0.1 &&
                    Math.abs(r.x - (centerX - width / 2)) < 0.1 &&
                    Math.abs(r.y - (centerY - height / 2)) < 0.1
                  );
                },
                {
                  width: start.width * expectedScale,
                  height: start.height * expectedScale,
                  centerX: x,
                  centerY: y,
                }
              );
              previousSpan = span;
            }
            await settle(page);
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await settle(page);
            const zoomed = await photo.boundingBox();
            assert.ok(
              zoomed && zoomed.width > start.width * 1.1,
              `Trusted pinch must enlarge actual photo geometry: ${JSON.stringify({ start, zoomed })}`
            );
            await shot('pinched', {
              expectedScale,
              expectedWidth: start.width * expectedScale,
              expectedHeight: start.height * expectedScale,
              expectedCenter: [x, y],
              tolerance: 0.1,
            });
            await cdp.send('Input.dispatchTouchEvent', {
              type: 'touchStart',
              touchPoints: [{ id: 1, x, y }],
            });
            await page.evaluate(() => new Promise(requestAnimationFrame));
            await cdp.send('Input.dispatchTouchEvent', {
              type: 'touchMove',
              touchPoints: [{ id: 1, x: x + 36, y }],
            });
            await page.evaluate(() => new Promise(requestAnimationFrame));
            await settle(page);
            await page.waitForFunction(
              (left) =>
                Math.abs(
                  document.querySelector('img.lody-photo-slider-image').getBoundingClientRect().x -
                    left -
                    36
                ) < 0.1,
              zoomed.x
            );
            await page.waitForFunction(
              ({ top, width, height }) => {
                const r = document
                  .querySelector('img.lody-photo-slider-image')
                  .getBoundingClientRect();
                return (
                  Math.abs(r.y - top) < 0.1 &&
                  Math.abs(r.width - width) < 0.1 &&
                  Math.abs(r.height - height) < 0.1
                );
              },
              { top: zoomed.y, width: zoomed.width, height: zoomed.height }
            );
            const panned = await photo.boundingBox();
            assert.ok(
              panned && Math.abs(panned.x - zoomed.x) > 5,
              'Trusted one-finger drag must pan zoomed photo'
            );
            await shot('pan-held', {
              expectedDx: 36,
              expectedTop: zoomed.y,
              expectedWidth: zoomed.width,
              expectedHeight: zoomed.height,
              tolerance: 0.1,
            });
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await cdp.detach();
          } else if (!viewport.device && scenario === 'url') {
            const start = await photo.boundingBox();
            await photo.dblclick();
            await settle(page);
            const zoomed = await photo.boundingBox();
            assert.ok(
              start && zoomed && zoomed.height > start.height * 1.1,
              'Desktop double-click must zoom actual photo'
            );
            await shot('zoomed');
          }
          if (viewport.device) await close.tap();
          else await page.keyboard.press('Escape');
          await expect(dialog).toHaveCount(0);
          if (!viewport.device) await expect(opener).toBeFocused();
          await shot('closed');
        } catch (error) {
          failures.push({
            id,
            viewport: viewport.name,
            theme,
            scenario,
            message: String(error),
            diagnostic: await page
              .evaluate(() => {
                const host = document.querySelector('[data-file-image-host]');
                const box = host?.firstElementChild;
                return {
                  touchSupported: 'ontouchstart' in window,
                  phase: window.__STORYBOOK_PREVIEW__?.currentRender?.phase,
                  rootSpacing: getComputedStyle(document.documentElement).getPropertyValue(
                    '--spacing'
                  ),
                  hostStyle: host?.getAttribute('style'),
                  hostSpacing: host ? getComputedStyle(host).getPropertyValue('--spacing') : null,
                  boxClass: box?.className,
                  boxSpacing: box ? getComputedStyle(box).getPropertyValue('--spacing') : null,
                  padding: box ? getComputedStyle(box).padding : null,
                  images: [...document.querySelectorAll('img.lody-photo-slider-image')].map(
                    (image) => ({
                      rect: image.getBoundingClientRect().toJSON(),
                      transform: getComputedStyle(image.parentElement).transform,
                    })
                  ),
                  events: window.__fileImageEvents,
                };
              })
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
  }
} finally {
  const browserVersion = browser.version();
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
        browserVersion,
        harnessSha256,
        entries,
        sourceMetadata,
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
