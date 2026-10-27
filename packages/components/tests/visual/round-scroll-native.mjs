/** Native wheel, keyboard and thumb-drag evidence for the shared Base UI scroll area. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from '@playwright/test';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .flatMap((token, i, all) => (token.startsWith('--') ? [[token.slice(2), all[i + 1]]] : []))
);
if (!args.phase || !args.storybook) throw new Error('--phase and --storybook are required');
const out = fileURLToPath(new URL(`../../artifacts/visual/${args.phase}/`, import.meta.url));
await mkdir(path.join(out, 'shots'), { recursive: true });
const hash = (data) => createHash('sha256').update(data).digest('hex');
const iframe = await (await fetch(new URL('/iframe.html', args.storybook))).text();
if (iframe.includes('/@vite/client')) throw new Error('Use an immutable build');
const index = await (await fetch(new URL('/index.json', args.storybook))).json();
const entries = [],
  failures = [],
  actions = [];
const browser = await chromium.launch({ channel: 'chrome' });
const viewports = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'phone', width: 390, height: 844 },
];
const themes = ['light', 'dark'];
const cases = ['vertical', 'horizontal'];
const states = ['wheel', 'thumb-active', 'thumb-drag', 'keyboard-end', 'keyboard-home'];
const snapshot = () =>
  [...document.querySelectorAll('#storybook-root, #storybook-root *')].map((el, i) => {
    const r = el.getBoundingClientRect(),
      s = getComputedStyle(el);
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
        ].map((k) => [k, s[k]])
      ),
    };
  });
for (const viewport of viewports)
  for (const theme of themes)
    for (const suffix of cases) {
      const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
      const page = await context.newPage();
      const storyId = `ui-scrollareamigration--${suffix}`;
      const key = `${storyId}__${viewport.name}__${theme}`;
      try {
        await page.addInitScript(() => {
          window.__scrollInputs = [];
          for (const type of ['wheel', 'pointerdown', 'keydown'])
            document.addEventListener(
              type,
              (e) => window.__scrollInputs.push({ type, trusted: e.isTrusted, key: e.key ?? null }),
              true
            );
        });
        const url = new URL('/iframe.html', args.storybook);
        url.search = new URLSearchParams({
          id: storyId,
          viewMode: 'story',
          globals: `theme:${theme};locale:en`,
        });
        await page.goto(url.href);
        const vp = page.locator('[data-scroll-area-viewport]');
        await vp.waitFor({ state: 'visible' });
        await page.evaluate(() => document.fonts.ready);
        const horizontal = suffix === 'horizontal';
        const coordinate = horizontal ? 'scrollLeft' : 'scrollTop';
        const shot = async (state) => {
          await page.waitForFunction(() =>
            document
              .getAnimations()
              .filter((a) => a.effect?.getTiming().iterations !== Infinity)
              .every((a) => a.playState !== 'running')
          );
          const stateKey = `${key}__${state}`;
          const value = await vp.evaluate((e, c) => e[c], coordinate);
          await page.screenshot({
            path: path.join(out, 'shots', `${stateKey}.png`),
            animations: 'disabled',
            caret: 'hide',
          });
          entries.push({
            key: stateKey,
            state,
            storyId,
            title: 'Ui/ScrollAreaMigration — native input',
            viewport: viewport.name,
            theme,
            shot: `shots/${stateKey}.png`,
            layout: await page.evaluate(snapshot),
          });
          actions.push({
            key: stateKey,
            value,
            events: await page.evaluate(() => window.__scrollInputs),
          });
        };
        await vp.hover();
        await page.mouse.wheel(horizontal ? 300 : 0, horizontal ? 0 : 300);
        await page.waitForFunction(
          ({ c }) => document.querySelector('[data-scroll-area-viewport]')[c] === 300,
          { c: coordinate }
        );
        await shot('wheel');
        const thumb = page.locator(
          `[data-orientation="${horizontal ? 'horizontal' : 'vertical'}"] > div`
        );
        const box = await thumb.boundingBox();
        if (!box) throw new Error('Missing real thumb');
        const x = box.x + box.width / 2,
          y = box.y + box.height / 2;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await shot('thumb-active');
        await page.mouse.move(x + (horizontal ? 30 : 0), y + (horizontal ? 0 : 30), { steps: 6 });
        await page.mouse.up();
        await page.waitForFunction(
          ({ c }) => document.querySelector('[data-scroll-area-viewport]')[c] > 300,
          { c: coordinate }
        );
        await page.mouse.move(0, 0);
        await shot('thumb-drag');
        if (horizontal) {
          const events = await page.evaluate(() => window.__scrollInputs);
          if (
            !['wheel', 'pointerdown'].every((type) =>
              events.some((e) => e.type === type && e.trusted)
            )
          )
            throw new Error('Missing trusted horizontal input');
          continue;
        }
        await vp.focus();
        await page.keyboard.press('End');
        await page.waitForFunction(
          ({ c, h }) => {
            const e = document.querySelector('[data-scroll-area-viewport]');
            return (
              Math.abs(
                e[c] - (h ? e.scrollWidth - e.clientWidth : e.scrollHeight - e.clientHeight)
              ) < 1
            );
          },
          { c: coordinate, h: horizontal }
        );
        await shot('keyboard-end');
        await page.keyboard.press('Home');
        await page.waitForFunction(
          ({ c }) => document.querySelector('[data-scroll-area-viewport]')[c] === 0,
          { c: coordinate }
        );
        await shot('keyboard-home');
        const events = await page.evaluate(() => window.__scrollInputs);
        if (
          !['wheel', 'pointerdown', 'keydown'].every((type) =>
            events.some((e) => e.type === type && e.trusted)
          )
        )
          throw new Error('Missing trusted browser input');
      } catch (e) {
        failures.push({ key, message: String(e.stack ?? e) });
      } finally {
        await context.close();
      }
    }
await browser.close();
await writeFile(
  path.join(out, 'manifest.json'),
  JSON.stringify(
    {
      phase: args.phase,
      baseUrl: args.storybook,
      buildFingerprint: hash(iframe + JSON.stringify(index)),
      harnessFingerprint: hash(await readFile(fileURLToPath(import.meta.url))),
      targets: { viewports, themes, ids: cases, states },
      expected: viewports.length * themes.length * 8,
      capturedAt: new Date().toISOString(),
      entries,
    },
    null,
    2
  )
);
await writeFile(path.join(out, 'failures.json'), JSON.stringify(failures, null, 2));
await writeFile(path.join(out, 'actions.json'), JSON.stringify(actions, null, 2));
console.log(`${entries.length} native frames; ${failures.length} failures`);
if (failures.length) process.exitCode = 1;
