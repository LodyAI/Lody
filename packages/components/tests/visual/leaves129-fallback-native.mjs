import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const args = Object.fromEntries(
    process.argv.slice(2).flatMap((x, i, l) => (x.startsWith('--') ? [[x.slice(2), l[i + 1]]] : []))
  ),
  v = path.resolve('artifacts/visual'),
  out = path.join(v, args.phase),
  sha = (b) => createHash('sha256').update(b).digest('hex'),
  bad = 'code-review-helper-reviewrenderer--rendering-error-fallback',
  good = 'code-review-helper-reviewrenderer--grouped-refactor';
await mkdir(path.join(out, 'shots'), { recursive: true });
const vars = [
    '--spacing',
    '--container-md',
    '--text-sm',
    '--text-sm--line-height',
    '--font-weight-semibold',
    '--leading-relaxed',
    '--foreground',
    '--background',
    '--muted-foreground',
    '--tw-leading',
    '--tw-font-weight',
  ],
  palette = {
    '--spacing': '7px',
    '--container-md': '22rem',
    '--text-sm': '19px',
    '--text-sm--line-height': '1.8',
    '--font-weight-semibold': '800',
    '--leading-relaxed': '1.9',
    '--foreground': '220 15% 16% / .85',
    '--background': '40 30% 97% / .9',
    '--muted-foreground': '220 20% 35% / .75',
    '--tw-leading': '2.15',
    '--tw-font-weight': '200',
  },
  entries = [],
  recovery = [],
  failures = [];
