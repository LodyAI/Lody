import assert from 'node:assert/strict';
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
  sha = (b) => createHash('sha256').update(b).digest('hex');
await mkdir(path.join(out, 'shots'), { recursive: true });
let closedNormally = false;
const save = () =>
  writeFile(
    path.join(out, 'proof.json'),
    JSON.stringify(
      {
        phase: args.phase,
        settings: args,
        storybook: args.storybook,
        entries,
        failures,
        closedNormally,
        scope:
          'ActualprivateColumnResizerCSSvisibility/media/hover/focus/realArrow+PointerCapturecallbacks. NoReact/ARIAstatewrite. htmlfont20isexplicithostsetup;actual64rem/1024pxqueriesrecorded.',
      },
      null,
      2
    ) + '\n'
  );
async function data(p) {
  return p.evaluate(() => {
    const root = document.querySelector('.crh-shell'),
      side = document.querySelector('.crh-sidebar'),
      main = document.querySelector('.crh-main'),
      panel = document.querySelector('.crh-panel'),
      resizers = [...document.querySelectorAll('.crh-resizer')],
      nodes = [root, side, main, panel, ...resizers].filter(Boolean),
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
        rect: rect(e),
        css: css(e),
        before: css(e, '::before'),
        after: css(e, '::after'),
        attrs: Object.fromEntries(
          e
            .getAttributeNames()
            .filter((k) => k !== 'class')
            .map((k) => [k, e.getAttribute(k)])
        ),
        flags: Object.fromEntries(
          ['hover', 'active', 'focus', 'focus-visible'].map((k) => [k, e.matches(':' + k)])
        ),
        dragActive: e.classList.contains('crh-resizer-active'),
      })),
      geometry: [...document.querySelectorAll('.crh-shell,.crh-shell *')].map((e) => ({
        tag: e.tagName,
        rect: rect(e),
      })),
      state: {
        font: getComputedStyle(document.documentElement).fontSize,
        width: innerWidth,
        less64rem: matchMedia('(width < 64rem)').matches,
        less1024px: matchMedia('(width < 1024px)').matches,
        documentHasFocus: document.hasFocus(),
        activeLabel: document.activeElement.getAttribute('aria-label'),
        activeTag: document.activeElement.tagName,
        activeFocusVisible: document.activeElement.matches(':focus-visible'),
        sidebarWidth: side?.getBoundingClientRect().width,
        panelWidth: panel?.getBoundingClientRect().width,
        resizers: resizers.map((e) => {
          const b = e.getBoundingClientRect(),
            hit =
              b.width && b.height
                ? document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)
                : null;
          return {
            label: e.getAttribute('aria-label'),
            display: getComputedStyle(e).display,
            rect: rect(e),
            actuallyHit: e === hit || e.contains(hit),
            pointerCapture: e.hasPointerCapture(1),
            active: e.classList.contains('crh-resizer-active'),
          };
        }),
      },
    };
  });
}
async function stable(p) {
  let last = '',
    n = 0;
  for (let i = 0; i < 150; i++) {
    await p.evaluate(() => new Promise(requestAnimationFrame));
    const d = await data(p),
      s = JSON.stringify(d),
      finite = await p.evaluate(() =>
        document
          .getAnimations()
          .every(
            (a) =>
              a.effect?.getTiming().iterations === Infinity ||
              (!a.pending && a.playState !== 'running')
          )
      );
    n = finite && last === s ? n + 1 : 0;
    last = s;
    if (n >= 3) return d;
  }
  throw Error('FullFieldsNotQuiescentWithin150ActualFrames');
}
async function capture(p, key, meta) {
  if (
    args.recover === 'true' &&
    meta.width === 1024 &&
    meta.font === 'default' &&
    !key.endsWith('-right-active-pointer-drag') &&
    !key.endsWith('-right-drag-released')
  )
    return;
  const pre = await stable(p),
    shot = 'shots/' + key + '.png';
  await p.screenshot({ path: path.join(out, shot), animations: 'allow', caret: 'initial' });
  const post = await data(p),
    raw = key + '-prepost.json',
    same = JSON.stringify(pre) === JSON.stringify(post);
  await writeFile(
    path.join(out, raw),
    JSON.stringify({ pre, post, strictPrePostEqual: same }, null, 2) + '\n'
  );
  assert.ok(same);
  entries.push({
    key,
    ...meta,
    shot,
    sha256: sha(await readFile(path.join(out, shot))),
    raw,
    records: post.records.length,
    strictPrePostEqual: true,
    sourceClassCarriers: await p
      .locator('.crh-resizer')
      .evaluateAll((es) =>
        es.map((e) => ({ label: e.getAttribute('aria-label'), class: e.getAttribute('class') }))
      ),
  });
  await save();
}
async function widths(p) {
  return p.evaluate(() => ({
    sidebar: document.querySelector('.crh-sidebar').getBoundingClientRect().width,
    panel: document.querySelector('.crh-panel').getBoundingClientRect().width,
  }));
}
const browser = await chromium.launch({
  executablePath:
    '/Users/wibus/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell',
});
try {
  for (const width of args.widths
    ? args.widths.split(',').map(Number)
    : [390, 1023, 1024, 1025, 1280])
    for (const font of args.fonts ? args.fonts.split(',') : ['default', '20px']) {
      const key = width + '-' + font,
        ctx = await browser.newContext({
          viewport: { width, height: 1000 },
          colorScheme: 'dark',
          reducedMotion: 'no-preference',
        }),
        p = await ctx.newPage();
      let current = key;
      try {
        if (args.initialFont) {
          const cdp = await ctx.newCDPSession(p);
          await cdp.send('Page.setFontSizes', {
            fontSizes: { standard: Number(args.initialFont), fixed: 13 },
          });
        }
        await p.goto(
          args.storybook +
            '/iframe.html?id=code-review-helper-reviewrenderer--grouped-refactor&viewMode=story'
        );
        await p.waitForFunction(
          (width) =>
            document.querySelector('.crh-shell') &&
            document.querySelectorAll('.crh-resizer').length === (width < 1024 ? 0 : 2) &&
            document.fonts.status === 'loaded',
          width
        );
        if (font === '20px')
          await p.evaluate(() => (document.documentElement.style.fontSize = '20px'));
        await p.waitForFunction(() => {
          const blocks = [...document.querySelectorAll('[data-block-path]')],
            q = window.__142ResizeWarm ?? { i: 0 };
          window.__142ResizeWarm = q;
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
        await p.mouse.move(-11, -11);
        await p.mouse.move(-10, -10);
        const d = await stable(p);
        assert.equal(
          d.state.less64rem,
          width < (args.initialFont ? Number(args.initialFont) * 64 : 1024)
        );
        assert.equal(d.state.less1024px, width < 1024);
        for (const e of d.state.resizers) {
          assert.equal(e.display === 'none', d.state.less64rem);
          if (d.state.less64rem) {
            assert.deepEqual(e.rect, [0, 0, 0, 0]);
            assert.equal(e.actuallyHit, false);
          } else assert.equal(e.actuallyHit, true);
        }
        await capture(p, key + '-rest', { width, font });
        if (!args.initialFont && font === 'default' && [1024, 1280].includes(width)) {
          const left = p.getByRole('separator', {
              name: 'Resize the navigation sidebar',
              exact: true,
            }),
            right = p.getByRole('separator', { name: 'Resize the review panel', exact: true });
          await left.hover();
          current = key + '-left-hover';
          await capture(p, current, { width, font });
          await p.mouse.move(-10, -10);
          await left.focus();
          await p.keyboard.press('Tab');
          await p.keyboard.press('Shift+Tab');
          await p.waitForFunction(
            () =>
              document.activeElement.getAttribute('aria-label') ===
                'Resize the navigation sidebar' && document.activeElement.matches(':focus-visible')
          );
          current = key + '-left-keyboard';
          await capture(p, current, { width, font });
          let w = await widths(p);
          await left.press('ArrowRight');
          await p.waitForFunction(
            (x) => document.querySelector('.crh-sidebar').getBoundingClientRect().width === x,
            w.sidebar + 16
          );
          current = key + '-left-arrow-right';
          await capture(p, current, { width, font });
          await left.press('ArrowLeft');
          await p.waitForFunction(
            (x) => document.querySelector('.crh-sidebar').getBoundingClientRect().width === x,
            w.sidebar
          );
          let b = await left.boundingBox();
          await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
          await p.mouse.down();
          await p.mouse.move(b.x + b.width / 2 + 32, b.y + b.height / 2);
          await p.waitForFunction(
            (x) => document.querySelector('.crh-sidebar').getBoundingClientRect().width === x,
            w.sidebar + 32
          );
          current = key + '-left-active-pointer-drag';
          await capture(p, current, { width, font });
          await p.mouse.up();
          await p.waitForFunction(
            () =>
              !document.querySelector('.crh-resizer-left').classList.contains('crh-resizer-active')
          );
          current = key + '-left-drag-released';
          await capture(p, current, { width, font });
          w = await widths(p);
          await right.focus();
          await right.press('ArrowRight');
          await p.waitForFunction(
            (x) => document.querySelector('.crh-panel').getBoundingClientRect().width === x,
            w.panel - 16
          );
          current = key + '-right-arrow-right';
          await capture(p, current, { width, font });
          await right.press('ArrowLeft');
          await p.waitForFunction(
            (x) => document.querySelector('.crh-panel').getBoundingClientRect().width === x,
            w.panel
          );
          b = await right.boundingBox();
          await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
          await p.mouse.down();
          await p.mouse.move(b.x + b.width / 2 - (width === 1024 ? 8 : 24), b.y + b.height / 2);
          await p.waitForFunction(
            (x) => document.querySelector('.crh-panel').getBoundingClientRect().width === x,
            w.panel + (width === 1024 ? 8 : 24)
          );
          current = key + '-right-active-pointer-drag';
          await capture(p, current, { width, font });
          await p.mouse.up();
          await p.waitForFunction(
            () =>
              !document.querySelector('.crh-resizer-right').classList.contains('crh-resizer-active')
          );
          current = key + '-right-drag-released';
          await capture(p, current, { width, font });
        }
      } catch (e) {
        const shot = 'shots/' + current + '-error.png';
        await p.mouse.up().catch(() => {});
        await p.screenshot({ path: path.join(out, shot), animations: 'allow' }).catch(() => {});
        failures.push({ key: current, message: String(e), shot });
        await save();
        console.log('FAIL', current, String(e));
      } finally {
        await ctx.close();
      }
      console.log(key, entries.length, failures.length);
    }
} finally {
  await browser.close();
  closedNormally = true;
  await save();
}
if (failures.length) process.exitCode = 1;
