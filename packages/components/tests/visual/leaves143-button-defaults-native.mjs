/** Real control palettes: private writers, legacy Slot children and local readers. */
import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const args = Object.fromEntries(
    process.argv.slice(2).flatMap((x, i, a) => (x.startsWith('--') ? [[x.slice(2), a[i + 1]]] : []))
  ),
  out = path.resolve('artifacts/visual', args.phase),
  entries = [],
  failures = [],
  sha = (x) => createHash('sha256').update(x).digest('hex');
const vars = {
  '--spacing': '5px',
  '--radius': '13px',
  '--background': '220 20% 13% / .9',
  '--foreground': '35 85% 80% / .85',
  '--primary': '185 70% 40% / .8',
  '--primary-foreground': '50 80% 88% / .9',
  '--secondary': '240 28% 35% / .7',
  '--secondary-foreground': '180 70% 80% / .9',
  '--muted': '230 25% 30% / .7',
  '--muted-foreground': '210 35% 70% / .7',
  '--destructive': '350 65% 45% / .8',
  '--destructive-foreground': '30 80% 88% / .9',
  '--input': '210 50% 50% / .7',
  '--tw-border-style': 'dashed',
  '--tw-leading': '2.25',
  '--tw-font-weight': '300',
  '--tw-duration': '.31s',
  '--tw-ease': 'linear',
  '--text-sm': '19px',
  '--text-xs': '15px',
  '--text-sm--line-height': '1.7',
  '--text-xs--line-height': '1.6',
  '--tw-shadow-color': 'rgb(160 70 60 / .35)',
};
await mkdir(path.join(out, 'shots'), { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
async function snapshot(page) {
  return page.evaluate((keys) => {
    const root = document.querySelector('[data-button-toggle-migration]'),
      css = (e, p) => {
        const s = getComputedStyle(e, p);
        return Object.fromEntries(
          [...s].filter((k) => !k.startsWith('--')).map((k) => [k, s.getPropertyValue(k)])
        );
      };
    return [...root.querySelectorAll('*')].map((e, index) => {
      const r = e.getBoundingClientRect(),
        s = getComputedStyle(e);
      return {
        index,
        tag: e.tagName,
        text: e.textContent,
        rect: [r.x, r.y, r.width, r.height],
        css: css(e),
        before: css(e, '::before'),
        after: css(e, '::after'),
        variables: Object.fromEntries(keys.map((k) => [k, s.getPropertyValue(k)])),
        focus: document.activeElement === e,
        attrs: Object.fromEntries(
          [
            'data-case',
            'data-slot',
            'data-state',
            'aria-pressed',
            'aria-checked',
            'aria-label',
            'role',
            'type',
            'href',
            'disabled',
          ].map((k) => [k, e.getAttribute(k)])
        ),
      };
    });
  }, Object.keys(vars));
}
async function settled(page) {
  await page.waitForFunction(() => {
    const root = document.querySelector('[data-button-toggle-migration]');
    if (!root) return false;
    const value = JSON.stringify(
        [...root.querySelectorAll('*')].map((e) => {
          const r = e.getBoundingClientRect();
          return [
            r.x,
            r.y,
            r.width,
            r.height,
            getComputedStyle(e).color,
            getComputedStyle(e).backgroundColor,
          ];
        })
      ),
      a = window.__native106 ?? { value: '', n: 0 };
    a.n = a.value === value ? a.n + 1 : 0;
    a.value = value;
    window.__native106 = a;
    return (
      a.n >= 3 &&
      document.fonts.status === 'loaded' &&
      document.getAnimations().every((a) => !a.pending && a.playState !== 'running')
    );
  });
}
try {
  for (const width of [390, 1280])
    for (const mode of ['default', 'ancestor-rtl', 'same-element'])
      for (const kind of ['button-variants', 'button-sizes', 'button-defaults', 'button-slot']) {
        const context = await browser.newContext({
            viewport: { width, height: 900 },
            colorScheme: 'dark',
            reducedMotion: 'reduce',
            locale: 'en',
          }),
          p = await context.newPage(),
          key = `${kind}-${width}-${mode}`;
        try {
          await p.goto(
            args.storybook +
              '/iframe.html?id=code-review-helper-buttontogglemigration--' +
              kind +
              '&viewMode=story'
          );
          await p.waitForFunction(
            () =>
              !!document.querySelector('[data-button-toggle-migration]') &&
              document.fonts.status === 'loaded'
          );
          await p.mouse.move(-10, -10);
          if (mode !== 'default')
            await p.evaluate(
              ({ mode, vars }) => {
                const root = document.querySelector('[data-button-toggle-migration]');
                if (mode === 'ancestor-rtl') {
                  root.dir = 'rtl';
                  document.documentElement.style.fontSize = '20px';
                  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
                } else
                  for (const e of [root, ...root.querySelectorAll('*')])
                    for (const [k, v] of Object.entries(vars)) e.style.setProperty(k, v);
              },
              { mode, vars }
            );
          await settled(p);
          const records = await snapshot(p),
            shot = 'shots/' + key + '.png';
          await p.screenshot({ path: path.join(out, shot), animations: 'allow', caret: 'initial' });
          if (JSON.stringify(records) !== JSON.stringify(await snapshot(p)))
            throw Error('Records changed during screenshot');
          entries.push({
            key,
            shot,
            sha256: sha(await readFile(path.join(out, shot))),
            records,
            prePostRecordsEqual: true,
          });
        } catch (error) {
          const shot = 'shots/' + key + '-error.png';
          await p.screenshot({ path: path.join(out, shot) }).catch(() => {});
          failures.push({ key, error: String(error), shot });
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
    { phase: args.phase, storybook: args.storybook, vars, entries, failures, closedNormally: true },
    null,
    2
  ) + '\n'
);
console.log({ entries: entries.length, failures: failures.length });
if (failures.length) process.exitCode = 1;
