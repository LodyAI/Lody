/** Real pointer-held paint and exact project-editor request acceptance. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from '@playwright/test';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .flatMap((a, i, values) => (a.startsWith('--') ? [[a.slice(2), values[i + 1]]] : []))
);
if (!args.phase || !args.storybook) throw new Error('--phase and --storybook required');
const out = fileURLToPath(new URL(`../../artifacts/visual/${args.phase}/`, import.meta.url));
await mkdir(path.join(out, 'shots'), { recursive: true });
const hash = (value) => createHash('sha256').update(value).digest('hex');
const iframe = await (await fetch(new URL('/iframe.html', args.storybook))).text();
if (iframe.includes('/@vite/client')) throw new Error('Use an immutable Storybook build');
const index = await (await fetch(new URL('/index.json', args.storybook))).json();
const entries = [],
  failures = [],
  observations = [];
const browser = await chromium.launch({ channel: 'chrome' });
const scenes = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'iphone', width: 390, height: 844, device: 'iPhone 13' },
];
const themes = ['light', 'dark'];
const stories = ['local', 'git-hub', 'long-translation'];
const cases = stories
  .map((suffix) => ({ suffix, runtimeVariables: false }))
  .concat([{ suffix: 'local', runtimeVariables: true }]);
const snapshot = () =>
  [...document.querySelectorAll('#storybook-root, #storybook-root *')].map((element, i) => {
    const r = element.getBoundingClientRect(),
      s = getComputedStyle(element);
    return {
      path: String(i),
      tag: element.tagName.toLowerCase(),
      rect: [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 100) / 100),
      text: element.textContent?.trim().slice(0, 120),
      ...Object.fromEntries(
        [
          'display',
          'width',
          'height',
          'padding',
          'margin',
          'gap',
          'fontFamily',
          'fontSize',
          'fontWeight',
          'lineHeight',
          'color',
          'backgroundColor',
          'borderRadius',
          'boxShadow',
          'overflow',
          'textOverflow',
          'whiteSpace',
        ].map((key) => [key, s[key]])
      ),
    };
  });
try {
  for (const viewport of scenes)
    for (const theme of themes)
      for (const { suffix, runtimeVariables } of cases) {
        const context = await browser.newContext({
          ...(viewport.device ? devices[viewport.device] : {}),
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: 1,
          reducedMotion: 'reduce',
          colorScheme: theme,
        });
        const page = await context.newPage();
        const storyId = `mobile-mobileprojecteditmigration--${suffix}`;
        const key = `${storyId}__${viewport.name}__${theme}${runtimeVariables ? '__runtime-vars' : ''}`;
        try {
          await page.addInitScript(() => {
            window.__projectEditInputs = [];
            for (const type of ['pointerdown', 'touchstart'])
              document.addEventListener(
                type,
                (event) => {
                  window.__projectEditInputs.push({ type, trusted: event.isTrusted });
                },
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
          const button = page.locator('[data-project-edit-section] button');
          await button.waitFor({ state: 'visible' });
          await page.evaluate(() => document.fonts.ready);
          if (runtimeVariables)
            await page.evaluate(() => {
              const root = document.documentElement;
              for (const [name, value] of Object.entries({
                '--radius-xl': '1.25rem',
                '--font-weight-medium': '650',
                '--leading-tight': '1.45',
                '--primary': '145 73% 31%',
              }))
                root.style.setProperty(name, value);
            });
          await page.waitForFunction(() => {
            const box = document
              .querySelector('[data-project-edit-section] button')
              .getBoundingClientRect();
            const signature = JSON.stringify([box.x, box.y, box.width, box.height]);
            const previous = window.__projectEditGeometry ?? { signature: '', equal: 0 };
            previous.equal = previous.signature === signature ? previous.equal + 1 : 0;
            previous.signature = signature;
            window.__projectEditGeometry = previous;
            return previous.equal >= 3;
          });
          const shot = async (state) => {
            const stateKey = `${key}__${state}`;
            await page.screenshot({
              path: path.join(out, 'shots', `${stateKey}.png`),
              animations: 'disabled',
              caret: 'hide',
            });
            entries.push({
              key: stateKey,
              storyId,
              title: `Mobile/Project Edit — native pointer${runtimeVariables ? ' — runtime CSS variables' : ''}`,
              state,
              viewport: viewport.name,
              theme,
              shot: `shots/${stateKey}.png`,
              layout: await page.evaluate(snapshot),
            });
          };
          const restColor = await button.evaluate(
            (element) => getComputedStyle(element).backgroundColor
          );
          const box = await button.boundingBox();
          if (!box) throw new Error('Missing project edit button geometry');
          const x = box.x + box.width / 2,
            y = box.y + box.height / 2;
          const cdp = viewport.device ? await context.newCDPSession(page) : null;
          if (cdp)
            await cdp.send('Input.dispatchTouchEvent', {
              type: 'touchStart',
              touchPoints: [{ x, y }],
            });
          else {
            await page.mouse.move(x, y);
            await page.mouse.down();
          }
          if (!viewport.device)
            await page.waitForFunction(() =>
              document.querySelector('[data-project-edit-section] button').matches(':active')
            );
          const heldActive = await button.evaluate((element) => element.matches(':active'));
          await shot('pointer-held');
          if (cdp)
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          else await page.mouse.up();
          await page.locator('[data-editor-request-kind="create"]').waitFor({ state: 'visible' });
          // Touch browsers can retain :active briefly after dispatching click. Compare
          // the observable released state, rather than an arbitrary paint in that tail.
          await page.waitForFunction(
            ({ restColor: targetRestColor }) => {
              const element = document.querySelector('[data-project-edit-section] button');
              return (
                !element.matches(':active') &&
                getComputedStyle(element).backgroundColor === targetRestColor &&
                element
                  .getAnimations({ subtree: true })
                  .every(
                    (animation) =>
                      animation.effect?.getTiming().iterations === Infinity ||
                      animation.playState !== 'running'
                  )
              );
            },
            { restColor }
          );
          const request = JSON.parse(await page.locator('output').innerText());
          const expected =
            suffix === 'git-hub'
              ? {
                  kind: 'create',
                  seedSourceKey: 'github:synthetic/example',
                  seedName: '合成仓库项目',
                }
              : {
                  kind: 'create',
                  seedSourceKey: 'local:synthetic:project',
                  seedName: 'Synthetic project with 中文',
                };
          if (JSON.stringify(request) !== JSON.stringify(expected))
            throw new Error(`Wrong editor request: ${JSON.stringify(request)}`);
          const inputs = await page.evaluate(() => window.__projectEditInputs);
          if (!inputs.some((input) => input.type === 'pointerdown' && input.trusted))
            throw new Error('Missing trusted pointer input');
          if (
            viewport.device &&
            !inputs.some((input) => input.type === 'touchstart' && input.trusted)
          )
            throw new Error('Missing trusted touch input');
          observations.push({
            key,
            request,
            inputs,
            geometry: box,
            runtimeVariables,
            heldActive,
            restColor,
            releasedActive: await button.evaluate((element) => element.matches(':active')),
          });
          await shot('released');
          await page.getByRole('button', { name: 'Reset request' }).click();
          await page.locator('[data-editor-request-kind="none"]').waitFor({ state: 'visible' });
          await shot('reset');
        } catch (error) {
          failures.push({ key, message: String(error.stack ?? error) });
        } finally {
          await context.close();
        }
      }
} finally {
  await browser.close();
}
await writeFile(
  path.join(out, 'manifest.json'),
  JSON.stringify(
    {
      phase: args.phase,
      baseUrl: args.storybook,
      buildFingerprint: hash(iframe + JSON.stringify(index)),
      harnessFingerprint: hash(await readFile(fileURLToPath(import.meta.url))),
      targets: {
        viewports: scenes,
        themes,
        ids: stories,
        states: ['pointer-held', 'released', 'reset'],
      },
      entries,
    },
    null,
    2
  )
);
await writeFile(path.join(out, 'observations.json'), JSON.stringify(observations, null, 2));
await writeFile(path.join(out, 'failures.json'), JSON.stringify(failures, null, 2));
console.log(`${entries.length} native frames; ${failures.length} failures`);
if (failures.length) process.exitCode = 1;
