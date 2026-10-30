/** Full computed-style and local-variable checks for the real review findings panel. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .flatMap((v, i, all) => (v.startsWith('--') ? [[v.slice(2), all[i + 1]]] : []))
);
if (!args.phase || !args.storybook) throw new Error('Requires --phase and --storybook');
const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(pkg, 'artifacts/visual', args.phase);
await mkdir(path.join(out, 'shots'), { recursive: true });
const hash = (value) => createHash('sha256').update(value).digest('hex');
const profile = JSON.parse(
  await readFile(path.join(pkg, 'tests/visual/leaves96-helper-findings-targets.json'), 'utf8')
);
const iframe = await (await fetch(new URL('/iframe.html', args.storybook))).text();
if (iframe.includes('/@vite/client')) throw new Error('Requires an immutable build');
let browser;
try {
  browser = await chromium.launch();
} catch {
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const revisions = (await readdir(cache))
    .filter((x) => /^chromium_headless_shell-\d+$/.test(x))
    .sort((a, b) => Number(b.split('-').at(-1)) - Number(a.split('-').at(-1)));
  browser = await chromium.launch({
    executablePath: path.join(
      cache,
      revisions[0],
      'chrome-headless-shell-mac-arm64/chrome-headless-shell'
    ),
  });
}
const entries = [],
  failures = [];
try {
  for (const width of [390, 1280])
    for (const variant of ['default', 'scoped-vars', 'same-element-writers']) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        reducedMotion: 'reduce',
        colorScheme: 'dark',
        locale: 'en',
      });
      const page = await context.newPage();
      try {
        await page.goto(
          new URL(
            '/iframe.html?id=code-review-helper-reviewrenderer--grouped-refactor&viewMode=story',
            args.storybook
          ).href
        );
        for (const step of profile.ready[profile.ids[0]]) {
          if (step.action === 'waitForFunction')
            await page.waitForFunction(`(${step.expression})()`);
          else if (step.action === 'movePointer') await page.mouse.move(step.x, step.y);
        }
        await page.evaluate((variant) => {
          const root = document.querySelector('section[aria-label="Review findings"]');
          if (variant === 'scoped-vars') {
            for (const [p, v] of Object.entries({
              '--spacing': '5px',
              '--radius': '11px',
              '--border': '195 45% 42%',
              '--card': '250 20% 18%',
              '--foreground': '35 70% 80%',
              '--muted-foreground': '175 40% 65%',
              '--tw-ease': 'linear',
              '--tw-duration': '0.31s',
            }))
              root.style.setProperty(p, v);
          }
          if (variant === 'same-element-writers') {
            for (const e of [
              root.firstElementChild.firstElementChild,
              ...root.querySelectorAll('li.crh-finding > span'),
            ])
              e.classList.add('font-bold', 'tracking-tight', 'leading-relaxed');
            for (const e of root.querySelectorAll('li.crh-finding > div'))
              e.classList.add('leading-relaxed');
          }
          root.scrollIntoView({ block: 'center', behavior: 'instant' });
        }, variant);
        await page.mouse.move(0, 0);
        await page.evaluate(() => document.fonts.ready);
        for (const state of ['rest', 'hover']) {
          if (state === 'hover') await page.locator('li.crh-finding > span').first().hover();
          const key = `${width}-${variant}-${state}`;
          await page.waitForFunction(
            () =>
              document.fonts.status === 'loaded' &&
              document
                .getAnimations()
                .every(
                  (a) =>
                    a.effect?.getTiming().iterations === Infinity ||
                    (!a.pending && a.playState !== 'running')
                )
          );
          const shot = `shots/${key}.png`;
          await page.screenshot({
            path: path.join(out, shot),
            animations: 'disabled',
            caret: 'hide',
          });
          const records = await page.evaluate(() => {
            const root = document.querySelector('section[aria-label="Review findings"]');
            const styles = (e, pseudo) => {
              const c = getComputedStyle(e, pseudo);
              return {
                ...Object.fromEntries(
                  [...c].filter((p) => !p.startsWith('--')).map((p) => [p, c.getPropertyValue(p)])
                ),
                ...Object.fromEntries(
                  [
                    '--spacing',
                    '--radius',
                    '--tw-font-weight',
                    '--tw-leading',
                    '--tw-tracking',
                    '--tw-ease',
                    '--tw-duration',
                  ].map((p) => [p, c.getPropertyValue(p)])
                ),
              };
            };
            return [root, ...root.querySelectorAll('*')].map((e, index) => ({
              index,
              tag: e.tagName,
              text: e.childElementCount ? null : e.textContent,
              rect: [
                e.getBoundingClientRect().x,
                e.getBoundingClientRect().y,
                e.getBoundingClientRect().width,
                e.getBoundingClientRect().height,
              ],
              style: styles(e),
              before: styles(e, '::before'),
              after: styles(e, '::after'),
            }));
          });
          const r = records[0].rect;
          if (r[1] < 0 || r[1] + r[3] > 900 || r[0] < 0 || r[0] + r[2] > width)
            throw new Error(`Findings are not fully painted: ${JSON.stringify(r)}`);
          entries.push({
            key,
            width,
            variant,
            state,
            shot,
            sha256: hash(await readFile(path.join(out, shot))),
            records,
          });
        }
        // Exercise the old-side range chip through the real production callback.
        await page.getByRole('button', { name: 'index.ts:9-16 old', exact: true }).click();
        await page.waitForFunction(() => {
          const e = document.querySelector('[data-block-path="packages/adaptors/src/index.ts"]');
          if (!e) return false;
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.top < innerHeight && r.bottom > 0;
        });
      } catch (error) {
        failures.push({ width, variant, message: String(error) });
      } finally {
        await context.close();
      }
    }
} finally {
  await browser.close();
}
await writeFile(
  path.join(out, 'proof.json'),
  JSON.stringify(
    {
      phase: args.phase,
      storybook: args.storybook,
      iframeSha256: hash(iframe),
      profileSha256: hash(
        await readFile(path.join(pkg, 'tests/visual/leaves96-helper-findings-targets.json'))
      ),
      entries,
      failures,
      closedNormally: true,
    },
    null,
    2
  ) + '\n'
);
console.log(
  JSON.stringify({ phase: args.phase, entries: entries.length, failures: failures.length })
);
if (failures.length) process.exitCode = 1;
