/** Actual group-header readers, local variables, RTL and same-document resize. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
const args = Object.fromEntries(
  process.argv.slice(2).flatMap((v, i, a) => (v.startsWith('--') ? [[v.slice(2), a[i + 1]]] : []))
);
if (!args.phase || !args.storybook) throw Error('Requires --phase and --storybook');
const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
  out = path.join(pkg, 'artifacts/visual', args.phase),
  sha = (x) => createHash('sha256').update(x).digest('hex');
await mkdir(path.join(out, 'shots'), { recursive: true });
await mkdir(path.join(out, 'states'), { recursive: true });
const profile = JSON.parse(
    await readFile(path.join(pkg, 'tests/visual/leaves101-group-section-targets.json'))
  ),
  entries = [],
  failures = [];
let browser;
try {
  browser = await chromium.launch();
} catch {
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright'),
    rs = (await readdir(cache))
      .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
      .sort((a, b) => Number(b.split('-').at(-1)) - Number(a.split('-').at(-1)));
  browser = await chromium.launch({
    executablePath: path.join(
      cache,
      rs[0],
      'chrome-headless-shell-mac-arm64/chrome-headless-shell'
    ),
  });
}
async function gate(page, expression) {
  await page.waitForFunction(`(${expression})()`, undefined, { timeout: 15000 });
}
async function ready(page, id) {
  for (const step of profile.ready[id])
    if (step.action === 'waitForFunction') await gate(page, step.expression);
  await page.mouse.move(0, 0);
}
async function settled(page) {
  await page.waitForFunction(
    () => {
      const s = document.querySelector('.crh-group-section'),
        h = s.querySelector(':scope>header'),
        m = document.querySelector('.crh-main'),
        t = document.querySelector('.crh-toolbar'),
        value = JSON.stringify(
          [s, h, ...h.querySelectorAll('*')].map((e) => {
            const r = e.getBoundingClientRect();
            return [r.x, r.y, r.width, r.height];
          })
        ),
        v = window.__native101 ?? { value: '', count: 0 };
      v.count = v.value === value ? v.count + 1 : 0;
      v.value = value;
      window.__native101 = v;
      return (
        v.count >= 3 &&
        m.style.getPropertyValue('--crh-toolbar-h') === t.offsetHeight + 'px' &&
        s.style.getPropertyValue('--crh-group-header-h') === h.offsetHeight + 'px' &&
        document.fonts.status === 'loaded' &&
        document
          .getAnimations()
          .every(
            (a) =>
              a.effect?.getTiming().iterations === Infinity ||
              (!a.pending && a.playState !== 'running')
          )
      );
    },
    undefined,
    { polling: 100 }
  );
}
const snapshot = () => {
  const s = document.querySelector('.crh-group-section'),
    h = s.querySelector(':scope>header'),
    body = s.querySelector(':scope>div'),
    m = document.querySelector('.crh-main'),
    t = document.querySelector('.crh-toolbar'),
    box = (e) => {
      const r = e.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height];
    },
    props = (e, p) => {
      const c = getComputedStyle(e, p);
      return Object.fromEntries(
        [...c]
          .filter((k) => !k.startsWith('--'))
          .concat([
            '--spacing',
            '--radius',
            '--background',
            '--foreground',
            '--border',
            '--github-addition',
            '--github-deletion',
            '--font-mono',
            '--text-lg',
            '--crh-toolbar-h',
            '--crh-group-header-h',
            '--tw-font-weight',
            '--tw-leading',
            '--tw-tracking',
            '--tw-numeric-spacing',
          ])
          .map((k) => [k, c.getPropertyValue(k)])
      );
    };
  return {
    viewport: [innerWidth, innerHeight],
    desktop: matchMedia('(min-width:1024px)').matches,
    mainScroll: m.scrollTop,
    windowScroll: scrollY,
    toolbar: {
      rect: box(t),
      offsetHeight: t.offsetHeight,
      writer: m.style.getPropertyValue('--crh-toolbar-h'),
    },
    group: {
      rect: box(h),
      offsetHeight: h.offsetHeight,
      writer: s.style.getPropertyValue('--crh-group-header-h'),
    },
    file: {
      rect: box(s.querySelector('.crh-block-header')),
      top: getComputedStyle(s.querySelector('.crh-block-header')).top,
    },
    nodes: [s, h, ...h.querySelectorAll('*'), body, body.lastElementChild].map((e, index) => ({
      index,
      tag: e.tagName,
      text: e.childElementCount ? null : e.textContent,
      rect: box(e),
      style: props(e),
      before: props(e, '::before'),
      after: props(e, '::after'),
    })),
  };
};
async function capture(page, key, meta) {
  await settled(page);
  const pre = await page.evaluate(snapshot),
    r = pre.group.rect;
  if (r[1] < 0 || r[1] + r[3] > 1000) throw Error('Header outside viewport');
  const shot = `shots/${key}.png`;
  await page.screenshot({ path: path.join(out, shot), animations: 'disabled', caret: 'hide' });
  const post = await page.evaluate(snapshot);
  if (JSON.stringify(pre) !== JSON.stringify(post))
    throw Error('Header/readers changed across screenshot');
  const record = `states/${key}.json`;
  await writeFile(path.join(out, record), JSON.stringify(post, null, 2) + '\n');
  entries.push({
    key,
    ...meta,
    shot,
    sha256: sha(await readFile(path.join(out, shot))),
    record,
    recordSha256: sha(await readFile(path.join(out, record))),
    nodes: post.nodes.length,
  });
  console.log(key);
}
try {
  for (const width of [1280, 390])
    for (const variant of ['default', 'scoped-vars', 'rtl']) {
      const context = await browser.newContext({
          viewport: { width, height: 1000 },
          reducedMotion: 'reduce',
          colorScheme: 'dark',
        }),
        page = await context.newPage(),
        id = 'code-review-helper-reviewrenderer--grouped-refactor';
      try {
        await page.goto(new URL('/iframe.html?id=' + id + '&viewMode=story', args.storybook).href);
        await ready(page, id);
        await page.evaluate((variant) => {
          const s = document.querySelector('.crh-group-section');
          if (variant === 'rtl') document.querySelector('.crh-shell').dir = 'rtl';
          if (variant === 'scoped-vars')
            for (const [k, v] of Object.entries({
              '--spacing': '5px',
              '--foreground': '160 30% 70% / .7',
              '--background': '230 20% 9%',
              '--border': '190 30% 45%',
              '--github-addition': '140 45% 60%',
              '--github-deletion': '340 65% 65%',
              '--text-lg': '26px',
              '--font-mono': 'serif',
              '--leading-snug': '1.75',
              '--font-weight-semibold': '650',
            }))
              s.style.setProperty(k, v);
        }, variant);
        await gate(page, profile.ready[id][2].expression);
        await capture(page, `${width}-${variant}-rest`, { width, variant, state: 'rest' });
        await gate(page, profile.states[id][0].steps[0].expression);
        await capture(page, `${width}-${variant}-positioned`, {
          width,
          variant,
          state: 'positioned',
        });
      } catch (e) {
        failures.push({ width, variant, error: String(e) });
      } finally {
        await context.close();
      }
    }
  const context = await browser.newContext({
      viewport: { width: 1280, height: 1000 },
      reducedMotion: 'reduce',
      colorScheme: 'dark',
    }),
    page = await context.newPage(),
    id = 'code-review-helper-reviewrenderer--long-group-description';
  try {
    await page.goto(new URL('/iframe.html?id=' + id + '&viewMode=story', args.storybook).href);
    await ready(page, id);
    for (const width of [1280, 767, 768, 1023, 1024, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await gate(page, profile.ready[id][1].expression);
      await gate(page, profile.states[id][0].steps[0].expression);
      await capture(page, `resize-${width}`, {
        width,
        variant: 'same-document-resize',
        state: 'positioned',
      });
    }
  } catch (e) {
    failures.push({ variant: 'same-document-resize', error: String(e) });
  } finally {
    await context.close();
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
      profileSha256: sha(
        await readFile(path.join(pkg, 'tests/visual/leaves101-group-section-targets.json'))
      ),
      entries,
      failures,
      closedNormally: true,
    },
    null,
    2
  ) + '\n'
);
console.log({ entries: entries.length, failures: failures.length });
if (failures.length) process.exitCode = 1;
