import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const arg = Object.fromEntries(
  process.argv.slice(2).flatMap((x, i, l) => (x.startsWith('--') ? [[x.slice(2), l[i + 1]]] : []))
);
const v = path.resolve('artifacts/visual'),
  out = path.join(v, arg.phase),
  sha = (b) => createHash('sha256').update(b).digest('hex'),
  profile = JSON.parse(await readFile('tests/visual/leaves126-typography-targets.json')),
  before = arg.before ? JSON.parse(await readFile(path.join(v, arg.before, 'proof.json'))) : null;
await mkdir(path.join(out, 'shots'), { recursive: true });
const privateVars = [
  '--tw-font-weight',
  '--tw-leading',
  '--tw-tracking',
  '--tw-ordinal',
  '--tw-slashed-zero',
  '--tw-numeric-figure',
  '--tw-numeric-spacing',
  '--tw-numeric-fraction',
];
const aliases = {
  '--font-weight-medium': '800',
  '--font-weight-semibold': '900',
  '--font-weight-bold': '300',
  '--leading-tight': '2.1',
  '--leading-snug': '1.9',
  '--tracking-tight': '.18em',
  '--tracking-wide': '-.04em',
  '--spacing': '7px',
};
const tokens = [
  'font-medium',
  'font-semibold',
  'font-bold',
  'leading-tight',
  'leading-snug',
  'leading-none',
  'leading-[1.7]',
  'leading-5',
  'leading-6',
  'tracking-tight',
  'tracking-wide',
  'tracking-[0.1em]',
  'tracking-[0.16em]',
  'tabular-nums',
];
const entries = [],
  primers = [],
  failures = [],
  prefix = 'code-review-helper-reviewrenderer--';
