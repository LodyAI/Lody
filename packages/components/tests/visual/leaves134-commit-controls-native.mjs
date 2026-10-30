import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((x, i, a) => (x.startsWith('--') ? [[x.slice(2), a[i + 1]]] : []))
);
const out = path.resolve('artifacts/visual', args.phase),
  entries = [],
  failures = [];
const sha = (x) => createHash('sha256').update(x).digest('hex');
const vars = [
  '--ring',
  '--default-transition-duration',
  '--default-transition-timing-function',
  '--tw-outline-style',
  '--tw-ring-shadow',
  '--tw-ring-color',
  '--tw-ring-inset',
  '--tw-inset-shadow',
  '--tw-inset-ring-shadow',
  '--tw-ring-offset-shadow',
  '--tw-shadow',
  '--tw-shadow-color',
  '--tw-ring-offset-width',
  '--tw-ring-offset-color',
  '--tw-ease',
  '--tw-duration',
  '--tw-gradient-from',
  '--tw-gradient-via',
  '--tw-gradient-to',
];
const palette = {
  '--ring': '330 80% 55%',
  '--tw-outline-style': 'dotted',
  '--tw-ring-color': 'rgb(28,180,90)',
  '--tw-ring-inset': 'inset',
  '--tw-ring-offset-width': '3px',
  '--tw-ring-offset-color': 'rgb(120,20,90)',
  '--tw-shadow': '2px 3px 4px rgb(80,30,150)',
  '--tw-shadow-color': 'rgb(80,30,150)',
  '--tw-inset-shadow': 'inset 1px 1px 0 rgb(20,80,180)',
  '--tw-inset-ring-shadow': 'inset 0 0 0 1px rgb(100,40,10)',
  '--tw-ring-offset-shadow': '0 0 0 1px rgb(40,100,10)',
  '--tw-ease': 'linear',
  '--tw-duration': '73ms',
};
await mkdir(path.join(out, 'shots'), { recursive: true });
let closedNormally = false;
const save = () =>
  writeFile(
    path.join(out, 'proof.json'),
    JSON.stringify(
      {
        phase: args.phase,
        storybook: args.storybook,
        vars,
        palette,
        entries,
        failures,
        closedNormally,
      },
      null,
      2
    ) + '\n'
  );
