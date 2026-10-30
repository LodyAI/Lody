/** Real separator axes, refs, slots, semantics and element-local color readers. */
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
  vars = { '--border': '175 65% 55% / .65', '--sidebar-border': '25 85% 55% / .7' },
  sha = (x) => createHash('sha256').update(x).digest('hex');
await mkdir(path.join(out, 'shots'), { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
async function records(p) {
  return p.evaluate(() => {
    const css = (e, p) => {
      const s = getComputedStyle(e, p);
      return Object.fromEntries(
        [...s].filter((k) => !k.startsWith('--')).map((k) => [k, s.getPropertyValue(k)])
      );
    };
    return [...document.querySelectorAll('[data-owned-separator],[data-owned-separator] *')].map(
      (e, index) => {
        const r = e.getBoundingClientRect(),
          s = getComputedStyle(e);
        return {
          index,
          tag: e.tagName,
          rect: [r.x, r.y, r.width, r.height],
          css: css(e),
          before: css(e, '::before'),
          after: css(e, '::after'),
          vars: Object.fromEntries(
            ['--border', '--sidebar-border'].map((k) => [k, s.getPropertyValue(k)])
          ),
          attrs: Object.fromEntries(
            [
              'data-owned-separator',
              'data-ref-tag',
              'data-orientation',
              'role',
              'aria-orientation',
              'aria-label',
              'tabindex',
            ].map((k) => [k, e.getAttribute(k)])
          ),
          focus: document.activeElement === e,
        };
      }
    );
  });
}
async function settle(p) {
  await p.waitForFunction(() => {
    const es = [...document.querySelectorAll('[data-owned-separator]')];
    if (es.length !== 8) return false;
    const value = JSON.stringify(
        es.map((e) => {
          const r = e.getBoundingClientRect();
          return [r.x, r.y, r.width, r.height, getComputedStyle(e).backgroundColor];
        })
      ),
      a = window.__native108 ?? { value: '', n: 0 };
    a.n = a.value === value ? a.n + 1 : 0;
    a.value = value;
    window.__native108 = a;
    return (
      a.n >= 3 &&
      es.every((e) => e.dataset.refTag === e.tagName) &&
      document.fonts.status === 'loaded' &&
      document.getAnimations().every((x) => !x.pending && x.playState !== 'running')
    );
  });
}
try {
  for (const width of [390, 1280])
    for (const mode of ['default', 'ancestor-rtl', 'same-element'])
      for (const story of ['separator-axes', 'separator-local-variables']) {
        const c = await browser.newContext({
            viewport: { width, height: 900 },
            colorScheme: 'dark',
            reducedMotion: 'reduce',
            locale: 'en',
          }),
          p = await c.newPage();
        let key = story + '-' + width + '-' + mode;
        try {
          await p.goto(
            args.storybook +
              '/iframe.html?id=code-review-helper-controlsmigration--' +
              story +
              '&viewMode=story'
          );
          await p.waitForFunction(
            () =>
              !!document.querySelector('[data-controls-migration=separators]') &&
              document.fonts.status === 'loaded'
          );
          if (mode !== 'default')
            await p.evaluate(
              ({ mode, vars }) => {
                const root = document.querySelector('[data-controls-migration=separators]');
                if (mode === 'ancestor-rtl') {
                  root.dir = 'rtl';
                  document.documentElement.style.fontSize = '20px';
                  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
                } else
                  for (const e of document.querySelectorAll('[data-owned-separator]'))
                    for (const [k, v] of Object.entries(vars)) e.style.setProperty(k, v);
              },
              { mode, vars }
            );
          await p.mouse.move(-10, -10);
          for (const state of ['rest', 'focused']) {
            key = story + '-' + width + '-' + mode + '-' + state;
            if (state === 'focused') await p.locator('[data-owned-separator=inline]').focus();
            await settle(p);
            const a = await records(p),
              shot = 'shots/' + key + '.png';
            await p.screenshot({
              path: path.join(out, shot),
              animations: 'disabled',
              caret: 'hide',
            });
            if (JSON.stringify(a) !== JSON.stringify(await records(p)))
              throw Error('Records changed during screenshot');
            entries.push({
              key,
              shot,
              sha256: sha(await readFile(path.join(out, shot))),
              records: a,
              prePostRecordsEqual: true,
            });
          }
        } catch (error) {
          const shot = 'shots/' + key + '-error.png';
          await p.screenshot({ path: path.join(out, shot) }).catch(() => {});
          failures.push({ key, error: String(error), shot });
        } finally {
          await c.close();
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