let closedNormally = false;
async function save() {
  await writeFile(
    path.join(out, 'proof.json'),
    JSON.stringify(
      {
        phase: arg.phase,
        storybook: arg.storybook,
        scope:
          '126 actual privateTypography only. Excludes Checkbox/ReviewCheck/FileTree/Row/publiccontrols/fallback; full ordinary+dual pseudo+8writers+themealiases+flags+wholegeometry. No production/state writes.',
        beforeProof: arg.before ?? null,
        privateVars,
        aliases,
        entries,
        primers,
        failures,
        closedNormally,
      },
      null,
      2
    ) + '\n'
  );
}
async function apply(p, steps) {
  for (const s of steps ?? []) {
    const l = s.selector ? p.locator(s.selector) : null;
    switch (s.action) {
      case 'waitForFunction':
        await p.waitForFunction(s.expression);
        break;
      case 'movePointer':
        await p.mouse.move(s.x, s.y);
        break;
      case 'click':
        await (
          l
            ? s.index === undefined
              ? l
              : l.nth(s.index)
            : p.getByRole(s.role, { name: s.name, exact: true })
        ).click();
        break;
      case 'hover':
        await (s.index === undefined ? l : l.nth(s.index)).hover();
        break;
      case 'visible':
        await l.waitFor({ state: 'visible' });
        break;
      case 'focus':
        await l.focus();
        break;
      case 'press':
        await l.press(s.key);
        break;
      default:
        throw Error('unsupported ' + s.action);
    }
  }
}
async function paths(p, prior) {
  if (prior) return prior;
  return p.evaluate((tokens) => {
    const root = document.querySelector('.crh-shell');
    function path(e) {
      const a = [];
      while (e !== root) {
        a.unshift([...e.parentElement.children].indexOf(e));
        e = e.parentElement;
      }
      return a;
    }
    const nodes = [...root.querySelectorAll('*')].filter(
      (e) =>
        tokens.some((t) => e.classList.contains(t)) &&
        !e.closest(
          'nav[aria-label="Changed files"],label,[data-slot="alert-title"],[role="menu"]'
        ) &&
        !e.classList.contains('disabled:opacity-50')
    );
    return nodes.map((e) => ({
      path: path(e),
      tag: e.tagName,
      text: e.textContent,
      tokens: tokens.filter((t) => e.classList.contains(t)),
    }));
  }, tokens);
}
async function configure(p, mode, list) {
  await p.evaluate(
    ({ mode, list, privateVars, aliases }) => {
      const root = document.querySelector('.crh-shell'),
        node = (x) => x.path.reduce((e, i) => e.children[i], root),
        targets = list.map(node);
      window.__126TargetPaths = list.map((x) => x.path);
      for (const x of list)
        if (node(x).tagName !== x.tag || node(x).textContent !== x.text)
          throw Error('BeforeAfterTargetIdentity');
      if (mode === 'scoped') {
        root.dir = 'rtl';
        document.documentElement.style.fontSize = '20px';
        for (const [k, v] of Object.entries(aliases)) root.style.setProperty(k, v);
      }
      if (mode === 'initial') {
        for (const e of targets)
          for (const k of [...privateVars, ...Object.keys(aliases)])
            e.style.setProperty(k, 'initial');
      }
      if (mode === 'inherit') {
        for (const e of targets) {
          for (const [k, val] of Object.entries(aliases)) e.parentElement.style.setProperty(k, val);
          for (const k of privateVars)
            e.parentElement.style.setProperty(
              k,
              k === '--tw-numeric-spacing'
                ? 'proportional-nums'
                : k === '--tw-font-weight'
                  ? '200'
                  : k === '--tw-leading'
                    ? '2.2'
                    : k === '--tw-tracking'
                      ? '.12em'
                      : 'initial'
            );
          for (const k of [...privateVars, ...Object.keys(aliases)])
            e.style.setProperty(k, 'inherit');
        }
      }
      if (mode === 'numeric-parts') {
        for (const x of list.filter((x) => x.tokens.includes('tabular-nums'))) {
          const e = node(x);
          for (const [k, val] of Object.entries({
            '--tw-ordinal': 'ordinal',
            '--tw-slashed-zero': 'slashed-zero',
            '--tw-numeric-figure': 'lining-nums',
            '--tw-numeric-fraction': 'diagonal-fractions',
          }))
            e.style.setProperty(k, val);
        }
      }
      if (mode === 'ancestor-legacy') {
        for (const [k, val] of Object.entries({
          '--tw-ordinal': 'ordinal',
          '--tw-slashed-zero': 'slashed-zero',
          '--tw-numeric-figure': 'lining-nums',
          '--tw-numeric-spacing': 'proportional-nums',
          '--tw-numeric-fraction': 'diagonal-fractions',
          '--tw-font-weight': '200',
          '--tw-leading': '2.2',
          '--tw-tracking': '.12em',
        }))
          root.style.setProperty(k, val);
      }
    },
    { mode, list, privateVars, aliases }
  );
}
async function data(p) {
  return p.evaluate(
    ({ privateVars, aliases }) => {
      const root = document.querySelector('.crh-shell'),
        targets = window.__126TargetPaths.map((p) => p.reduce((e, i) => e.children[i], root)),
        nodes = [...new Set(targets.flatMap((e) => [e, ...e.querySelectorAll('*')]))],
        css = (e, p) => {
          const s = getComputedStyle(e, p);
          return Object.fromEntries(
            [...s].filter((k) => !k.startsWith('--')).map((k) => [k, s.getPropertyValue(k)])
          );
        },
        rect = (e) => {
          const b = e.getBoundingClientRect();
          return [b.x, b.y, b.width, b.height];
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
          custom: Object.fromEntries(
            [...privateVars, ...Object.keys(aliases)].map((k) => [
              k,
              getComputedStyle(e).getPropertyValue(k),
            ])
          ),
          flags: Object.fromEntries(
            ['hover', 'active', 'focus', 'focus-visible', 'focus-within'].map((k) => [
              k,
              e.matches(':' + k),
            ])
          ),
          attrs: Object.fromEntries(
            ['aria-label', 'title', 'data-state', 'aria-expanded'].map((k) => [
              k,
              e.getAttribute(k),
            ])
          ),
        })),
        geometry: [root, ...root.querySelectorAll('*')].map((e, i) => ({
          i,
          tag: e.tagName,
          rect: rect(e),
        })),
        state: {
          documentHasFocus: document.hasFocus(),
          activeElement: {
            tag: document.activeElement.tagName,
            aria: document.activeElement.getAttribute('aria-label'),
            value: document.activeElement.value ?? null,
          },
          rootFont: getComputedStyle(document.documentElement).fontSize,
          rootDir: root.dir,
          hover: matchMedia('(hover:hover)').matches,
          media48rem: matchMedia('(min-width:48rem)').matches,
          media64rem: matchMedia('(min-width:64rem)').matches,
        },
      };
    },
    { privateVars, aliases }
  );
}
async function stable(p, key) {
  let previous = '',
    n = 0,
    last,
    samples = [];
  for (let i = 0; i < 120; i++) {
    await p.evaluate(() => new Promise(requestAnimationFrame));
    last = await data(p);
    const animations = await p.evaluate(() =>
        document.getAnimations().map((x) => ({
          property: x.transitionProperty ?? null,
          pending: x.pending,
          state: x.playState,
          iterations: x.effect?.getTiming().iterations,
        }))
      ),
      finite = animations.every(
        (x) => x.iterations === Infinity || (!x.pending && x.state !== 'running')
      ),
      h = sha(Buffer.from(JSON.stringify(last)));
    n = finite && h === previous ? n + 1 : 0;
    previous = h;
    samples.push({ sample: i, sha256: h, finite, animations });
    if (n >= 3) return { value: last, samples };
  }
  await writeFile(
    path.join(out, key + '-unstable.json'),
    JSON.stringify({ last, samples }, null, 2) + '\n'
  );
  throw Error('FullFieldsNotQuiescentWithin120ActualFrames');
}
const scenarios = [
  {
    name: 'findings-old-ref',
    story: 'grouped-refactor',
    steps: [profile.states[prefix + 'grouped-refactor'][0]],
  },
  {
    name: 'overview-pr',
    story: 'overview-and-navigation-coverage',
    steps: profile.states[prefix + 'overview-and-navigation-coverage'],
  },
  {
    name: 'commits-expanded',
    story: 'commit-overflow-coverage',
    steps: [profile.states[prefix + 'commit-overflow-coverage'][0]],
  },
  {
    name: 'commit-tooltip',
    story: 'commit-overflow-coverage',
    steps: profile.states[prefix + 'commit-overflow-coverage'],
  },
  {
    name: 'context',
    story: 'context-block-coverage',
    steps: profile.states[prefix + 'context-block-coverage'],
  },
  {
    name: 'composer-thread',
    story: 'with-existing-comments',
    steps: [profile.states[prefix + 'with-existing-comments'][0]],
    fill: true,
  },
];
const cases = scenarios
  .flatMap((sc) =>
    ['default', 'scoped', 'initial', 'inherit'].map((mode) => ({ ...sc, mode, width: 1280 }))
  )
  .concat(
    scenarios.map((sc) => ({ ...sc, mode: 'default', width: 390 })),
    ['numeric-parts', 'ancestor-legacy'].map((mode) => ({ ...scenarios[0], mode, width: 1280 }))
  );
