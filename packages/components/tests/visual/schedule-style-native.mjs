/** Browser contracts complement the matching real screenshots in schedule-style-targets.json. */
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
if (!args.phase || !args.storybook) throw new Error('--phase and --storybook are required');
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(packageRoot, 'artifacts/visual', args.phase);
const profile = JSON.parse(
  await readFile(new URL('./schedule-style-targets.json', import.meta.url))
);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const iframe = await (await fetch(new URL('/iframe.html', args.storybook))).text();
if (iframe.includes('/@vite/client')) throw new Error('An immutable Storybook build is required');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
const observations = [],
  failures = [];
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const snapshot = () =>
  [...document.querySelectorAll('#storybook-root *, ul, li')].map((node) => {
    const rect = node.getBoundingClientRect(),
      css = getComputedStyle(node);
    return {
      tag: node.tagName,
      text: node.childElementCount ? '' : node.textContent,
      rect: [rect.x, rect.y, rect.width, rect.height],
      ...Object.fromEntries(
        [
          'display',
          'flexDirection',
          'flexShrink',
          'alignItems',
          'justifyContent',
          'gridTemplateColumns',
          'gap',
          'minWidth',
          'maxWidth',
          'height',
          'width',
          'paddingTop',
          'paddingRight',
          'paddingBottom',
          'paddingLeft',
          'marginBlockStart',
          'marginBlockEnd',
          'fontSize',
          'lineHeight',
          'color',
          'borderRadius',
          'whiteSpace',
          'overflow',
          'boxShadow',
          'outlineStyle',
        ].map((key) => [key, css[key]])
      ),
    };
  });

try {
  for (const viewport of profile.viewports)
    for (const theme of profile.themes)
      for (const id of profile.ids) {
        const key = `${id}__${viewport.name}__${theme}`;
        const context = await browser.newContext({
          viewport,
          reducedMotion: 'reduce',
          colorScheme: theme,
        });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        try {
          await page.goto(
            new URL(`/iframe.html?id=${id}&viewMode=story&globals=theme:${theme}`, args.storybook)
              .href
          );
          await page.waitForFunction(
            () => window.__STORYBOOK_PREVIEW__?.currentRender?.phase === 'finished'
          );
          await page.evaluate(() => document.fonts.ready);
          await page.waitForFunction(
            (expected) =>
              document.documentElement.classList.contains('dark') === (expected === 'dark'),
            theme
          );
          if (id.includes('wide-rows') || id.endsWith('theme-variables')) {
            const row = page.locator('[data-schedule-style-rows] > div').first();
            const display = await row.evaluate((node) => getComputedStyle(node).display);
            check(
              display === (viewport.width < 640 ? 'flex' : 'grid'),
              `Wrong row breakpoint: ${display}`
            );
            const child = page.getByText(
              'A child with conflicting minimum and maximum utility widths must still shrink',
              { exact: true }
            );
            const sizing = await child.evaluate((node) => ({
              min: getComputedStyle(node).minWidth,
              max: getComputedStyle(node).maxWidth,
            }));
            check(
              sizing.min === '0px' && sizing.max === '100%',
              `Child selector precedence changed: ${JSON.stringify(sizing)}`
            );
          }
          if (id.endsWith('issues') || id.endsWith('theme-variables')) {
            check(
              (await page.locator('[data-schedule-style-marker=empty] [role=img]').count()) === 0,
              'Empty issue mark rendered'
            );
            const expectedSize = id.endsWith('theme-variables') ? 24 : 16;
            const mark = page.locator('[data-schedule-style-marker=single] [role=img]');
            const geometry = await mark.boundingBox();
            check(
              geometry?.width === expectedSize && geometry.height === expectedSize,
              `Issue size changed: ${JSON.stringify(geometry)}`
            );
            check((await mark.getAttribute('tabindex')) === '0', 'Issue mark lost keyboard focus');
          }
          if (id.endsWith('caller-overrides')) {
            const computed = await page
              .locator('[data-schedule-style-marker=caller] [role=img]')
              .evaluate((node) => {
                const css = getComputedStyle(node);
                return {
                  display: css.display,
                  width: css.width,
                  height: css.height,
                  shrink: css.flexShrink,
                  radius: css.borderRadius,
                };
              });
            check(
              JSON.stringify(computed) ===
                JSON.stringify({
                  display: 'block',
                  width: '32px',
                  height: '32px',
                  shrink: '1',
                  radius: '0px',
                }),
              `Caller precedence changed: ${JSON.stringify(computed)}`
            );
          }
          observations.push({ key, state: 'rest', nodes: await page.evaluate(snapshot) });
          for (const state of profile.states[id] ?? []) {
            for (const step of state.steps) {
              if (step.action === 'movePointer') await page.mouse.move(step.x, step.y);
              else if (step.action === 'hover') await page.locator(step.selector).hover();
              else if (step.action === 'focus') await page.locator(step.selector).focus();
              else if (step.action === 'visible')
                await page.getByText(step.text, { exact: true }).waitFor({ state: 'visible' });
              else throw new Error(`Unsupported native step: ${step.action}`);
            }
            await page.evaluate(async () => {
              await Promise.all(
                document
                  .getAnimations()
                  .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
                  .map((animation) => animation.finished.catch(() => undefined))
              );
              await new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve))
              );
            });
            const margins =
              state.name === 'multiple-focus'
                ? await page
                    .getByText('The destination must belong to this workspace.', { exact: true })
                    .locator('..')
                    .locator('li')
                    .evaluateAll((nodes) =>
                      nodes.map((node, index) => {
                        const css = getComputedStyle(node);
                        const rawSpacing = css.getPropertyValue('--spacing').trim();
                        const spacing =
                          parseFloat(rawSpacing) *
                          (rawSpacing.endsWith('rem')
                            ? parseFloat(getComputedStyle(document.documentElement).fontSize)
                            : 1);
                        return {
                          start: parseFloat(css.marginBlockStart),
                          end: parseFloat(css.marginBlockEnd),
                          expected: index === nodes.length - 1 ? 0 : spacing * 0.5,
                        };
                      })
                    )
                : [];
            if (state.name === 'multiple-focus') {
              check(
                margins.length === 3,
                `Expected three real tooltip items, received ${margins.length}`
              );
            }
            check(
              margins.every((margin) => margin.start === 0 && margin.end === margin.expected),
              `Tooltip list margins changed: ${JSON.stringify(margins)}`
            );
            observations.push({
              key,
              state: state.name,
              nodes: await page.evaluate(snapshot),
              margins,
            });
          }
          check(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
        } catch (error) {
          failures.push({ key, error: error.stack ?? String(error) });
        } finally {
          await context.close();
        }
      }
} finally {
  await browser.close();
}
await writeFile(
  path.join(output, 'proof.json'),
  JSON.stringify(
    {
      kind: 'Computed, geometry, precedence and real tooltip behavior; matching primary captures own pixels',
      profileFingerprint: hash(JSON.stringify(profile)),
      harnessFingerprint: hash(await readFile(fileURLToPath(import.meta.url))),
      buildFingerprint: hash(iframe),
      expectedObservations: 72,
      observations,
      failures,
    },
    null,
    2
  ) + '\n'
);
console.log(JSON.stringify({ output, observations: observations.length, failures }, null, 2));
if (failures.length) process.exitCode = 1;
