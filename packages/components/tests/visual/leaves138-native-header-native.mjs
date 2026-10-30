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
    const side = document.querySelector('aside[aria-label="Review groups"]'),
      header = document.querySelector(
        '[data-block-path="packages/adaptors/src/index.ts"] .crh-block-header'
      ),
      nodes = [side, ...side.querySelectorAll('*'), header, ...header.querySelectorAll('*')];
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
    const glyph = header.querySelector('button[aria-expanded] svg.lucide-chevron-down'),
      button = glyph.parentElement;
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
        activeText: document.activeElement.textContent,
        focusVisible: document.activeElement.matches(':focus-visible'),
        activeRect: rect(document.activeElement),
        documentHasFocus: document.hasFocus(),
        hoverMedia: matchMedia('(hover:hover)').matches,
        coarse: matchMedia('(pointer:coarse)').matches,
        forcedColors: matchMedia('(forced-colors:active)').matches,
        reducedMotion: matchMedia('(prefers-reduced-motion:reduce)').matches,
        scheme: getComputedStyle(side).colorScheme,
        currentGroups: [...side.querySelectorAll('[aria-current]')].map((e) => ({
          value: e.getAttribute('aria-current'),
          text: e.textContent,
        })),
        chevronColor: getComputedStyle(glyph).color,
        rootColor: getComputedStyle(document.querySelector('.crh-shell')).color,
        innerGroupHover: button.matches(':hover'),
        hostGroupHover: document.querySelector('#storybook-root').matches('.group:hover'),
        bodyGroupHover: document.body.matches('.group:hover'),
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
          'aside[aria-label="Review groups"],aside[aria-label="Review groups"] *,[data-block-path="packages/adaptors/src/index.ts"] .crh-block-header,[data-block-path="packages/adaptors/src/index.ts"] .crh-block-header *'
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
  for (const width of args.widths ? args.widths.split(',').map(Number) : [390, 1280])
    for (const mode of args.modes
      ? args.modes.split(',')
      : ['default', 'element', 'initial', 'inherit', 'forced-colors', 'host-light', 'coarse']) {
      const key = width + '-' + mode,
        context = await browser.newContext({
          viewport: { width, height: 1000 },
          colorScheme: 'dark',
          reducedMotion: 'no-preference',
          forcedColors: mode === 'forced-colors' ? 'active' : 'none',
          isMobile: mode === 'coarse',
          hasTouch: mode === 'coarse',
        }),
        p = await context.newPage();
      try {
        await p.goto(
          args.storybook +
            '/iframe.html?id=code-review-helper-reviewrenderer--grouped-refactor&viewMode=story'
        );
        await p.waitForFunction(
          () =>
            document.querySelector('aside[aria-label="Review groups"]') &&
            document.fonts.status === 'loaded'
        );
        await p.waitForFunction(() => {
          const blocks = [...document.querySelectorAll('[data-block-path]')],
            q = window.__138Warm ?? { i: 0 };
          window.__138Warm = q;
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
        const nav = p.locator(
            'nav[aria-label="Review group navigation"]>div:first-child>div>button:first-child'
          ),
          description = p.locator(
            'nav[aria-label="Review group navigation"]>div:first-child>div>button[aria-expanded]'
          ),
          toggle = p.locator(
            '[data-block-path="packages/adaptors/src/index.ts"] .crh-block-header button[aria-expanded]'
          );
        await p.evaluate(
          ({ mode, palette }) => {
            const nodes = [
              document.querySelector(
                'nav[aria-label="Review group navigation"]>div:first-child>div>button:first-child'
              ),
              document.querySelector(
                'nav[aria-label="Review group navigation"]>div:first-child>div>button[aria-expanded]'
              ),
              document.querySelector(
                '[data-block-path="packages/adaptors/src/index.ts"] .crh-block-header button[aria-expanded]'
              ),
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
            if (mode === 'host-light')
              for (const [k, v] of Object.entries({
                '--foreground': '220 20% 15%',
                '--background': '40 30% 97%',
                '--muted-foreground': '215 20% 40%',
                '--ring': '320 90% 45%',
              }))
                document.querySelector('#storybook-root').style.setProperty(k, v);
          },
          { mode, palette }
        );
        await p.mouse.move(-11, -11);
        await p.mouse.move(-10, -10);
        for (const [name, target] of [
          ['navigation', nav],
          ['description', description],
          ['diff-collapse', toggle],
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
        if (mode === 'default' || mode === 'coarse') {
          await toggle.hover();
          await capture(p, key + '-inner-hover', { width, mode, target: 'chevron-inner-hover' });
          await p.mouse.move(-11, -11);
          await p.mouse.move(-10, -10);
          await capture(p, key + '-hover-out', { width, mode, target: 'chevron-rest' });
          await p.evaluate(() => document.querySelector('#storybook-root').classList.add('group'));
          const h = p.locator(
            '[data-block-path="packages/adaptors/src/index.ts"] .crh-block-header'
          );
          await h.scrollIntoViewIfNeeded();
          let box = await h.boundingBox();
          const viewport = await p.evaluate(() => ({ width: innerWidth, height: innerHeight }));
          if (
            box.x < 0 ||
            box.y < 0 ||
            box.x + 1 >= viewport.width ||
            box.y + 1 >= viewport.height
          ) {
            await h.evaluate((e) =>
              e.scrollIntoView({ block: 'center', inline: 'start', behavior: 'instant' })
            );
            box = await h.boundingBox();
          }
          await p.mouse.move(box.x + 1, box.y + 1);
          await p.waitForFunction(
            () =>
              document.querySelector('#storybook-root').matches('.group:hover') &&
              !document
                .querySelector(
                  '[data-block-path="packages/adaptors/src/index.ts"] .crh-block-header button[aria-expanded]'
                )
                .matches(':hover')
          );
          await capture(p, key + '-outer-group-hover', {
            width,
            mode,
            target: 'chevron-outer-group',
          });
          await p.evaluate(() => document.body.classList.add('group'));
          await capture(p, key + '-nested-outer-group-hover', {
            width,
            mode,
            target: 'chevron-nested-outer-group',
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
