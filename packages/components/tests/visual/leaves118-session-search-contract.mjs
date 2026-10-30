import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const [base, phase, buildFile] = process.argv.slice(2),
  out = 'artifacts/visual/' + phase,
  sha = (b) => createHash('sha256').update(b).digest('hex');
assert.match(phase, /^leaves118-[a-z-]+$/);
const build = JSON.parse(await readFile(buildFile)),
  ids = JSON.parse(await readFile('artifacts/visual/leaves118-before-token-reader-ids.json')),
  tokenGroups = ids.groups;
assert.ok(
  build.success &&
    build.actualBuildProcessExitCode === 0 &&
    build.postBuildHashMatches &&
    build.rootLockPostHashMatches
);
for (const f of ['index.json', 'iframe.html'])
  assert.equal(
    sha(Buffer.from(await (await fetch(base + '/' + f)).arrayBuffer())),
    sha(await readFile(path.join(build.output, f)))
  );
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' }),
  rows = [],
  errors = [],
  routes = [],
  version = browser.version();
let live,
  current = {},
  closedNormally = false;
const harnessSHA256 = sha(await readFile(new URL(import.meta.url)));
const targetKeys = {
  field: ['background', 'paddingXMedium', 'text', 'placeholder'],
  button: [],
  tooltip: ['paddingX', 'paddingY', 'text'],
};
async function checkpoint() {
  await writeFile(
    out + '/proof.json',
    JSON.stringify(
      {
        base,
        phase,
        buildProof: buildFile,
        source: build.rows.find((r) =>
          r.file.endsWith('/src/components/sessions/session-chat-interface.tsx')
        ),
        groups: tokenGroups,
        targetKeys,
        rows,
        errors,
        routes,
        closedNormally,
        browserVersion: version,
        harnessSHA256,
        scope:
          'Actual SessionSearchBar; complete ordinaryCSS/threepseudos/all80semantic tokens onallownednodes andpseudos/legacyvars/rawattrs/precisegeometry/wholebodygeometry. Same-element directtoken writes are excludednegativecontrols.',
      },
      null,
      2
    ) + '\n'
  );
}
async function settle(p) {
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
}
async function open(width, theme) {
  const p = await browser.newPage({
    viewport: { width, height: 420 },
    colorScheme: theme,
    reducedMotion: 'reduce',
  });
  live = p;
  p.on('pageerror', (e) => errors.push({ ...current, error: String(e) }));
  await p.goto(
    base +
      '/iframe.html?id=migration-ownedsessionsearchtokens--results&viewMode=story&globals=theme:' +
      theme +
      ';locale:en'
  );
  await p.waitForFunction(
    () =>
      document.querySelector('[data-search-token-fixture]')?.dataset.searchQuery === 'needle' &&
      document.querySelector('[role=search] input')?.getBoundingClientRect().width > 0 &&
      document.documentElement.classList.contains('dark') ===
        matchMedia('(prefers-color-scheme: dark)').matches
  );
  await settle(p);
  return p;
}
async function snapshot(p) {
  return p.evaluate((g) => {
    const root = document.querySelector('[data-search-token-fixture]'),
      tip = document.querySelector('[data-base-ui-focusable][data-side][tabindex="-1"]'),
      nodes = [
        root,
        ...root.querySelectorAll('*'),
        ...(tip ? [tip, ...tip.querySelectorAll('*')] : []),
      ],
      keys = [
        '--spacing',
        '--radius-md',
        '--font-sans',
        '--font-mono',
        '--muted-foreground',
        '--tw-leading',
        '--tw-font-weight',
        '--tw-ring-shadow',
        '--tw-shadow',
        '--tw-tracking',
      ];
    const ordinary = (s) =>
        Object.fromEntries(
          [...s]
            .filter((k) => !k.startsWith('--'))
            .sort()
            .map((k) => [k, s.getPropertyValue(k)])
        ),
      tokens = (s) =>
        Object.fromEntries(
          Object.entries(g).flatMap(([group, vs]) =>
            Object.entries(vs).map(([k, v]) => [group + '.' + k, s.getPropertyValue(v)])
          )
        );
    return {
      rootDark: document.documentElement.classList.contains('dark'),
      state: {
        query: root.dataset.searchQuery,
        index: root.dataset.searchIndex,
        count: root.dataset.searchCount,
        open: root.dataset.searchOpen,
        event: root.querySelector('output').textContent,
        focus: document.activeElement?.getAttribute('aria-label'),
        documentHasFocus: document.hasFocus(),
      },
      nodes: nodes.map((e) => {
        const s = getComputedStyle(e);
        return {
          tag: e.tagName,
          text: e.textContent,
          attrs: Object.fromEntries(
            [...e.attributes].filter((a) => a.name !== 'class').map((a) => [a.name, a.value])
          ),
          rect: e.getBoundingClientRect().toJSON(),
          css: ordinary(s),
          tokens: tokens(s),
          legacy: Object.fromEntries(keys.map((k) => [k, s.getPropertyValue(k)])),
          pseudos: Object.fromEntries(
            ['::before', '::after', '::placeholder'].map((k) => {
              const ps = getComputedStyle(e, k);
              return [k, { css: ordinary(ps), tokens: tokens(ps) }];
            })
          ),
        };
      }),
      wholeGeometry: [...document.body.querySelectorAll('*')].map((e) => ({
        tag: e.tagName,
        rect: e.getBoundingClientRect().toJSON(),
      })),
    };
  }, tokenGroups);
}
async function capture(p, key, negative = false) {
  await settle(p);
  await p.waitForFunction(async () => {
    const sample = () =>
      JSON.stringify(
        [
          ...document.querySelectorAll(
            '[role=search] input,[role=search] button,[data-base-ui-focusable][data-side][tabindex="-1"],[data-base-ui-focusable][data-side][tabindex="-1"] *'
          ),
        ].map((e) => e.getBoundingClientRect().toJSON())
      );
    const a = sample();
    await new Promise(requestAnimationFrame);
    const b = sample();
    await new Promise(requestAnimationFrame);
    return a === b && b === sample();
  });
  const pre = await snapshot(p);
  assert.equal(pre.rootDark, current.theme === 'dark');
  const r = await p.locator('[role=search] input').boundingBox();
  assert.ok(
    r &&
      r.width > 0 &&
      r.x >= 0 &&
      r.y >= 0 &&
      r.x + r.width <= current.width &&
      r.y + r.height <= 420,
    'paintedinput'
  );
  const shot = key + '.png';
  await p.screenshot({ path: out + '/' + shot, caret: 'hide', animations: 'allow' });
  assert.deepEqual(await snapshot(p), pre, 'strictprepost');
  rows.push({
    key,
    shot,
    sha256: sha(await readFile(out + '/' + shot)),
    negative,
    snapshot: pre,
    strictPrePostEqual: true,
  });
  await checkpoint();
}
async function route(p) {
  return p.evaluate((g) => {
    const all = [];
    function walk(rs, c = []) {
      for (const r of rs) {
        if (r.selectorText) all.push({ selector: r.selectorText, style: r.style, chain: c });
        if (r.cssRules) walk(r.cssRules, [...c, r.name ?? r.conditionText ?? '']);
      }
    }
    for (const s of document.styleSheets)
      try {
        walk(s.cssRules);
      } catch {}
    return [
      document.querySelector('[role=search] input'),
      ...document.querySelectorAll('[role=search] button'),
      document.querySelector('[data-base-ui-focusable][data-side][tabindex="-1"]'),
    ]
      .filter(Boolean)
      .map((e) => ({
        tag: e.tagName,
        aria: e.getAttribute('aria-label'),
        readers: all
          .filter(
            (r) =>
              r.chain.some((x) => x.startsWith('stylex')) &&
              (() => {
                try {
                  return e.matches(r.selector.replace(/::(placeholder|before|after)\b/g, ''));
                } catch {
                  return false;
                }
              })()
          )
          .flatMap((r) =>
            [...r.style]
              .filter((k) => !k.startsWith('--'))
              .map((k) => ({
                selector: r.selector,
                property: k,
                value: r.style.getPropertyValue(k),
              }))
          )
          .filter((r) =>
            Object.values(g).some((vs) => Object.values(vs).some((v) => r.value.includes(v)))
          ),
      }));
  }, tokenGroups);
}
try {
  if (!['tooltips-only', 'candidate-missing'].includes(process.argv[5]))
    for (const theme of ['light', 'dark'])
      for (const width of [390, 1280]) {
        for (const mode of ['default', 'ancestor-tokens', 'local-legacy', 'root-leading']) {
          current = { theme, width, mode };
          const p = await open(width, theme);
          if (mode === 'ancestor-tokens')
            await p.evaluate((g) => {
              const root = document.documentElement,
                f = document.querySelector('[data-search-token-fixture]');
              for (const [k, v] of [
                [g.field.background, 'rgb(210,10,80)'],
                [g.field.paddingXMedium, '24px'],
                [g.field.text, '21px'],
                [g.field.placeholder, 'rgb(10,160,70)'],
                [g.button.radiusMedium, '29px'],
                [g.tooltip.text, '23px'],
                [g.tooltip.paddingX, '22px'],
                [g.tooltip.paddingY, '15px'],
                [g.button.gap, '17px'],
                [g.field.radiusMedium, '19px'],
                [g.field.well, 'inset 0 0 0 3px rgb(205,90,10)'],
                [g.tooltip.leading, '29px'],
                [g.tooltip.shadow, '0 0 0 3px rgb(150,20,190)'],
              ])
                root.style.setProperty(k, v);
              f.style.setProperty('--spacing', '7px');
              f.style.setProperty('--radius-md', '13px');
            }, tokenGroups);
          if (mode === 'local-legacy')
            await p.evaluate(() => {
              const f = document.querySelector('[data-search-token-fixture]'),
                i = f.querySelector('input');
              f.style.fontFamily = 'Georgia, serif';
              i.style.setProperty('--spacing', '6px');
              i.style.setProperty('--muted-foreground', '222 63% 44%');
              i.style.setProperty('--tw-font-weight', '650');
              i.style.setProperty('--tw-leading', '38px');
              f.style.setProperty('--radius-md', '15px');
            });
          if (mode === 'root-leading')
            await p.evaluate(() => {
              document.documentElement.style.fontSize = '20px';
              document.querySelector('input').style.setProperty('--tw-leading', '31px');
              document
                .querySelector('[data-search-token-fixture]')
                .style.setProperty('--font-sans', 'fantasy');
            });
          await capture(p, [width, theme, mode].join('-'));
          if (mode === 'default') {
            routes.push({ width, theme, readers: await route(p) });
            const input = p.locator('[role=search] input'),
              state = p.locator('[data-search-token-fixture]');
            await input.press('Enter');
            assert.equal(await state.getAttribute('data-search-index'), '1');
            await input.press('Shift+Enter');
            assert.equal(await state.getAttribute('data-search-index'), '0');
            await p.locator('[role=search] button').nth(1).click();
            assert.equal(await state.getAttribute('data-search-index'), '1');
            await p.locator('[role=search] button').nth(0).click();
            assert.equal(await state.getAttribute('data-search-index'), '0');
            await input.fill('changed needle');
            await input.press('Escape');
            await p.waitForFunction(
              () =>
                document.querySelector('[data-search-token-fixture]')?.dataset.searchQuery === ''
            );
            await input.press('Escape');
            await p.getByRole('button', { name: 'Reopen search', exact: true }).click();
            await p.waitForFunction(
              () =>
                document.activeElement === document.querySelector('[role=search] input') &&
                document.querySelector('[data-search-token-fixture]')?.dataset.searchOpen === 'true'
            );
            assert.equal(await p.locator('[role=search] button:disabled').count(), 2);
            await p.mouse.move(4, 180);
            await capture(p, [width, theme, 'flow-clear-close-reopen'].join('-'));
          }
          await p.close();
        }
        current = { theme, width, mode: 'direct-token-negative' };
        const p = await open(width, theme);
        await p.evaluate((g) => {
          const i = document.querySelector('[role=search] input');
          for (const [k, v] of [
            [g.field.background, 'rgb(210,10,80)'],
            [g.field.paddingXMedium, '24px'],
            [g.field.text, '21px'],
            [g.field.placeholder, 'rgb(10,160,70)'],
          ])
            i.style.setProperty(k, v);
          for (const b of document.querySelectorAll('[role=search] button'))
            b.style.setProperty(g.button.radiusMedium, '29px');
        }, tokenGroups);
        await capture(p, [width, theme, 'direct-token-negative'].join('-'), true);
        await p.close();
      }
  for (const theme of ['light', 'dark']) {
    current = { theme, width: 1280, mode: 'tooltips' };
    const p = await open(1280, theme);
    for (const [index, name] of ['previous', 'next', 'close'].entries()) {
      await p.mouse.move(4, 180);
      await p.waitForFunction(
        () => !document.querySelector('[data-base-ui-focusable][data-side][tabindex="-1"]')
      );
      await p.locator('[role=search] button').nth(index).hover();
      await p.waitForFunction(() => {
        const t = document.querySelector('[data-base-ui-focusable][data-side][tabindex="-1"]');
        return (
          t &&
          getComputedStyle(t).opacity === '1' &&
          t.getBoundingClientRect().width > 0 &&
          t.getBoundingClientRect().y >= 0 &&
          document
            .getAnimations()
            .every(
              (a) =>
                a.effect?.getTiming().iterations === Infinity ||
                (!a.pending && a.playState !== 'running')
            )
        );
      });
      if (!(process.argv[5] === 'candidate-missing' && theme === 'light')) {
        await capture(p, [1280, theme, 'tooltip', name].join('-'));
        routes.push({ theme, tooltip: name, readers: await route(p) });
      }
    }
    await p.evaluate((g) => {
      const t = document.querySelector('[data-base-ui-focusable][data-side][tabindex="-1"]');
      for (const [k, v] of [
        [g.tooltip.text, '23px'],
        [g.tooltip.paddingX, '22px'],
        [g.tooltip.paddingY, '15px'],
      ])
        t.style.setProperty(k, v);
    }, tokenGroups);
    await capture(p, [1280, theme, 'tooltip-direct-token-negative'].join('-'), true);
    await p.close();
  }
} catch (e) {
  errors.push({ ...current, error: String(e) });
  if (live && !live.isClosed())
    await live.screenshot({ path: out + '/error.png', caret: 'hide' }).catch(() => null);
  await checkpoint();
  throw e;
} finally {
  await browser.close();
  closedNormally = true;
  await checkpoint();
}
console.log({
  phase,
  rows: rows.length,
  positive: rows.filter((r) => !r.negative).length,
  negative: rows.filter((r) => r.negative).length,
  errors: errors.length,
  closedNormally,
});
