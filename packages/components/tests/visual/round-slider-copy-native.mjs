import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, devices } from '@playwright/test';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .flatMap((arg, index, all) => (arg.startsWith('--') ? [[arg.slice(2), all[index + 1]]] : []))
);
if (!args.phase || !args.storybook || !['slider', 'copy'].includes(args.kind))
  throw new Error(
    'usage: round-slider-copy-native.mjs --phase <phase> --storybook <url> --kind slider|copy [--engine firefox] [--probe true]'
  );
const engine = args.engine === 'firefox' ? 'firefox' : 'chromium';
if (args.kind === 'copy' && engine !== 'chromium')
  throw new Error('Clipboard permission verification uses Chromium');
const hash = (data) => createHash('sha256').update(data).digest('hex');
const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '../../artifacts/visual', args.phase);
await mkdir(path.join(outDir, 'shots'), { recursive: true });
const harnessFingerprint = hash(await readFile(fileURLToPath(import.meta.url)));
const index = await (await fetch(new URL('/index.json', args.storybook))).json();
const iframe = await (await fetch(new URL('/iframe.html', args.storybook))).text();
const browserType = engine === 'firefox' ? firefox : chromium;
let browser;
try {
  browser = await browserType.launch();
} catch {
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const prefix = engine === 'firefox' ? 'firefox-' : 'chromium_headless_shell-';
  const cached = (await readdir(cache))
    .filter((name) => name.startsWith(prefix))
    .sort((a, b) => Number(b.split('-').at(-1)) - Number(a.split('-').at(-1)));
  if (!cached.length) throw new Error(`No installed ${engine}`);
  const binary =
    engine === 'firefox'
      ? 'firefox/Nightly.app/Contents/MacOS/firefox'
      : 'chrome-headless-shell-mac-arm64/chrome-headless-shell';
  browser = await browserType.launch({ executablePath: path.join(cache, cached[0], binary) });
}

const desktop = { name: `${engine}-native`, width: 1280, height: 900 };
const touchViews = [
  { name: 'iphone-native', device: 'iPhone 13', width: 390, height: 844 },
  { name: 'android-native', device: 'Pixel 5', width: 393, height: 851 },
];
const views =
  args.probe || engine === 'firefox'
    ? [desktop]
    : args.kind === 'copy'
      ? [desktop, ...touchViews]
      : touchViews;
const themes = args.probe ? ['light'] : ['light', 'dark'];
const statesByCase =
  args.kind === 'slider'
    ? {
        interactive: ['pointer-change', 'keyboard-focus', 'minimum', 'maximum'],
        fractional: ['fractional-step', 'fractional-maximum'],
        disabled: [],
        degenerate: ['degenerate-step'],
      }
    : {
        interactive: ['transition-midpoint', 'copied', 'expired'],
        'long-value': ['copied', 'expired'],
        'empty-value': ['empty-click'],
        disabled: [],
        'consumer-card': ['consumer-revealed', 'copied-outside-hover', 'expired'],
      };
const cases = Object.keys(statesByCase).filter(
  (suffix) => !args.only || suffix.includes(args.only)
);
const storyIdFor = (suffix) =>
  `ui-${args.kind === 'slider' ? 'slider' : 'copybutton'}migration--${suffix}`;
const entries = [],
  failures = [],
  observations = [];
const layout = () => {
  const nodes = [];
  const visit = (el, key) => {
    const css = getComputedStyle(el),
      rect = el.getBoundingClientRect();
    nodes.push({
      path: key,
      tag: el.tagName.toLowerCase(),
      rect: [rect.x, rect.y, rect.width, rect.height].map((v) => Math.round(v * 100) / 100),
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
        ].map((prop) => [prop, css[prop]])
      ),
    });
    [...el.children].forEach((child, i) => visit(child, `${key}>${i}`));
  };
  [...document.body.children]
    .filter(
      (el) =>
        el.id === 'storybook-root' ||
        (!['SCRIPT', 'STYLE', 'LINK'].includes(el.tagName) &&
          !el.className?.toString().includes('sb-'))
    )
    .forEach((el, i) => visit(el, String(i)));
  return nodes;
};
const paintProperties = [
  'width',
  'height',
  'background-color',
  'background-image',
  'border-radius',
  'border-top-width',
  'border-top-color',
  'box-shadow',
  'appearance',
  'margin-top',
];

