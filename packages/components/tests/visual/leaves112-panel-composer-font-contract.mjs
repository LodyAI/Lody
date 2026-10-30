import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
const { values } = parseArgs({
  options: {
    phase: { type: 'string' },
    storybook: { type: 'string' },
    'build-proof': { type: 'string' },
  },
});
for (const key of ['phase', 'storybook', 'build-proof'])
  assert.ok(values[key], `--${key} required`);
assert.match(values.phase, /^leaves112-[a-z0-9-]+$/);
const v = path.resolve('artifacts/visual'),
  sha = (b) => createHash('sha256').update(b).digest('hex'),
  profileFile = path.resolve('tests/visual/leaves112-panel-composer-font-targets.json'),
  profileBytes = await readFile(profileFile),
  profile = JSON.parse(profileBytes),
  buildFile = path.resolve(values['build-proof']),
  buildBytes = await readFile(buildFile),
  build = JSON.parse(buildBytes),
  phase = values.phase,
  url = values.storybook,
  out = path.join(v, phase);
assert.ok(build.success);
assert.deepEqual(build.actualBuildExitCodes, { storybook: 0, standalone: 0 });
assert.deepEqual(build.postBuildDifferences, []);
for (const file of ['index.json', 'iframe.html'])
  assert.equal(
    sha(Buffer.from(await (await fetch(url + '/' + file)).arrayBuffer())),
    sha(await readFile(path.join(build.outputs.storybook, file)))
  );
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' }),
  entries = [],
  failures = [],
  modes = profile.cases.map((c) => c.key),
  source = build.rows.find(
    (r) => r.file === 'packages/code-review-helper/src/react/ReviewRenderer.tsx'
  );