let closedNormally = false;
async function save() {
  await writeFile(
    path.join(out, 'proof.json'),
    JSON.stringify(
      {
        phase: args.phase,
        storybook: args.storybook,
        scope:
          'Actual productionErrorBoundary catchesReactobjectchild error31 fromone synthetic Story title. No mockfallback/guards/exports. Allordinary+dual-pseudo+11rawlegacy vars/DOM state/wholegeometry. ExpectedcaughtReacterrors explicitlykept.',
        vars,
        palette,
        entries,
        recovery,
        failures,
        closedNormally,
      },
      null,
      2
    ) + '\n'
  );
}
async function ready(p) {
  await p.waitForFunction(() => {
    const e = document.querySelector('.crh-shell');
    return (
      e?.textContent.includes('Something went wrong rendering this review.') &&
      getComputedStyle(e).backgroundColor === 'rgb(19, 20, 22)' &&
      document.fonts.status === 'loaded'
    );
  });
}
async function configure(p, mode) {
  await p.evaluate(
    ({ mode, palette, vars }) => {
      const root = document.querySelector('.crh-shell'),
        content = root.firstElementChild,
        title = content.firstElementChild,
        help = content.lastElementChild;
      const groups = [
        [root, ['--spacing', '--foreground', '--background']],
        [content, ['--container-md']],
        [
          title,
          [
            '--text-sm',
            '--text-sm--line-height',
            '--font-weight-semibold',
            '--tw-leading',
            '--tw-font-weight',
          ],
        ],
        [help, ['--spacing', '--leading-relaxed', '--muted-foreground']],
      ];
      if (mode === 'ancestor') {
        document.documentElement.style.fontSize = '20px';
        root.dir = 'rtl';
        for (const [k, v] of Object.entries(palette)) root.parentElement.style.setProperty(k, v);
      }
      if (mode === 'element')
        for (const [e, keys] of groups) for (const k of keys) e.style.setProperty(k, palette[k]);
      if (mode === 'initial')
        for (const [e, keys] of groups) for (const k of keys) e.style.setProperty(k, 'initial');
      if (mode === 'inherit')
        for (const [e, keys] of groups)
          for (const k of keys) {
            e.parentElement.style.setProperty(k, palette[k]);
            e.style.setProperty(k, 'inherit');
          }
      if (mode === 'invalid-spacing') root.style.setProperty('--spacing', 'initial');
    },
    { mode, palette, vars }
  );
}
async function data(p, normal = false) {
  return p.evaluate(
    ({ vars, normal }) => {
      const root = document.querySelector('.crh-shell'),
        nodes = normal
          ? [document.querySelector('.crh-sidebar h1')]
          : [root, ...root.querySelectorAll('*')],
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
          flags: Object.fromEntries(
            ['hover', 'active', 'focus', 'focus-visible'].map((k) => [k, e.matches(':' + k)])
          ),
        })),
        geometry: normal
          ? nodes.map((e) => ({ tag: e.tagName, rect: rect(e) }))
          : [root, ...root.querySelectorAll('*')].map((e) => ({ tag: e.tagName, rect: rect(e) })),
        state: {
          fallbackVisible: root.textContent.includes('Something went wrong rendering this review.'),
          validSidebar: !!document.querySelector('.crh-sidebar'),
          activeElement: document.activeElement.tagName,
          documentHasFocus: document.hasFocus(),
          rootFont: getComputedStyle(document.documentElement).fontSize,
          systemDark: matchMedia('(prefers-color-scheme:dark)').matches,
          actualScheme: getComputedStyle(root).colorScheme,
        },
      };
    },
    { vars, normal }
  );
}
async function stable(p, normal) {
  let previous = '',
    n = 0;
  for (let i = 0; i < 120; i++) {
    await p.evaluate(() => new Promise(requestAnimationFrame));
    const d = await data(p, normal),
      h = sha(Buffer.from(JSON.stringify(d))),
      finite = await p.evaluate(() =>
        document
          .getAnimations()
          .every(
            (a) =>
              a.effect?.getTiming().iterations === Infinity ||
              (!a.pending && a.playState !== 'running')
          )
      );
    n = finite && h === previous ? n + 1 : 0;
    previous = h;
    if (n >= 3) return d;
  }
  throw Error('FullFieldsNotQuiescentWithin120ActualFrames');
}
async function capture(p, key, events, normal = false) {
  const pre = await stable(p, normal),
    shot = 'shots/' + key + '.png';
  await p.screenshot({ path: path.join(out, shot), animations: 'allow', caret: 'initial' });
  const post = await data(p, normal),
    raw = key + '-prepost.json',
    same = JSON.stringify(pre) === JSON.stringify(post);
  await writeFile(
    path.join(out, raw),
    JSON.stringify({ pre, post, strictPrePostEqual: same }, null, 2) + '\n'
  );
  if (!same) throw Error('StrictPrePostChanged');
  const expected = events.console.filter((x) =>
    /Minified React error #31|Objects are not valid as a React child/.test(x)
  );
  assert.ok(expected.length, 'actualcaughtReacterrorrecorded');
  assert.deepEqual(
    events.console.filter((x) => !expected.includes(x)),
    [],
    'unexpectedconsoleerrors'
  );
  assert.deepEqual(events.pageErrors, [], 'unhandledpageerrors');
  return {
    key,
    shot,
    sha256: sha(await readFile(path.join(out, shot))),
    raw,
    records: post.records.length,
    strictPrePostEqual: true,
    events: structuredClone(events),
    expectedCaughtReactErrors: expected.length,
  };
}
const browser = await chromium.launch({
  executablePath:
    '/Users/wibus/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell',
});
try {
  for (const width of [390, 1280])
    for (const mode of [
      'default',
      'ancestor',
      'element',
      'initial',
      'inherit',
      'invalid-spacing',
    ]) {
      const key = width + '-' + mode,
        ctx = await browser.newContext({
          viewport: { width, height: 900 },
          colorScheme: 'dark',
          reducedMotion: 'no-preference',
        }),
        p = await ctx.newPage(),
        events = { console: [], pageErrors: [] };
      p.on('console', (m) => {
        if (m.type() === 'error') events.console.push(m.text());
      });
      p.on('pageerror', (e) => events.pageErrors.push(String(e)));
      try {
        await p.goto(args.storybook + '/iframe.html?id=' + bad + '&viewMode=story');
        await ready(p);
        await configure(p, mode);
        entries.push({ ...(await capture(p, key, events)), mode, width });
        await save();
        console.log(key, 'actualcaught', events.console.length);
        if (mode === 'default') {
          await p.reload();
          await ready(p);
          recovery.push({
            ...(await capture(p, width + '-real-reload-invalid-still-fallback', events)),
            action: 'realreloadsameinvalidinput',
            width,
          });
          const beforeValidConsole = events.console.length;
          await p.goto(args.storybook + '/iframe.html?id=' + good + '&viewMode=story');
          await p.waitForFunction(
            () =>
              document.querySelector('.crh-sidebar h1')?.textContent === 'Lody Review' &&
              !document
                .querySelector('.crh-shell')
                .textContent.includes('Something went wrong rendering this review.') &&
              document.fonts.status === 'loaded'
          );
          assert.equal(
            events.console.length,
            beforeValidConsole,
            'validstorydoesnotthrownewReacterror'
          );
          recovery.push({
            ...(await capture(p, width + '-real-valid-navigation-restores-ui', events, true)),
            action: 'realnavigationfreshvalidinput',
            width,
          });
          await save();
        }
      } catch (e) {
        const shot = 'shots/' + key + '-error.png';
        await p
          .screenshot({ path: path.join(out, shot), animations: 'allow', caret: 'initial' })
          .catch(() => {});
        failures.push({ key, message: String(e), shot, events });
        await save();
        console.log('FAIL', key, String(e));
      } finally {
        await ctx.close();
      }
    }
} finally {
  await browser.close();
  closedNormally = true;
  await save();
}
console.log({ entries: entries.length, recovery: recovery.length, failures: failures.length });
if (failures.length) process.exitCode = 1;
