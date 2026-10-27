/** Real status components at fixed native animation times; no production animation replacement. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .flatMap((arg, i, all) => (arg.startsWith('--') ? [[arg.slice(2), all[i + 1]]] : []))
);
if (!args.phase || !args.storybook) throw new Error('--phase and --storybook required');
const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(pkg, 'artifacts/visual', args.phase);
await mkdir(path.join(out, 'shots'), { recursive: true });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const iframe = await (await fetch(new URL('/iframe.html', args.storybook))).text();
if (iframe.includes('/@vite/client')) throw new Error('Immutable Storybook build required');
const index = await (await fetch(new URL('/index.json', args.storybook))).json();
const browser = await chromium.launch({ channel: 'chrome' });
const entries = [],
  failures = [],
  observations = [];
const viewports = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'phone', width: 390, height: 844 },
];
const themes = ['light', 'dark'];
const motions = ['reduce', 'no-preference'];
const snapshot = () =>
  [...document.querySelectorAll('#storybook-root, #storybook-root *')].map((el, i) => {
    const r = el.getBoundingClientRect(),
      s = getComputedStyle(el);
    return {
      path: String(i),
      tag: el.tagName.toLowerCase(),
      rect: [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 100) / 100),
      text: el.childElementCount ? '' : (el.textContent ?? '').trim().slice(0, 80),
      ...Object.fromEntries(
        [
          'display',
          'position',
          'flexShrink',
          'width',
          'height',
          'color',
          'backgroundColor',
          'borderRadius',
          'opacity',
          'transform',
          'transformOrigin',
          'visibility',
          'willChange',
          'animationDuration',
          'animationIterationCount',
        ].map((key) => [key, s[key]])
      ),
    };
  });

for (const viewport of viewports)
  for (const theme of themes)
    for (const motion of motions) {
      const context = await browser.newContext({
        viewport,
        colorScheme: theme,
        reducedMotion: motion,
      });
      for (const suffix of [
        'grids',
        'collapse',
        'transition',
        'spinner-state',
        'caller-overrides',
        'spinners',
      ]) {
        const page = await context.newPage();
        const storyId = `ui-statusmigration--${suffix}`;
        const key = `${storyId}__${viewport.name}__${theme}__${motion}`;
        try {
          const url = new URL('/iframe.html', args.storybook);
          url.search = new URLSearchParams({
            id: storyId,
            viewMode: 'story',
            globals: `theme:${theme};locale:en`,
          });
          await page.goto(url.href);
          await page.locator('[data-status-fixture]').waitFor({ state: 'visible' });
          await page.evaluate(() => document.fonts.ready);
          await page.waitForFunction(
            (mode) => document.documentElement.classList.contains('dark') === (mode === 'dark'),
            theme
          );
          const freeze = async (selector, time, requireAnimations = true) => {
            if (requireAnimations)
              await page.waitForFunction(
                (s) => document.querySelector(s)?.getAnimations({ subtree: true }).length > 0,
                selector
              );
            return page.evaluate(
              async ({ selector: query, time: at }) => {
                const root = document.querySelector(query);
                if (!root) throw new Error(`Missing ${query}`);
                const animations = root.getAnimations({ subtree: true });
                for (const animation of animations) {
                  animation.pause();
                  animation.currentTime = at;
                }
                await Promise.all(animations.map((animation) => animation.ready));
                await new Promise((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(resolve))
                );
                return animations.map((animation) => {
                  const target = animation.effect?.target;
                  return {
                    targetTag: target?.tagName,
                    target:
                      target?.getAttribute('data-status-spinner') ??
                      target?.getAttribute('data-row'),
                    currentTime: animation.currentTime,
                    ...animation.effect?.getTiming(),
                  };
                });
              },
              { selector, time }
            );
          };
          const shot = async (state, detail = {}) => {
            const frameKey = `${key}__${state}`;
            await page.mouse.move(-10, -10);
            await page.waitForFunction(() =>
              document
                .getAnimations()
                .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
                .every((animation) => animation.playState !== 'running')
            );
            await page.evaluate(
              () =>
                new Promise((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(resolve))
                )
            );
            await page.screenshot({
              path: path.join(out, 'shots', `${frameKey}.png`),
              animations: 'allow',
              caret: 'hide',
            });
            entries.push({
              key: frameKey,
              storyId,
              title: `UI/StatusMigration native / ${motion}`,
              viewport: viewport.name,
              theme,
              state,
              shot: `shots/${frameKey}.png`,
              layout: await page.evaluate(snapshot),
            });
            observations.push({ key: frameKey, motion, ...detail });
          };
          if (suffix === 'grids') {
            if (motion === 'reduce') {
              const count = await page
                .locator('[data-status-fixture]')
                .evaluate((root) => root.getAnimations({ subtree: true }).length);
              if (count !== 0) throw new Error('Reduced-motion grids unexpectedly animate');
              await shot('static', { animations: count });
            } else
              for (const time of [0, 420, 1100]) {
                const timing = await freeze('[data-status-fixture]', time);
                if (timing.some((entry) => entry.targetTag === 'svg'))
                  throw new Error('Animation unexpectedly targets SVG');
                await shot(`time-${time}`, { timing });
              }
          } else if (suffix === 'collapse') {
            if (motion === 'reduce') {
              await page.getByText('Completed 2', { exact: true }).waitFor();
              await shot('completed');
            } else {
              for (const time of [0, 240, 520, 820]) {
                const timing = await freeze('[data-status-fixture]', time);
                await shot(`time-${time}`, { timing });
              }
              await page.locator('[data-status-fixture]').evaluate((root) => {
                for (const animation of root.getAnimations({ subtree: true })) animation.finish();
              });
              await page.getByText('Completed 2', { exact: true }).waitFor();
              await shot('completed');
            }
          } else if (suffix === 'transition') {
            if (motion !== 'reduce') await freeze('[data-status-transition]', 420);
            await shot('working');
            await page.getByRole('button', { name: 'Finish unread', exact: true }).click();
            await page.getByText('Unread', { exact: true }).waitFor();
            if (motion === 'reduce') {
              await page.locator('[data-session-unread-dot]').waitFor();
              await shot('unread');
            } else {
              const timing = await freeze('[data-status-transition]', 520);
              await shot('collapsing', { timing });
              await page.locator('[data-status-transition]').evaluate((root) => {
                for (const animation of root.getAnimations({ subtree: true })) animation.finish();
              });
              await page.locator('[data-session-unread-dot]').waitFor();
              await shot('unread');
            }
            await page.getByRole('button', { name: 'Clear status', exact: true }).click();
            await page.getByText('Idle', { exact: true }).waitFor();
            if (await page.locator('[data-status-transition]').locator('> *').count())
              throw new Error('Idle status still renders a mark');
            await shot('idle');
          } else if (suffix === 'caller-overrides') {
            for (const time of motion === 'reduce' ? [0] : [0, 520]) {
              const timing = await freeze('[data-status-fixture]', time, motion !== 'reduce');
              const caller = await page.locator('[data-status-grid="caller"]').evaluate((root) => {
                const s = getComputedStyle(root);
                return {
                  marginLeft: s.marginLeft,
                  color: s.color,
                  opacity: s.opacity,
                  display: s.display,
                  width: s.width,
                  height: s.height,
                  flexShrink: s.flexShrink,
                };
              });
              if (
                caller.marginLeft !== '12px' ||
                caller.color !== 'rgb(72, 110, 160)' ||
                caller.opacity !== '0.65' ||
                caller.display !== 'block' ||
                caller.width !== '64px' ||
                caller.height !== '64px' ||
                caller.flexShrink !== '1'
              )
                throw new Error(`Caller contract changed: ${JSON.stringify(caller)}`);
              await shot(`time-${time}`, { timing, caller });
            }
          } else if (suffix === 'spinners') {
            for (const time of motion === 'reduce' ? [0] : [0, 250, 750]) {
              if (motion === 'reduce')
                await page.waitForFunction(() =>
                  document
                    .querySelector('[data-status-fixture]')
                    .getAnimations({ subtree: true })
                    .every((animation) => animation.playState !== 'running')
                );
              const timing = await freeze('[data-status-fixture]', time, motion !== 'reduce');
              const boxes = await page.locator('[data-status-spinner]').evaluateAll((roots) =>
                roots.map((root) => {
                  const glyph = root.querySelector('svg');
                  if (!glyph) throw new Error('Spinner lost its glyph');
                  const r = root.getBoundingClientRect(),
                    g = glyph.getBoundingClientRect(),
                    s = getComputedStyle(root);
                  return {
                    name: root.getAttribute('data-status-spinner'),
                    width: r.width,
                    height: r.height,
                    centerDelta: [
                      r.x + r.width / 2 - g.x - g.width / 2,
                      r.y + r.height / 2 - g.y - g.height / 2,
                    ],
                    color: s.color,
                    flexShrink: s.flexShrink,
                    marginLeft: s.marginLeft,
                  };
                })
              );
              if (boxes.some((box) => box.centerDelta.some((delta) => Math.abs(delta) > 0.02)))
                throw new Error(`Spinner orbits its wrapper: ${JSON.stringify(boxes)}`);
              const caller = boxes.find((box) => box.name === 'caller');
              if (caller?.marginLeft !== '12px' || caller.color !== 'rgb(72, 110, 160)')
                throw new Error(`Spinner caller contract changed: ${JSON.stringify(caller)}`);
              if (boxes.some((box) => box.flexShrink !== '0'))
                throw new Error('Spinner can be squished');
              await shot(`time-${time}`, { timing, boxes });
            }
          } else {
            await page.getByText('Resting', { exact: true }).waitFor();
            const count = await page
              .locator('[data-status-spinner="toggle"]')
              .evaluate((root) => root.getAnimations({ subtree: true }).length);
            if (count !== 0) throw new Error('Resting spinner unexpectedly animates');
            await shot('resting');
            await page.getByRole('button', { name: 'Toggle spinner', exact: true }).click();
            await page.getByText('Spinning', { exact: true }).waitFor();
            if (motion === 'reduce') {
              await page.waitForFunction(() =>
                document
                  .querySelector('[data-status-spinner="toggle"]')
                  .getAnimations({ subtree: true })
                  .every((animation) => animation.playState !== 'running')
              );
              await shot('spinning-reduced');
            } else
              for (const time of [0, 250, 750]) {
                const timing = await freeze('[data-status-spinner="toggle"]', time);
                if (timing.some((entry) => entry.targetTag !== 'SPAN'))
                  throw new Error('Spinner rotation left its HTML wrapper');
                await shot(`spinning-${time}`, { timing });
              }
          }
        } catch (error) {
          console.error(key, String(error.stack ?? error));
          failures.push({ key, message: String(error.stack ?? error) });
          await page
            .screenshot({
              path: path.join(out, 'shots', `${key}__failure.png`),
              animations: 'allow',
            })
            .catch(() => {});
        } finally {
          await page.close();
        }
      }
      await context.close();
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
      targets: {
        viewports,
        themes,
        motions,
        ids: ['grids', 'collapse', 'transition', 'spinner-state', 'caller-overrides', 'spinners'],
      },
      entries,
    },
    null,
    2
  )
);
await writeFile(path.join(out, 'failures.json'), JSON.stringify(failures, null, 2));
await writeFile(path.join(out, 'observations.json'), JSON.stringify(observations, null, 2));
console.log(`${entries.length} native status frames; ${failures.length} failures`);
if (failures.length) process.exitCode = 1;
