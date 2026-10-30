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
  '--card',
  '--crh-surface',
  '--foreground',
  '--background',
  '--muted-foreground',
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
    const panel = document.querySelector('aside[aria-label="Review comments"]'),
      nodes = [panel, ...panel.querySelectorAll('*')],
      rect = (e) => {
        const b = e.getBoundingClientRect();
        return [b.x, b.y, b.width, b.height];
      },
      css = (e, ps) => {
        const c = getComputedStyle(e, ps);
        return Object.fromEntries(
          [...c].filter((k) => !k.startsWith('--')).map((k) => [k, c.getPropertyValue(k)])
        );
      };
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
        attrs: Object.fromEntries(
          e
            .getAttributeNames()
            .filter((k) => k !== 'class')
            .map((k) => [k, e.getAttribute(k)])
        ),
        flags: Object.fromEntries(
          [
            'hover',
            'active',
            'focus',
            'focus-visible',
            'focus-within',
            'checked',
            'indeterminate',
          ].map((k) => [k, e.matches(':' + k)])
        ),
        checked: e.tagName === 'INPUT' ? e.checked : null,
        indeterminate: e.tagName === 'INPUT' ? e.indeterminate : null,
      })),
      geometry: [...document.querySelectorAll('.crh-shell,.crh-shell *')].map((e) => ({
        tag: e.tagName,
        rect: rect(e),
      })),
      state: {
        activeTag: document.activeElement.tagName,
        activeLabel: document.activeElement.getAttribute('aria-label'),
        activeTitle: document.activeElement.getAttribute('title'),
        activeText: document.activeElement.textContent,
        focusVisible: document.activeElement.matches(':focus-visible'),
        activeRect: rect(document.activeElement),
        documentHasFocus: document.hasFocus(),
        forcedColors: matchMedia('(forced-colors:active)').matches,
        reducedMotion: matchMedia('(prefers-reduced-motion:reduce)').matches,
        focusedThreads: [...document.querySelectorAll('.crh-thread-focused')].map((e) =>
          e.getAttribute('data-anchor')
        ),
        focusedAnnotations: [...document.querySelectorAll('.crh-anno-focused')].map((e) =>
          e.getAttribute('data-anno')
        ),
        currentGroups: [
          ...document.querySelectorAll('nav[aria-label="Review group navigation"] [aria-current]'),
        ].map((e) => e.textContent),
        activeDescribedBy: document.activeElement.getAttribute('aria-describedby'),
        portalDOM: [
          ...document.querySelectorAll(
            '[data-radix-popper-content-wrapper], [data-radix-popper-content-wrapper] *'
          ),
        ].map((e) => ({
          tag: e.tagName,
          text: e.textContent,
          rect: rect(e),
          css: css(e),
          before: css(e, '::before'),
          after: css(e, '::after'),
        })),
        actualTooltipRoleNodes: [...document.querySelectorAll('[role=tooltip]')].map((e) => ({
          text: e.textContent,
          rect: rect(e),
          css: css(e),
        })),
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
  if (
    args.onlyOuter === 'true' &&
    !key.includes('-outer-group-hover') &&
    !key.includes('-nested-outer-group-hover')
  )
    return;
  await p.keyboard.press('Escape');
  await p.waitForFunction(
    () =>
      document.querySelectorAll('[data-radix-popper-content-wrapper]').length === 0 &&
      !document.activeElement.hasAttribute('aria-describedby') &&
      document
        .getAnimations()
        .every(
          (a) =>
            a.effect?.getTiming().iterations === Infinity ||
            (!a.pending && a.playState !== 'running')
        )
  );

  if (p.__offline) {
    assert.deepEqual(p.__offline, { HTTP: [], extraFiles: [], pageErrors: [] });
    assert.equal(await p.locator('link[rel=stylesheet]').count(), 0);
  }
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
    sourceClassCarriers: await p.evaluate(() =>
      [
        ...document.querySelectorAll(
          'aside[aria-label="Review comments"],aside[aria-label="Review comments"] *'
        ),
      ].map((e, i) => ({ i, tag: e.tagName, class: e.getAttribute('class') }))
    ),
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
          viewport: { width, height: 1000 },
          colorScheme: 'dark',
          reducedMotion: 'no-preference',
          forcedColors: mode === 'forced-colors' ? 'active' : 'none',
        }),
        p = await context.newPage();
      try {
        await p.goto(
          args.storybook +
            '/iframe.html?id=code-review-helper-reviewrenderer--with-existing-comments&viewMode=story'
        );
        await p.waitForFunction(
          () =>
            document.querySelector('aside[aria-label="Review comments"] article[data-anchor]') &&
            document.fonts.status === 'loaded'
        );
        await p.waitForFunction(() => {
          const blocks = [...document.querySelectorAll('[data-block-path]')],
            q = window.__142Warm ?? { i: 0 };
          window.__142Warm = q;
          if (q.i >= blocks.length) return true;
          const e = blocks[q.i];
          e.scrollIntoView({ block: 'center', behavior: 'instant' });
          const h = e.querySelector('diffs-container');
          if (
            !e.querySelector('.crh-diff-placeholder') &&
            (!h || h.shadowRoot?.querySelector('[data-line]'))
          )
            q.i++;
          return false;
        });
        const pathButton = p
            .locator(
              'aside[aria-label="Review comments"] button[title^="Jump to packages/adaptors/src/index.ts"]'
            )
            .first(),
          jump = p
            .locator(
              'aside[aria-label="Review comments"] article[data-anchor] button[title="Jump to this line in the diff"]'
            )
            .first();
        await p.evaluate(
          ({ mode, palette }) => {
            const root = document.querySelector('aside[aria-label="Review comments"]'),
              nodes = [
                root.querySelector('button[title^="Jump to packages/adaptors/src/index.ts"]'),
                root.querySelector(
                  'article[data-anchor] button[title="Jump to this line in the diff"]'
                ),
                root.querySelector('article[data-anchor]'),
              ];
            for (const e of nodes)
              for (const [k, v] of Object.entries(palette)) {
                if (mode === 'element') e.style.setProperty(k, v);
                if (mode === 'initial') e.style.setProperty(k, 'initial');
                if (mode === 'inherit') {
                  e.parentElement.style.setProperty(k, v);
                  e.style.setProperty(k, 'inherit');
                }
              }
          },
          { mode, palette }
        );
        await p.mouse.move(-11, -11);
        await p.mouse.move(-10, -10);
        for (const [name, target] of [
          ['path-button', pathButton],
          ['thread-jump', jump],
        ]) {
          await target.focus();
          await p.keyboard.press('Tab');
          await p.keyboard.press('Shift+Tab');
          await target.scrollIntoViewIfNeeded();
          await p.waitForFunction(() => {
            const e = document.activeElement,
              b = e.getBoundingClientRect(),
              hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
            return (
              b.x >= 0 &&
              b.y >= 0 &&
              b.right <= innerWidth &&
              b.bottom <= innerHeight &&
              e.contains(hit)
            );
          });
          await capture(p, key + '-' + name, { width, mode, target: name });
        }
        if (mode === 'default') {
          await p.evaluate(() => {
            const e = document.querySelector(
              'aside[aria-label="Review comments"] article[data-anchor]'
            );
            window.__142Transition = { run: null, end: false };
            e.addEventListener(
              'transitionrun',
              (ev) => {
                if (ev.target !== e || ev.propertyName !== 'background-color') return;
                window.__142Transition.run = {
                  property: ev.propertyName,
                  animations: e
                    .getAnimations()
                    .filter((a) => a.effect?.target === e)
                    .map((a) => ({
                      kind: a.constructor.name,
                      property: a.transitionProperty,
                      timing: a.effect.getTiming(),
                    })),
                };
              },
              { once: true }
            );
            e.addEventListener('transitionend', (ev) => {
              if (ev.target === e && ev.propertyName === 'background-color')
                window.__142Transition.end = true;
            });
            getComputedStyle(e).backgroundColor;
            e.style.setProperty('--card', '230 25% 26%');
            getComputedStyle(e).backgroundColor;
          });
          await p.waitForFunction(() => window.__142Transition?.run && window.__142Transition.end);
          await capture(p, key + '-actual-background-transition-settled', {
            width,
            mode,
            target: 'article-background',
            transition: await p.evaluate(() => window.__142Transition),
          });
          await jump.press('Enter');
          await p.waitForFunction(() =>
            document.querySelector(
              'aside[aria-label="Review comments"] article.crh-thread-focused[data-anchor]'
            )
          );
          await p.waitForFunction(() => {
            const thread = document.querySelector(
                'aside[aria-label="Review comments"] article.crh-thread-focused[data-anchor]'
              ),
              path = thread?.closest('[data-thread-path]')?.getAttribute('data-thread-path'),
              main = document.querySelector('.crh-main'),
              block =
                path && document.querySelector('[data-block-path="' + CSS.escape(path) + '"]');
            if (!thread || !main || !block) return false;
            const m = main.getBoundingClientRect(),
              b = block.getBoundingClientRect(),
              toolbar = document.querySelector('.crh-toolbar').offsetHeight;
            return b.bottom > m.top + toolbar + 4 && b.top < m.bottom - 4;
          });
          await capture(p, key + '-actual-thread-jump', {
            width,
            mode,
            target: 'thread-jump-real-Enter',
          });
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
if (failures.length) process.exitCode = 1;