const browser = await chromium.launch({
  executablePath:
    '/Users/wibus/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell',
});
try {
  for (const sc of cases) {
    const key = sc.name + '-' + sc.width + '-' + sc.mode;
    if (arg.recover && !before.failures.some((x) => x.key === key)) continue;
    const context = await browser.newContext({
        viewport: { width: sc.width, height: 1000 },
        colorScheme: 'dark',
        reducedMotion: 'reduce',
        isMobile: sc.width === 390,
        hasTouch: sc.width === 390,
      }),
      p = await context.newPage();
    try {
      await p.goto(arg.storybook + '/iframe.html?id=' + prefix + sc.story + '&viewMode=story');
      await p.waitForFunction(
        () => document.querySelector('.crh-shell') && document.fonts.status === 'loaded'
      );
      await apply(p, profile.ready[prefix + sc.story]);
      for (const state of sc.steps) await apply(p, state.steps);
      if (sc.fill)
        await p
          .locator('.crh-panel textarea')
          .fill('Synthetic typography line one\n第二行 typography 0123456789.');
      const list = await paths(p, before?.entries.find((x) => x.key === key)?.targets);
      assert.ok(list.length, 'actualtypographytargets');
      await configure(p, sc.mode, list);
      if (sc.mode !== 'default') {
        const target =
          sc.name === 'composer-thread'
            ? '.crh-panel textarea'
            : sc.name === 'context'
              ? '.crh-context-body'
              : sc.name === 'findings-old-ref'
                ? '[aria-label="Review findings"]'
                : sc.name === 'commit-tooltip'
                  ? '[role="tooltip"]'
                  : sc.name === 'commits-expanded'
                    ? '[data-group-id="group-1"]'
                    : '[aria-label="Review summary"]';
        await p
          .locator(target)
          .first()
          .evaluate((e) => e.scrollIntoView({ block: 'center', behavior: 'instant' }));
      }
      const primeKeys =
        before?.primingKeys ?? (arg.recover ? before.failures.map((x) => x.key) : []);
      if (primeKeys.includes(key)) {
        const pre = await data(p),
          shot = 'shots/' + key + '-primer.png';
        await p.screenshot({ path: path.join(out, shot), animations: 'allow', caret: 'initial' });
        const post = await data(p),
          raw = key + '-primer-prepost.json';
        await writeFile(
          path.join(out, raw),
          JSON.stringify(
            {
              pre,
              post,
              strictPrePostEqual: JSON.stringify(pre) === JSON.stringify(post),
              accepted: false,
              reason:
                'One real primer for bounded readiness calibration; original failure preserved.',
            },
            null,
            2
          ) + '\n'
        );
        primers.push({
          key,
          shot,
          raw,
          sha256: sha(await readFile(path.join(out, shot))),
          accepted: false,
        });
        await save();
      }
      const pre = await stable(p, key),
        shot = 'shots/' + key + '.png';
      await p.screenshot({ path: path.join(out, shot), animations: 'allow', caret: 'initial' });
      const post = await data(p),
        same = JSON.stringify(pre.value) === JSON.stringify(post),
        raw = key + '-prepost.json';
      await writeFile(
        path.join(out, raw),
        JSON.stringify(
          { pre: pre.value, post, samples: pre.samples, strictPrePostEqual: same },
          null,
          2
        ) + '\n'
      );
      if (!same) throw Error('StrictPrePostChanged');
      entries.push({
        key,
        scenario: sc.name,
        mode: sc.mode,
        width: sc.width,
        story: sc.story,
        targets: list,
        shot,
        sha256: sha(await readFile(path.join(out, shot))),
        raw,
        records: post.records.length,
        geometry: post.geometry.length,
        strictPrePostEqual: same,
      });
      await save();
      console.log(key, list.length, post.records.length);
    } catch (e) {
      const shot = 'shots/' + key + '-error.png';
      await p
        .screenshot({ path: path.join(out, shot), animations: 'allow', caret: 'initial' })
        .catch(() => {});
      failures.push({ key, message: String(e), shot });
      await save();
      console.log('FAIL', key, String(e));
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
  closedNormally = true;
  await save();
}
console.log({ entries: entries.length, failures: failures.length });
if (failures.length) process.exitCode = 1;
