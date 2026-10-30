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
  failures = [],
  sha = (b) => createHash('sha256').update(b).digest('hex');
await mkdir(path.join(out, 'shots'), { recursive: true });
let closedNormally = false;
const modes = [
  'explicit',
  'zero',
  'initial',
  'inherit',
  'unset',
  'revert',
  'revertLayer',
  'fallback',
  'omitted',
];
const variables = [
  '--spacing',
  '--foreground',
  '--muted-foreground',
  '--background',
  '--primary',
  '--primary-foreground',
  '--tw-ring-color',
  '--tw-ring-shadow',
  '--tw-duration',
  '--tw-ease',
];
async function save() {
  await writeFile(
    path.join(out, 'proof.json'),
    JSON.stringify(
      {
        phase: args.phase,
        storybook: args.storybook,
        modes,
        variables,
        entries,
        failures,
        closedNormally,
        scope:
          'Real original Button physical-style reference vs opt-in physical API; no replacement primitives. CSS-wide/raw declared values distinct from actual used box (zero can retain paddingminimum). Actual Slot callbacks/ref/childinline priority, caller style, updates,focus/hover/press/disabled. All fields retained.',
      },
      null,
      2
    ) + '\n'
  );
}
async function data(p) {
  return p.evaluate((variables) => {
    const root = document.querySelector('[data-physical-field-fixture]'),
      nodes = [root, ...root.querySelectorAll('*')];
    const css = (e, ps) => {
      const c = getComputedStyle(e, ps);
      return Object.fromEntries(
        [...c].filter((k) => !k.startsWith('--')).map((k) => [k, c.getPropertyValue(k)])
      );
    };
    return {
      records: nodes.map((e, i) => {
        const r = e.getBoundingClientRect();
        return {
          i,
          tag: e.tagName,
          text: e.childElementCount ? null : e.textContent,
          rect: [r.x, r.y, r.width, r.height],
          css: css(e),
          before: css(e, '::before'),
          after: css(e, '::after'),
          custom: Object.fromEntries(
            variables.map((k) => [k, getComputedStyle(e).getPropertyValue(k)])
          ),
          attrs: Object.fromEntries(
            e
              .getAttributeNames()
              .filter((k) => k !== 'class')
              .map((k) => [k, e.getAttribute(k)])
          ),
          pseudos: Object.fromEntries(
            ['hover', 'active', 'focus', 'focus-visible', 'disabled'].map((k) => [
              k,
              e.matches(':' + k),
            ])
          ),
          checked: e.checked ?? null,
          indeterminate: e.indeterminate ?? null,
          inline: { width: e.style.width, height: e.style.height, color: e.style.color },
        };
      }),
      state: {
        mode: root.dataset.mode,
        calls: root.querySelector('[data-field-calls]').textContent,
        refs: root.querySelector('[data-field-refs]').textContent,
        active:
          document.activeElement?.getAttribute('data-field-case') ??
          document.activeElement?.getAttribute('data-set-fields') ??
          document.activeElement?.tagName,
        hasFocus: document.hasFocus(),
        font: getComputedStyle(document.documentElement).fontSize,
        hoverMedia: matchMedia('(hover:hover)').matches,
        openTooltips: [...document.querySelectorAll('[role=tooltip]')]
          .filter((e) => e.getBoundingClientRect().height > 0)
          .map((e) => e.textContent),
      },
    };
  }, variables);
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
  throw Error('Fullfieldsfailedtostabilizewithin12doubleRAFchecks');
}
async function capture(p, key, meta = {}) {
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
  assert.ok(same, 'fullfieldsstrictprepost');
  entries.push({
    key,
    ...meta,
    shot,
    sha256: sha(await readFile(path.join(out, shot))),
    raw,
    records: post.records.length,
    strictPrePostEqual: true,
    sourceClassCarriers: await p
      .locator('[data-physical-field-fixture],[data-physical-field-fixture] *')
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
    for (const env of ['default', 'scoped']) {
      const c = await browser.newContext({
          viewport: { width, height: 1000 },
          colorScheme: 'dark',
          reducedMotion: 'no-preference',
        }),
        p = await c.newPage(),
        key = width + '-' + env;
      try {
        await p.goto(
          args.storybook +
            '/iframe.html?id=code-review-helper-buttontogglemigration--button-physical-fields&viewMode=story'
        );
        await p.waitForFunction(
          () =>
            document.querySelector('[data-field-refs]')?.textContent === 'BUTTON/A' &&
            document.fonts.status === 'loaded'
        );
        if (env === 'scoped')
          await p.locator('[data-button-toggle-migration]').evaluate((e) => {
            for (const [k, v] of Object.entries({
              '--spacing': '5px',
              '--foreground': '185 65% 77%',
              '--muted-foreground': '340 60% 65%',
              '--primary': '220 50% 35%',
              '--primary-foreground': '33 85% 85%',
              '--tw-duration': '71ms',
              '--tw-ease': 'linear',
            }))
              e.style.setProperty(k, v);
            e.dir = 'rtl';
            document.documentElement.style.fontSize = '20px';
          });
        for (const mode of modes) {
          await p.locator('[data-set-fields="' + mode + '"]').click();
          await p.waitForFunction(
            (mode) => document.querySelector('[data-physical-field-fixture]').dataset.mode === mode,
            mode
          );
          await p.mouse.move(-10, -10);
          await capture(p, key + '-' + mode, { width, env, mode });
        }
        await p.locator('[data-set-fields=explicit]').click();
        const native = p.locator('[data-field-case=native]'),
          slot = p.locator('[data-field-case=slot]');
        await native.hover();
        await capture(p, key + '-native-hover', { width, env, state: 'hover' });
        await native.focus();
        await p.keyboard.press('Tab');
        await p.keyboard.press('Shift+Tab');
        await p.mouse.move(-10, -10);
        await capture(p, key + '-native-focus', { width, env, state: 'realkeyboardfocus' });
        await native.hover();
        await p.mouse.down();
        await capture(p, key + '-native-pressed', { width, env, state: 'realpointerdown' });
        await p.mouse.up();
        await p.waitForFunction(
          () => document.querySelector('[data-field-calls]').textContent === '1/0/0'
        );
        await slot.click();
        await p.waitForFunction(
          () => document.querySelector('[data-field-calls]').textContent === '1/1/1'
        );
        await p.mouse.move(-10, -10);
        await capture(p, key + '-slot-callbacks', {
          width,
          env,
          state: 'Slotparentandchildbothactualcallback/ref',
        });
        assert.equal(await p.locator('[data-field-refs]').innerText(), 'BUTTON/A');
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
