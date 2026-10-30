/** Actual Radix controls: default, inherited RTL and same-element variable readers. */
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
  '--popover': '220 20% 22% / .8',
  '--foreground': '35 85% 80% / .85',
  '--border': '180 60% 55% / .75',
  '--muted-foreground': '210 35% 70% / .7',
  '--tw-border-style': 'dashed',
};
await mkdir(path.join(out, 'shots'), { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
async function snapshot(page) {
  return page.evaluate(() => {
    const css = (e, pseudo) => {
      const s = getComputedStyle(e, pseudo);
      return Object.fromEntries(
        [...s].filter((k) => !k.startsWith('--')).map((k) => [k, s.getPropertyValue(k)])
      );
    };
    return [
      ...document.querySelectorAll(
        '[data-menu-trigger],[data-tooltip-trigger],[data-owned-menu],[data-owned-menu] *,[data-owned-tooltip],[data-owned-tooltip] *'
      ),
    ].map((e, index) => {
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
        variables: Object.fromEntries(
          [
            '--spacing',
            '--radius',
            '--popover',
            '--foreground',
            '--border',
            '--muted-foreground',
            '--tw-border-style',
          ].map((k) => [k, s.getPropertyValue(k)])
        ),
        focused: document.activeElement === e,
        hovered: e.matches(':hover'),
        state: e.dataset.state ?? null,
        disabled: e.hasAttribute('data-disabled'),
        side: e.dataset.side ?? null,
      };
    });
  });
}
async function settled(page) {
  await page.waitForFunction(() => {
    const nodes = [...document.querySelectorAll('[data-owned-menu],[data-owned-tooltip]')];
    if (!nodes.length) return false;
    const rs = nodes.map((e) => {
        const r = e.getBoundingClientRect(),
          s = getComputedStyle(e);
        return [r.x, r.y, r.width, r.height, s.opacity, s.transform];
      }),
      v = JSON.stringify(rs),
      old = window.__native104 ?? { v: '', n: 0 };
    old.n = old.v === v ? old.n + 1 : 0;
    old.v = v;
    window.__native104 = old;
    return (
      old.n >= 3 &&
      document.fonts.status === 'loaded' &&
      rs.every((r) => r[2] > 0 && r[3] > 0 && r[4] === '1') &&
      document.getAnimations().every((a) => !a.pending && a.playState !== 'running')
    );
  });
}
async function capture(page, key) {
  await page.mouse.move(-10, -10);
  await settled(page);
  const before = await snapshot(page),
    shot = 'shots/' + key + '.png';
  await page.screenshot({ path: path.join(out, shot), animations: 'disabled', caret: 'hide' });
  const after = await snapshot(page);
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw Error('Records changed during screenshot ' + key);
  entries.push({
    key,
    shot,
    sha256: sha(await readFile(path.join(out, shot))),
    records: before,
    prePostRecordsEqual: true,
  });
}
try {
  for (const width of args.widths ? args.widths.split(',').map(Number) : [390, 1280])
    for (const mode of args.modes
      ? args.modes.split(',')
      : ['default', 'ancestor-rtl', 'same-element'])
      for (const kind of args.kinds
        ? args.kinds.split(',')
        : ['menu-default', 'tooltip-top', 'menu-caller', 'tooltip-caller']) {
        const context = await browser.newContext({
            viewport: { width, height: 900 },
            colorScheme: 'dark',
            reducedMotion: args.normal ? 'no-preference' : 'reduce',
            locale: 'en',
          }),
          page = await context.newPage();
        let key = `${kind}-${width}-${mode}`;
        try {
          await page.goto(
            args.storybook +
              '/iframe.html?id=code-review-helper-controlsmigration--' +
              kind +
              '&viewMode=story'
          );
          await page.waitForFunction(
            () =>
              !!document.querySelector('[data-controls-migration]') &&
              document.fonts.status === 'loaded'
          );
          if (mode === 'ancestor-rtl')
            await page.evaluate((vars) => {
              document.documentElement.dir = 'rtl';
              document.documentElement.style.fontSize = '20px';
              for (const [k, v] of Object.entries(vars))
                document.documentElement.style.setProperty(k, v);
            }, vars);
          if (kind.startsWith('menu')) {
            await page.locator('[data-menu-trigger]').focus();
            await page.locator('[data-menu-trigger]').press('ArrowDown');
            await page.waitForFunction(
              () => document.activeElement?.getAttribute('data-owned-item') === 'first'
            );
          } else {
            await page.locator('[data-tooltip-trigger]').focus();
            await page.waitForFunction(() => !!document.querySelector('[data-owned-tooltip]'));
          }
          if (mode === 'same-element')
            await page.evaluate((vars) => {
              for (const e of document.querySelectorAll(
                '[data-owned-menu],[data-owned-menu] *,[data-owned-tooltip]'
              ))
                for (const [k, v] of Object.entries(vars)) e.style.setProperty(k, v);
            }, vars);
          await capture(page, key + '-first');
          if (kind.startsWith('menu')) {
            await page.locator('[data-owned-menu]').press('End');
            await page.waitForFunction(
              () => document.activeElement?.getAttribute('data-owned-item') === 'last'
            );
            await capture(page, key + '-last');
          }
        } catch (e) {
          const shot = 'shots/' + key + '-error.png';
          await page.screenshot({ path: path.join(out, shot) }).catch(() => {});
          failures.push({ key, error: String(e), shot });
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
