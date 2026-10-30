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
const vars = [
  '--spacing',
  '--foreground',
  '--muted-foreground',
  '--background',
  '--tw-ring-color',
  '--tw-ring-shadow',
  '--tw-duration',
  '--tw-ease',
  '--crh-muted-button-label',
];
const selectors = {
  map: '.crh-toolbar button[title="Hide review map"]',
  panel: '.crh-toolbar button[title="Hide review thread"]',
  group: 'button[aria-label="Group actions"]',
  add: '[data-block-path="packages/adaptors/src/index.ts"] button[aria-label^="Add a review comment to"]',
  remove: 'button[aria-label="Delete comment"]',
};
async function save() {
  await writeFile(
    path.join(out, 'proof.json'),
    JSON.stringify(
      {
        phase: args.phase,
        storybook: args.storybook,
        vars,
        selectors,
        entries,
        failures,
        closedNormally,
        scope:
          'ActualprivateToolbar/GroupMenu/headerAdd/DeleteButtons. Completeleftsidebar/toolbar/selectedheader/commentpanelordinary+dualpseudo/legacyvars/nonclassattrsandwholegeometry; actual pointer/focus/media. class/inline rawstyle/newlabel custom carrier NOT declared fullJSONequal. No third-party shadow CSS.',
      },
      null,
      2
    ) + '\n'
  );
}
async function data(p) {
  return p.evaluate(
    ({ vars, selectors }) => {
      const side = document.querySelector('.crh-sidebar'),
        toolbar = document.querySelector('.crh-toolbar'),
        header = document.querySelector(
          '[data-block-path="packages/adaptors/src/index.ts"] .crh-block-header'
        ),
        panel = document.querySelector('aside[aria-label="Review comments"]');
      const nodes = [
          ...new Set(
            [side, toolbar, header, panel]
              .filter(Boolean)
              .flatMap((e) => [e, ...e.querySelectorAll('*')])
          ),
        ],
        css = (e, ps) => {
          const c = getComputedStyle(e, ps);
          return Object.fromEntries(
            [...c].filter((k) => !k.startsWith('--')).map((k) => [k, c.getPropertyValue(k)])
          );
        },
        rect = (e) => {
          const r = e.getBoundingClientRect();
          return [r.x, r.y, r.width, r.height];
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
          inline: Object.fromEntries([...e.style].map((k) => [k, e.style.getPropertyValue(k)])),
          pseudos: Object.fromEntries(
            [
              'hover',
              'active',
              'focus',
              'focus-visible',
              'checked',
              'indeterminate',
              'disabled',
            ].map((k) => [k, e.matches(':' + k)])
          ),
          checked: e.checked ?? null,
          indeterminate: e.indeterminate ?? null,
        })),
        geometry: [...document.querySelectorAll('.crh-shell,.crh-shell *')].map((e) => ({
          tag: e.tagName,
          rect: rect(e),
        })),
        state: {
          font: getComputedStyle(document.documentElement).fontSize,
          hoverMedia: matchMedia('(hover:hover)').matches,
          coarse: matchMedia('(pointer:coarse)').matches,
          forced: matchMedia('(forced-colors:active)').matches,
          active: {
            tag: document.activeElement?.tagName,
            name:
              document.activeElement?.getAttribute('aria-label') ??
              document.activeElement?.getAttribute('title'),
          },
          hasFocus: document.hasFocus(),
          targets: Object.fromEntries(
            Object.entries(selectors).map(([k, s]) => {
              const e = document.querySelector(s);
              return [
                k,
                e
                  ? {
                      rect: rect(e),
                      hover: e.matches(':hover'),
                      focusVisible: e.matches(':focus-visible'),
                      hit: (() => {
                        const r = e.getBoundingClientRect();
                        return e.contains(
                          document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
                        );
                      })(),
                    }
                  : null,
              ];
            })
          ),
          portals: [...document.querySelectorAll('[role=tooltip],[role=menu]')]
            .filter((e) => e.getBoundingClientRect().height > 0)
            .map((e) => ({ role: e.getAttribute('role'), text: e.textContent, rect: rect(e) })),
        },
      };
    },
    { vars, selectors }
  );
}
async function stable(p) {
  await p.waitForFunction(
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
  for (let i = 0; i < 12; i++) {
    const a = await data(p);
    await p.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    );
    const b = await data(p);
    if (JSON.stringify(a) === JSON.stringify(b)) return b;
  }
  throw Error('Fullfieldsnotstable12doubleRAF');
}
async function capture(p, key, meta) {
  const pre = await stable(p),
    shot = 'shots/' + key + '.png';
  assert.equal(pre.state.portals.length, 0, 'explicitclosedportal');
  await p.screenshot({ path: path.join(out, shot), animations: 'allow', caret: 'initial' });
  const post = await data(p),
    raw = key + '-prepost.json',
    same = JSON.stringify(pre) === JSON.stringify(post);
  await writeFile(
    path.join(out, raw),
    JSON.stringify({ pre, post, strictPrePostEqual: same }, null, 2) + '\n'
  );
  assert.ok(same, 'Strictfullfieldsprepost');
  entries.push({
    key,
    ...meta,
    shot,
    sha256: sha(await readFile(path.join(out, shot))),
    raw,
    records: post.records.length,
    strictPrePostEqual: true,
    sourceClassCarriers: await p
      .locator('.crh-shell,.crh-shell *')
      .evaluateAll((es) => es.map((e, i) => ({ i, class: e.getAttribute('class') }))),
  });
  await save();
}
const browser = await chromium.launch({
  executablePath:
    '/Users/wibus/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell',
});
try {
  for (const width of [390, 1280])
    for (const env of args.envs
      ? args.envs.split(',')
      : ['default', 'local', 'initial', 'inherit', 'coarse', 'forced-colors']) {
      const c = await browser.newContext({
          viewport: { width, height: 1000 },
          colorScheme: 'dark',
          reducedMotion: 'no-preference',
          isMobile: env === 'coarse',
          hasTouch: env === 'coarse',
          forcedColors: env === 'forced-colors' ? 'active' : 'none',
        }),
        p = await c.newPage(),
        key = width + '-' + env;
      try {
        await p.goto(
          args.storybook +
            '/iframe.html?id=code-review-helper-reviewrenderer--with-existing-comments&viewMode=story'
        );
        await p.waitForFunction(
          () =>
            document.querySelector('aside[aria-label="Review comments"] article[data-anchor]') &&
            document.fonts.status === 'loaded' &&
            (getComputedStyle(document.querySelector('.crh-shell')).backgroundColor ===
              'rgb(19, 20, 22)' ||
              (matchMedia('(forced-colors:active)').matches &&
                getComputedStyle(document.documentElement)
                  .getPropertyValue('--background')
                  .trim() === '220 7.3% 8%'))
        );
        await p.waitForFunction(() => {
          const blocks = [...document.querySelectorAll('[data-block-path]')],
            q = window.__143Warm ?? { i: 0 };
          window.__143Warm = q;
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
        if (['local', 'initial', 'inherit'].includes(env))
          await p.evaluate(
            ({ env, selectors }) => {
              for (const s of Object.values(selectors)) {
                const e = document.querySelector(s);
                if (!e) continue;
                for (const [k, v] of Object.entries({
                  '--spacing': '5px',
                  '--foreground': '185 65% 77%',
                  '--muted-foreground': '340 60% 65%',
                  '--tw-duration': '71ms',
                  '--tw-ease': 'linear',
                })) {
                  if (env === 'inherit') {
                    e.parentElement.style.setProperty(k, v);
                    e.style.setProperty(k, 'inherit');
                  } else e.style.setProperty(k, env === 'initial' ? 'initial' : v);
                }
              }
            },
            { env, selectors }
          );
        await p.keyboard.press('Escape');
        await p.mouse.move(-10, -10);
        for (const target of ['group', 'add', 'remove']) {
          const e = p.locator(selectors[target]).first();
          await e.scrollIntoViewIfNeeded();
          await e.hover();
          await p.waitForFunction((s) => {
            const e = document.querySelector(s),
              r = e.getBoundingClientRect();
            return (
              r.width > 0 &&
              r.height > 0 &&
              e.matches(':hover') &&
              e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
            );
          }, selectors[target]);
          await capture(p, key + '-' + target + '-hover', {
            width,
            env,
            target,
            state: 'actualpointerhover',
          });
        }
        const group = p.locator(selectors.group).first();
        await group.focus();
        await p.keyboard.press('Tab');
        await p.keyboard.press('Shift+Tab');
        await p.mouse.move(-10, -10);
        await group.scrollIntoViewIfNeeded();
        await p.waitForFunction(
          (s) =>
            document.querySelector(s) === document.activeElement &&
            document.activeElement.matches(':focus-visible'),
          selectors.group
        );
        await capture(p, key + '-group-keyboard', {
          width,
          env,
          target: 'group',
          state: 'actualTabShiftTabfocus',
        });
        console.log(key, entries.length, failures.length);
      } catch (e) {
        const shot = 'shots/' + key + '-error.png';
        await p.screenshot({ path: path.join(out, shot), animations: 'allow' }).catch(() => {});
        failures.push({ key, message: String(e), shot });
        await save();
        console.log('FAIL', key, String(e));
      } finally {
        await c.close();
      }
    }
} finally {
  await browser.close();
  closedNormally = true;
  await save();
}
if (failures.length) process.exitCode = 1;