async function data(p) {
  return p.evaluate((vars) => {
    const copy = document.querySelector(
        '[data-group-id="group-1"] button[aria-label="Copy commit id a11b22c"]'
      ),
      list = copy.parentElement.parentElement.parentElement,
      root = list.parentElement;
    const rect = (e) => {
        const b = e.getBoundingClientRect();
        return [b.x, b.y, b.width, b.height];
      },
      css = (e, ps) => {
        const c = getComputedStyle(e, ps);
        return Object.fromEntries(
          [...c].filter((k) => !k.startsWith('--')).map((k) => [k, c.getPropertyValue(k)])
        );
      };
    const nodes = [root, ...root.querySelectorAll('*')];
    return {
      records: nodes.map((e, i) => ({
        i,
        tag: e.tagName,
        text: e.childElementCount ? null : e.textContent,
        rect: rect(e),
        css: css(e),
        before: css(e, '::before'),
        after: css(e, '::after'),
        custom: Object.fromEntries(vars.map((k) => [k, getComputedStyle(e).getPropertyValue(k)])),
        flags: Object.fromEntries(
          ['hover', 'active', 'focus', 'focus-visible'].map((k) => [k, e.matches(':' + k)])
        ),
        expanded: e.getAttribute('aria-expanded'),
      })),
      geometry: [...document.querySelectorAll('.crh-shell,.crh-shell *')].map((e) => ({
        tag: e.tagName,
        rect: rect(e),
      })),
      state: {
        activeTag: document.activeElement.tagName,
        activeLabel: document.activeElement.getAttribute('aria-label'),
        activeText: document.activeElement.textContent,
        focusVisible: document.activeElement.matches(':focus-visible'),
        documentHasFocus: document.hasFocus(),
        forcedColors: matchMedia('(forced-colors:active)').matches,
        reducedMotion: matchMedia('(prefers-reduced-motion:reduce)').matches,
        scheme: getComputedStyle(root).colorScheme,
        clipboard: null,
      },
    };
  }, vars);
}
async function stable(p) {
  let last = '',
    count = 0;
  for (let i = 0; i < 150; i++) {
    await p.evaluate(() => new Promise(requestAnimationFrame));
    const d = await data(p),
      next = JSON.stringify(d);
    const finite = await p.evaluate(() =>
      document
        .getAnimations()
        .every(
          (a) =>
            a.effect?.getTiming().iterations === Infinity ||
            (!a.pending && a.playState !== 'running')
        )
    );
    count = finite && last === next ? count + 1 : 0;
    last = next;
    if (count >= 3) return d;
  }
  throw Error('FullFieldsNotQuiescentWithin150ActualFrames');
}
async function capture(p, key, meta) {
  const pre = await stable(p),
    shot = 'shots/' + key + '.png';
  assert.equal(pre.state.focusVisible, true, 'actualkeyboardfocusvisible');
  await p.screenshot({ path: path.join(out, shot), animations: 'allow', caret: 'initial' });
  const post = await data(p),
    raw = key + '-prepost.json',
    same = JSON.stringify(pre) === JSON.stringify(post);
  await writeFile(
    path.join(out, raw),
    JSON.stringify({ pre, post, strictPrePostEqual: same }, null, 2) + '\n'
  );
  assert.ok(same, 'strictfullfieldsprepost');
  entries.push({
    key,
    ...meta,
    shot,
    sha256: sha(await readFile(path.join(out, shot))),
    raw,
    records: post.records.length,
    strictPrePostEqual: true,
  });
  await save();
}
const browser = await chromium.launch({
  executablePath:
    '/Users/wibus/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell',
});
try {
  for (const width of [390, 1280])
    for (const mode of ['default', 'element', 'initial', 'inherit', 'forced-colors']) {
      const key = width + '-' + mode,
        context = await browser.newContext({
          viewport: { width, height: 900 },
          colorScheme: 'dark',
          reducedMotion: 'no-preference',
          forcedColors: mode === 'forced-colors' ? 'active' : 'none',
          permissions: ['clipboard-read', 'clipboard-write'],
        }),
        p = await context.newPage();
      try {
        await p.goto(
          args.storybook +
            '/iframe.html?id=code-review-helper-reviewrenderer--commit-overflow-coverage&viewMode=story'
        );
        await p.waitForFunction(
          () =>
            document.querySelector(
              '[data-group-id="group-1"] button[aria-label="Copy commit id a11b22c"]'
            ) && document.fonts.status === 'loaded'
        );
        const copy = p.locator(
          '[data-group-id="group-1"] button[aria-label="Copy commit id a11b22c"]'
        );
        await p.evaluate(
          ({ mode, palette }) => {
            const c = document.querySelector(
                '[data-group-id="group-1"] button[aria-label="Copy commit id a11b22c"]'
              ),
              list = c.parentElement.parentElement.parentElement,
              root = list.parentElement;
            if (mode === 'inherit')
              for (const [k, v] of Object.entries(palette))
                root.parentElement.style.setProperty(k, v);
            for (const e of [root, ...root.querySelectorAll('*')])
              if (e.matches('button,svg'))
                for (const [k, v] of Object.entries(palette)) {
                  if (mode === 'element') e.style.setProperty(k, v);
                  if (mode === 'initial') e.style.setProperty(k, 'initial');
                  if (mode === 'inherit') e.style.setProperty(k, 'inherit');
                }
          },
          { mode, palette }
        );
        await p.mouse.move(-10, -10);
        await copy.focus();
        await p.keyboard.press('Shift+Tab');
        const summary = p
          .locator(
            '[data-group-id="group-1"] button[aria-expanded][data-state]:has(svg.lucide-chevron-down)'
          )
          .first();
        await summary.scrollIntoViewIfNeeded();
        await capture(p, key + '-summary', { width, mode, target: 'summary' });
        await p.keyboard.press('Tab');
        await capture(p, key + '-copy', { width, mode, target: 'copy' });
        const listToggle = p
          .locator('[data-group-id="group-1"] button')
          .filter({ hasText: /^6 commits$/ });
        await listToggle.focus();
        await p.keyboard.press('Tab');
        await p.keyboard.press('Shift+Tab');
        await listToggle.scrollIntoViewIfNeeded();
        await capture(p, key + '-toggle', { width, mode, target: 'commits-toggle' });
        const more = p.getByRole('button', { name: 'Show 2 more commits', exact: true });
        await more.focus();
        await p.keyboard.press('Shift+Tab');
        await p.keyboard.press('Tab');
        await more.scrollIntoViewIfNeeded();
        await capture(p, key + '-more', { width, mode, target: 'show-more' });
        if (mode === 'default') {
          await p.keyboard.press('Space');
          await p.getByRole('button', { name: 'Show fewer commits', exact: true }).waitFor();
          assert.equal(
            await p
              .locator('[data-group-id="group-1"] button[aria-label^="Copy commit id"]')
              .count(),
            6
          );
          await p.keyboard.press('Space');
          await more.waitFor();
          await summary.focus();
          await p.keyboard.press('Enter');
          await expectExpanded(summary, true);
          await p.keyboard.press('Space');
          await expectExpanded(summary, false);
          await copy.click();
          await copy.locator('svg.lucide-check').waitFor();
          assert.equal(
            await p.evaluate(() => navigator.clipboard.readText()),
            'a11b22c3d4e5f60718293a4b5c6d7e8f90123456'
          );
          await copy.locator('svg.lucide-copy').waitFor();
        }
      } catch (e) {
        const shot = 'shots/' + key + '-error.png';
        await p.screenshot({ path: path.join(out, shot), animations: 'allow' }).catch(() => {});
        failures.push({ key, message: String(e), shot });
        await save();
        console.log('FAIL', key, String(e));
      } finally {
        await context.close();
      }
      console.log(key, entries.length, failures.length);
    }
} finally {
  await browser.close();
  closedNormally = true;
  await save();
}
async function expectExpanded(l, value) {
  assert.equal(await l.getAttribute('aria-expanded'), String(value));
}
if (failures.length) process.exitCode = 1;