for (const viewport of views)
  for (const theme of themes)
    for (const suffix of cases) {
      const context = await browser.newContext({
        ...(viewport.device ? devices[viewport.device] : {}),
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
        colorScheme: theme,
        reducedMotion: 'no-preference',
        ...(args.kind === 'copy' ? { permissions: ['clipboard-read', 'clipboard-write'] } : {}),
      });
      const page = await context.newPage();
      if (args.kind === 'copy')
        await page.clock.install({ time: new Date('2026-10-23T09:00:00Z') });
      else await page.clock.setFixedTime(new Date('2026-10-23T09:00:00Z'));
      const storyId = storyIdFor(suffix),
        key = `${storyId}__${viewport.name}__${theme}`;
      let currentState = 'rest';
      try {
        const url = new URL('/iframe.html', args.storybook);
        url.search = new URLSearchParams({
          id: storyId,
          viewMode: 'story',
          globals: `theme:${theme};locale:en`,
        }).toString();
        await page.goto(url.href, { waitUntil: 'load' });
        await page
          .locator(
            args.kind === 'slider'
              ? 'input[type="range"]'
              : '[data-copy-fixture],[data-copy-consumer]'
          )
          .waitFor({ state: 'visible' });
        await page.evaluate(() => document.fonts.ready);
        if (args.kind === 'copy')
          await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 1000));
        const cdp = engine === 'chromium' ? await context.newCDPSession(page) : null;
        if (cdp) {
          await cdp.send('DOM.enable');
          await cdp.send('CSS.enable');
        }
        const slider = page.locator('input[type="range"]');
        const getNativePaint = async () => {
          if (engine === 'firefox')
            return await slider.evaluate(
              (input, properties) =>
                Object.fromEntries(
                  ['::-moz-range-track', '::-moz-range-thumb'].map((pseudo) => {
                    const css = getComputedStyle(input, pseudo);
                    return [
                      pseudo,
                      Object.fromEntries(
                        properties.map((prop) => [prop, css.getPropertyValue(prop)])
                      ),
                    ];
                  })
                ),
              paintProperties
            );
          const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
          const parts = [];
          const visit = (node, inRange = false) => {
            const attrs = Object.fromEntries(
              (node.attributes ?? []).reduce(
                (pairs, value, i, all) => (i % 2 === 0 ? [...pairs, [value, all[i + 1]]] : pairs),
                []
              )
            );
            const inside = inRange || (node.nodeName === 'INPUT' && attrs.type === 'range');
            if (inside && ['track', 'thumb'].includes(attrs.id))
              parts.push({ nodeId: node.nodeId, name: attrs.id });
            for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])])
              visit(child, inside);
          };
          visit(root);
          const records = [];
          for (const part of parts) {
            const computed = await cdp.send('CSS.getComputedStyleForNode', { nodeId: part.nodeId });
            records.push([
              part.name,
              Object.fromEntries(
                computed.computedStyle
                  .filter((prop) => paintProperties.includes(prop.name))
                  .map((prop) => [prop.name, prop.value])
              ),
            ]);
          }
          if (!records.some(([name]) => name === 'thumb'))
            throw new Error('Native Chromium thumb shadow DOM not inspected');
          return Object.fromEntries(records);
        };
        const shot = async (state, allowAnimations = false) => {
          currentState = state;
          const frameKey = state === 'rest' ? key : `${key}__${state}`;
          await page.screenshot({
            path: path.join(outDir, 'shots', `${frameKey}.png`),
            animations: allowAnimations ? 'allow' : 'disabled',
            caret: 'hide',
          });
          const row = {
            key: frameKey,
            state,
            storyId,
            title: `UI/${args.kind === 'slider' ? 'Slider' : 'CopyButton'}Migration`,
            viewport: viewport.name,
            theme,
            shot: `shots/${frameKey}.png`,
            layout: await page.evaluate(layout),
          };
          entries.push(row);
          observations.push(
            args.kind === 'slider'
              ? {
                  key: frameKey,
                  nativePaint: await getNativePaint(),
                  input: await slider.evaluate((input) => ({
                    value: input.value,
                    min: input.min,
                    max: input.max,
                    step: input.step,
                    fill: input.style.getPropertyValue('--lody-slider-fill'),
                    focused: document.activeElement === input,
                    focusVisible: input.matches(':focus-visible'),
                    boxShadow: getComputedStyle(input).boxShadow,
                    opacity: getComputedStyle(input).opacity,
                  })),
                }
              : {
                  key: frameKey,
                  buttonState: await page.locator('button[data-state]').getAttribute('data-state'),
                  glyphs: await page.locator('button[data-state] svg').evaluateAll((elements) =>
                    elements.map((el) => {
                      const css = getComputedStyle(el),
                        rect = el.getBoundingClientRect();
                      return {
                        label: el.getAttribute('aria-label'),
                        opacity: css.opacity,
                        filter: css.filter,
                        scale: css.scale,
                        transition: css.transition,
                        width: rect.width,
                        height: rect.height,
                      };
                    })
                  ),
                }
          );
        };
        await shot('rest');
        if (args.kind === 'slider') {
          if (suffix === 'disabled') {
            if (!(await slider.isDisabled())) throw new Error('Expected disabled native slider');
          } else if (suffix === 'interactive') {
            const box = await slider.boundingBox();
            const startX = box.x + 8 + (box.width - 16) * 0.4,
              endX = box.x + 8 + (box.width - 16) * 0.75,
              y = box.y + box.height / 2;
            if (viewport.device) {
              const point = (x) => [{ x, y, id: 1, radiusX: 1, radiusY: 1, force: 1 }];
              await cdp.send('Input.dispatchTouchEvent', {
                type: 'touchStart',
                touchPoints: point(startX),
              });
              for (let i = 1; i <= 10; i++) {
                await cdp.send('Input.dispatchTouchEvent', {
                  type: 'touchMove',
                  touchPoints: point(startX + ((endX - startX) * i) / 10),
                });
                await page.evaluate(() => new Promise(requestAnimationFrame));
              }
              await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            } else {
              await page.mouse.move(startX, y);
              await page.mouse.down();
              await page.mouse.move(endX, y, { steps: 10 });
              await page.mouse.up();
            }
            if (Number(await slider.inputValue()) <= 40)
              throw new Error('Real native drag did not change slider value');
            observations.push({
              key,
              action: viewport.device ? 'CDP real touch drag' : 'native mouse drag',
              from: [startX, y],
              to: [endX, y],
            });
            await shot('pointer-change');
            await slider.press('Tab');
            await page.keyboard.press('Shift+Tab');
            await slider.press('ArrowRight');
            await page.mouse.move(-10, -10);
            await shot('keyboard-focus');
            if (!(await slider.evaluate((input) => input.matches(':focus-visible'))))
              throw new Error('Native keyboard focus not visible');
            await slider.press('Home');
            if ((await slider.inputValue()) !== '0') throw new Error('Home must select minimum');
            await shot('minimum');
            await slider.press('End');
            if ((await slider.inputValue()) !== '100') throw new Error('End must select maximum');
            await shot('maximum');
          } else if (suffix === 'fractional') {
            await slider.focus();
            await slider.press('ArrowRight');
            if ((await slider.inputValue()) !== '1.26')
              throw new Error('Fractional native stepping changed');
            await shot('fractional-step');
            await slider.press('End');
            if ((await slider.inputValue()) !== '3') throw new Error('Fractional maximum changed');
            await shot('fractional-maximum');
          } else {
            await slider.focus();
            await slider.press('ArrowRight');
            if ((await slider.inputValue()) !== '5')
              throw new Error('Degenerate native range changed');
            await shot('degenerate-step');
          }
        } else {
          const consumer = suffix === 'consumer-card';
          const button = consumer
            ? page.locator('[data-copy-consumer] button:has(svg[aria-label="Copied"])')
            : page.getByRole('button', { name: 'Copy fixture value', exact: true });
          if (suffix === 'disabled') {
            if (!(await button.isDisabled())) throw new Error('Expected disabled CopyButton');
          } else {
            if (consumer) {
              await page.locator('[data-copy-consumer] p').first().hover();
              await shot('consumer-revealed');
            }
            const expected = consumer
              ? 'Synthetic consumer card title 中文'
              : suffix === 'empty-value'
                ? ''
                : await page.locator('[data-copy-fixture] code').textContent();
            await page.evaluate(() => navigator.clipboard.writeText('native-clipboard-sentinel'));
            if (suffix === 'interactive') {
              await button.evaluate((element) => {
                const observer = new MutationObserver(() => {
                  if (element.getAttribute('data-state') !== 'copied') return;
                  observer.disconnect();
                  const animations = element.getAnimations({ subtree: true });
                  window.__roundPausedGlyphs = [];
                  for (const animation of animations) {
                    if (animation.effect?.target instanceof SVGElement) {
                      animation.pause();
                      animation.currentTime = 100;
                      window.__roundPausedGlyphs.push(animation);
                    } else animation.finish();
                  }
                });
                observer.observe(element, { attributes: true, attributeFilter: ['data-state'] });
              });
            }
            if (viewport.device) await button.tap();
            else await button.click();
            const clipboard = await page.evaluate(() => navigator.clipboard.readText());
            if (clipboard !== (expected || 'native-clipboard-sentinel'))
              throw new Error('Real clipboard bytes do not match expected value');
            observations.push({
              key,
              action: 'trusted native activation and real Clipboard API round-trip',
              clipboard,
              expected,
              eventOutput: await page.locator('[data-copy-events]').allTextContents(),
            });
            if (!expected) {
              if ((await button.getAttribute('data-state')) !== 'not-copied')
                throw new Error('Empty value must not enter copied state');
              if (!(await page.locator('[data-copy-events]').textContent()).includes('1'))
                throw new Error('Original empty-value bubbling changed');
              await shot('empty-click');
            } else {
              if ((await button.getAttribute('data-state')) !== 'copied')
                throw new Error('Copy feedback missing');
              if (suffix === 'interactive') {
                await page.waitForFunction(
                  () => window.__roundPausedGlyphs?.length >= 4,
                  undefined,
                  { polling: 100 }
                );
                observations.push({
                  key,
                  action: 'Pause actual CSS transitions at100ms of200ms',
                  transitions: await page.evaluate(() =>
                    window.__roundPausedGlyphs.map((animation) => ({
                      property: animation.transitionProperty,
                      currentTime: animation.currentTime,
                      duration: animation.effect.getTiming().duration,
                    }))
                  ),
                });
                await shot('transition-midpoint', true);
                await page.evaluate(() => {
                  for (const animation of window.__roundPausedGlyphs) animation.finish();
                });
              }
              await page.mouse.move(-10, -10);
              await shot(consumer ? 'copied-outside-hover' : 'copied');
              await page.clock.runFor(1999);
              if ((await button.getAttribute('data-state')) !== 'copied')
                throw new Error('Copy feedback expires before2000ms');
              await page.clock.runFor(1);
              if ((await button.getAttribute('data-state')) !== 'not-copied')
                throw new Error('Copy feedback does not expire at2000ms');
              await shot('expired');
              if (args.verifyFallback && suffix === 'interactive') {
                const probe = await page.evaluate(() => {
                  const root = document.documentElement;
                  const previous = root.style.getPropertyValue('--blur-xs');
                  root.style.setProperty('--blur-xs', 'initial');
                  const hidden = document.querySelector('svg[aria-label="Copied"]');
                  for (const animation of hidden.getAnimations()) animation.finish();
                  const result = {
                    variable: getComputedStyle(hidden).getPropertyValue('--blur-xs'),
                    filter: getComputedStyle(hidden).filter,
                  };
                  if (previous) root.style.setProperty('--blur-xs', previous);
                  else root.style.removeProperty('--blur-xs');
                  return result;
                });
                if (probe.filter !== 'blur(4px)')
                  throw new Error(
                    'Production blur fallback missing without Tailwind theme variable'
                  );
                observations.push({
                  key,
                  control: 'After-only production tree-shaking simulation: --blur-xs absent',
                  ...probe,
                });
              }
            }
          }
        }
        console.log(`[native-${args.kind}] ${key}: passed`);
      } catch (error) {
        const errorShot = `shots/${key}__${currentState}__error.png`;
        await page
          .screenshot({ path: path.join(outDir, errorShot), animations: 'disabled' })
          .catch(() => {});
        failures.push({
          key: `${key}__${currentState}`,
          message: String(error?.stack ?? error),
          shot: errorShot,
        });
        console.error(`[native-${args.kind}] ${key}: ${error.message}`);
      } finally {
        await context.close();
      }
    }
await browser.close();
await writeFile(path.join(outDir, 'observations.json'), JSON.stringify(observations, null, 2));
await writeFile(path.join(outDir, 'failures.json'), JSON.stringify(failures, null, 2));
await writeFile(
  path.join(outDir, 'manifest.json'),
  JSON.stringify(
    {
      phase: args.phase,
      baseUrl: args.storybook,
      buildFingerprint: hash(iframe + JSON.stringify(index)),
      harnessFingerprint,
      browser: { engine, version: browser.version() },
      targets: {
        viewports: views,
        themes,
        ids: cases.map(storyIdFor),
        states: Object.fromEntries(
          cases.map((suffix) => [
            storyIdFor(suffix),
            statesByCase[suffix].map((name) => ({ name })),
          ])
        ),
      },
      expected:
        views.length *
        themes.length *
        cases.reduce((sum, suffix) => sum + statesByCase[suffix].length + 1, 0),
      capturedAt: new Date().toISOString(),
      entries,
    },
    null,
    2
  )
);
if (failures.length) process.exitCode = 1;