assert.ok(source);
let closedNormally = false;
async function writeCheckpoint() {
  const proof = {
    phase,
    storybook: url,
    scope: profile.scope,
    source,
    buildProof: { file: values['build-proof'], sha256: sha(buildBytes) },
    profile: {
      file: 'tests/visual/leaves112-panel-composer-font-targets.json',
      sha256: sha(profileBytes),
    },
    entries,
    failures,
    closedNormally,
    positiveFrames: entries.filter((r) => r.mode !== 'element-private-negative').length,
    negativeFrames: entries.filter((r) => r.mode === 'element-private-negative').length,
    newPrivateWriterBoundary: profile.newPrivateWriterBoundary,
    noLegacyOPENsClosed: true,
  };
  await writeFile(path.join(out, 'proof.json'), JSON.stringify(proof, null, 2) + '\n');
}
await writeCheckpoint();
try {
  for (const width of profile.widths) {
    const context = await browser.newContext({
        viewport: { width, height: 900 },
        deviceScaleFactor: 1,
        reducedMotion: 'reduce',
      }),
      page = await context.newPage(),
      errors = [];
    page.setDefaultTimeout(10000);
    page.on('pageerror', (e) => errors.push(String(e)));
    try {
      await page.goto(
        url +
          '/iframe.html?id=code-review-helper-reviewrenderer--with-existing-comments&viewMode=story'
      );
      await page
        .getByRole('button', { name: /^Add a review comment to / })
        .first()
        .click();
      const field = page.getByRole('textbox', { name: /Comment on/ });
      await field.fill('Font contract: Interface 界面 fallback 0123 Ag');
      await page.evaluate(() => document.fonts.ready);
      for (const mode of modes) {
        await field.evaluate((el, controlCase) => {
          const parent = el.parentElement;
          for (const n of [el, parent, document.documentElement])
            for (const k of [
              '--font-sans',
              '--default-font-family',
              '--crh-composer-font-literal',
              '--tw-leading',
            ])
              n.style.removeProperty(k);
          const set = (n, k, value) => n.style.setProperty(k, value);
          if (controlCase === 'root-font-sans')
            set(document.documentElement, '--font-sans', 'monospace');
          if (controlCase === 'ancestor-font-sans') {
            set(parent, '--font-sans', 'fantasy');
            set(parent, '--default-font-family', 'cursive');
          }
          if (controlCase === 'element-font-sans') set(el, '--font-sans', 'cursive');
          if (controlCase === 'element-default-font') set(el, '--default-font-family', 'serif');
          if (controlCase === 'ancestor-private-variable')
            set(parent, '--crh-composer-font-literal', 'fantasy');
          if (controlCase === 'element-leading') set(el, '--tw-leading', '2rem');
          if (controlCase === 'element-private-negative')
            set(el, '--crh-composer-font-literal', 'fantasy');
        }, mode);
        await field.scrollIntoViewIfNeeded();
        await page.evaluate(
          () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
        );
        const record = () =>
          field.evaluate((el) => {
            const read = (p) => {
                const s = getComputedStyle(el, p);
                return Object.fromEntries(
                  [...s].filter((k) => !k.startsWith('--')).map((k) => [k, s.getPropertyValue(k)])
                );
              },
              r = el.getBoundingClientRect(),
              s = getComputedStyle(el);
            return {
              css: read(null),
              placeholder: read('::placeholder'),
              rect: [r.x, r.y, r.width, r.height],
              client: [el.clientWidth, el.clientHeight, el.scrollWidth, el.scrollHeight],
              value: el.value,
              legacyVariables: Object.fromEntries(
                ['--font-sans', '--default-font-family', '--tw-leading'].map((k) => [
                  k,
                  s.getPropertyValue(k),
                ])
              ),
              privateFixedValue: s.getPropertyValue('--crh-composer-font-literal'),
              visible:
                r.width > 0 &&
                r.height > 0 &&
                r.x < innerWidth &&
                r.right > 0 &&
                r.y < innerHeight &&
                r.bottom > 0,
            };
          });
        const pre = await record();
        assert.ok(pre.visible);
        assert.match(pre.css['color-scheme'], /dark/);
        const dir = path.join(v, phase);
        await mkdir(dir, { recursive: true });
        const shot = path.join(dir, `${width}-${mode}.png`);
        await page.screenshot({ path: shot, caret: 'hide' });
        const post = await record();
        assert.deepEqual(post, pre);
        entries.push({
          phase,
          width,
          mode,
          kind: 'font',
          shot: path.relative(v, shot),
          sha256: sha(await readFile(shot)),
          record: post,
          strictPrePostEqual: true,
        });
        await writeCheckpoint();
      }
      await field.evaluate((el) => {
        for (const n of [el, el.parentElement, document.documentElement])
          for (const k of [
            '--font-sans',
            '--default-font-family',
            '--crh-composer-font-literal',
            '--tw-leading',
          ])
            n.style.removeProperty(k);
      });
      const panel = page.getByRole('complementary', { name: 'Review comments' }),
        add = page.getByRole('button', { name: /^Add a review comment to / }).first();
      async function captureFlow(mode) {
        await panel.scrollIntoViewIfNeeded();
        await page.evaluate(
          () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
        );
        const read = () =>
          panel.evaluate((el) => {
            const nodes = [el, ...el.querySelectorAll('button,textarea,[data-thread-path]')];
            return {
              text: el.textContent,
              records: nodes.map((n) => {
                const s = getComputedStyle(n),
                  r = n.getBoundingClientRect();
                return {
                  tag: n.tagName,
                  role: n.getAttribute('role'),
                  label: n.getAttribute('aria-label'),
                  text: n.textContent,
                  value: n.value ?? null,
                  css: Object.fromEntries(
                    [...s].filter((k) => !k.startsWith('--')).map((k) => [k, s.getPropertyValue(k)])
                  ),
                  rect: [r.x, r.y, r.width, r.height],
                };
              }),
            };
          });
        const pre = await read(),
          shot = path.join(out, `${width}-${mode}.png`);
        await page.screenshot({ path: shot, caret: 'hide' });
        const post = await read();
        assert.deepEqual(post, pre);
        entries.push({
          phase,
          width,
          mode,
          kind: 'interaction',
          shot: path.relative(v, shot),
          sha256: sha(await readFile(shot)),
          record: post,
          strictPrePostEqual: true,
        });
        await writeCheckpoint();
      }
      const saved = '112 font leaf CtrlEnter saved 界面';
      await field.fill(saved);
      await field.press('Control+Enter');
      await field.waitFor({ state: 'detached' });
      await panel.getByText(saved, { exact: true }).waitFor();
      await captureFlow('flow-CtrlEnter-save');
      await add.click();
      await field.fill('112 font leaf Escape cancelled');
      await field.press('Escape');
      await field.waitFor({ state: 'detached' });
      assert.equal(
        await panel.getByText('112 font leaf Escape cancelled', { exact: true }).count(),
        0
      );
      await captureFlow('flow-Escape-cancel');
      await add.click();
      assert.equal(await field.inputValue(), '');
      await field.fill('112 font leaf button cancelled');
      await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
      await field.waitFor({ state: 'detached' });
      assert.equal(
        await panel.getByText('112 font leaf button cancelled', { exact: true }).count(),
        0
      );
      await captureFlow('flow-button-cancel');
      await add.click();
      assert.equal(await field.inputValue(), '');
      const clicked = '112 font leaf button saved 界面';
      await field.fill(clicked);
      await panel.getByRole('button', { name: 'Save comment', exact: true }).click();
      await field.waitFor({ state: 'detached' });
      await panel.getByText(clicked, { exact: true }).waitFor();
      await captureFlow('flow-button-save');
    } catch (e) {
      const failure = { phase, width, error: e.stack };
      try {
        const shot = path.join(out, `${width}-failure.png`);
        await page.screenshot({ path: shot, caret: 'hide', timeout: 10000 });
        failure.shot = path.relative(v, shot);
        failure.sha256 = sha(await readFile(shot));
        const dom = path.join(out, `${width}-failure.html`);
        await writeFile(dom, await page.content());
        failure.dom = path.relative(v, dom);
      } catch (captureError) {
        failure.captureError = String(captureError);
      }
      failures.push(failure);
      await writeCheckpoint();
    } finally {
      await context.close();
      if (errors.length) failures.push({ phase, width, pageErrors: errors });
      await writeCheckpoint();
    }
  }
  await browser.close();
  closedNormally = true;
} finally {
  if (!closedNormally) await browser.close();
}
await writeCheckpoint();
console.log({ phase, entries: entries.length, failures, closedNormally });
assert.deepEqual(failures, []);
assert.equal(
  entries.length,
  profile.widths.length * (profile.cases.length + profile.interactionStates.length)
);
