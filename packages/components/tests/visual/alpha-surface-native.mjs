/** Real /90 leaves, with a separately labelled historical declaration control. */
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((s, i, a) => (s.startsWith('--') ? [[s.slice(2), a[i + 1]]] : []))
);
if (!args.phase || !args.storybook) throw Error('--phase and --storybook required');
const root = fileURLToPath(new URL('../../', import.meta.url));
const hash = (b) => createHash('sha256').update(b).digest('hex');
const expression = 'color-mix(in oklab, hsl(var(--foreground) / 1) 90%, transparent)';
const iframe = await (await fetch(new URL('/iframe.html', args.storybook))).text();
if (iframe.includes('/@vite/client')) throw Error('Immutable production Storybook required');
const index = await (await fetch(new URL('/index.json', args.storybook))).json();
const harnessFingerprint = hash(await readFile(fileURLToPath(import.meta.url)));
const scenes = [
  'notice',
  'long-notice',
  'notice-caller-overrides',
  'read-completed',
  'read-failed',
  'read-running',
  'execute-completed',
];
const phases = [
  args.phase,
  ...(args.reference === 'yes' ? [args.phase + '-restored-reference'] : []),
];
const records = Object.fromEntries(
  phases.map((p) => [p, { entries: [], failures: [], controls: [] }])
);
for (const p of phases)
  await mkdir(path.join(root, 'artifacts/visual', p, 'shots'), { recursive: true });
let browser;
try {
  browser = await chromium.launch();
} catch {
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const installed = (await readdir(cache))
    .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
    .sort((a, b) => Number(b.split('-').at(-1)) - Number(a.split('-').at(-1)));
  if (!installed.length) throw Error('Installed Chromium required');
  browser = await chromium.launch({
    executablePath: path.join(
      cache,
      installed[0],
      'chrome-headless-shell-mac-arm64/chrome-headless-shell'
    ),
  });
}
const targetInfo = (word) => {
  const notice = document.querySelector('[data-alpha-notice]');
  const leaves = notice
    ? [...notice.querySelectorAll('span[title]')]
    : [...document.querySelectorAll('[data-alpha-tools] span')].filter(
        (e) => !e.children.length && e.textContent === word
      );
  if (leaves.length !== 1)
    throw Error('Exactly one actual alpha leaf required, found ' + leaves.length);
  const target = leaves[0],
    r = target.getBoundingClientRect(),
    s = getComputedStyle(target);
  if (!(r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight))
    throw Error('Actual alpha leaf must be visible');
  return {
    text: target.textContent,
    title: target.getAttribute('title'),
    rect: [r.x, r.y, r.width, r.height],
    inline: target.getAttribute('style'),
    color: s.color,
    fontFamily: s.fontFamily,
    fontSize: s.fontSize,
    fontWeight: s.fontWeight,
    lineHeight: s.lineHeight,
    opacity: s.opacity,
    className: target.className,
    pseudoDisplay: getComputedStyle(target, '::after').display,
  };
};
const snapshot = () => {
  const host = document.querySelector('[data-alpha-notice], [data-alpha-tools]');
  return [host, ...host.querySelectorAll('*')].map((e, i) => {
    const s = getComputedStyle(e),
      r = e.getBoundingClientRect();
    return {
      path: 'fixture>' + i,
      tag: e.tagName.toLowerCase(),
      rect: [r.x, r.y, r.width, r.height],
      ...Object.fromEntries(
        [
          'color',
          'backgroundColor',
          'fontFamily',
          'fontSize',
          'fontWeight',
          'lineHeight',
          'letterSpacing',
          'borderRadius',
          'borderColor',
          'borderWidth',
          'boxShadow',
          'paddingTop',
          'paddingBottom',
          'paddingLeft',
          'paddingRight',
          'overflowX',
          'overflowY',
          'opacity',
          'display',
        ].map((k) => [k, s[k]])
      ),
    };
  });
};
const settle = async (p) => {
  await p.evaluate(() => document.fonts.ready);
  await p.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {}))
    )
  );
  await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
};
for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'compact-desktop', width: 390, height: 844 },
])
  for (const theme of ['light', 'dark'])
    for (const scene of scenes) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();
      const storyId = 'migration-alphasurfaces--' + scene;
      const key = `${storyId}__${viewport.name}__${theme}__visible-alpha`;
      const word =
        scene === 'execute-completed' ? 'Ran' : scene === 'read-running' ? 'Reading' : 'Read';
      try {
        await page.clock.setFixedTime(new Date('2026-10-22T09:00:00Z'));
        const url = new URL('/iframe.html', args.storybook);
        url.search = new URLSearchParams({
          id: storyId,
          viewMode: 'story',
          globals: `theme:${theme};locale:en`,
        });
        await page.goto(url.href);
        if (scene.includes('notice'))
          await page.locator('[data-alpha-notice] span[title]').waitFor({ state: 'visible' });
        else {
          await page.locator('[data-alpha-tools] button[aria-expanded="false"]').first().click();
          await page
            .locator(`[data-alpha-tools] span:not(:has(*)):text-is("${word}")`)
            .waitFor({ state: 'visible' });
        }
        await settle(page);
        const original = await page.evaluate(targetInfo, word);
        for (const phase of phases) {
          const restored = phase !== args.phase;
          if (restored)
            await page.evaluate(
              ({ word: expectedWord, expression: originalDeclaration }) => {
                const notice = document.querySelector('[data-alpha-notice]');
                const target = notice
                  ? notice.querySelector('span[title]')
                  : [...document.querySelectorAll('[data-alpha-tools] span')].find(
                      (e) => !e.children.length && e.textContent === expectedWord
                    );
                target.style.setProperty('color', originalDeclaration);
              },
              { word, expression }
            );
          await settle(page);
          const target = await page.evaluate(targetInfo, word);
          const shot = 'shots/' + key + '.png';
          const buffer = await page.screenshot({
            path: path.join(root, 'artifacts/visual', phase, shot),
            caret: 'hide',
            animations: 'disabled',
          });
          records[phase].entries.push({
            key,
            storyId,
            title: 'Migration/AlphaSurfaces',
            state: 'visible-alpha',
            viewport: viewport.name,
            theme,
            shot,
            sha256: hash(buffer),
            layout: await page.evaluate(snapshot),
          });
          records[phase].controls.push({
            key,
            storyId,
            theme,
            viewport,
            original,
            target,
            restoredDeclaration: restored ? expression : null,
            referenceMeaning: restored
              ? 'Current production UI with only the selected visible leaf color restored to locked HEAD utility output; not a whole HEAD build.'
              : 'Unmodified production UI; no injected declaration.',
          });
        }
      } catch (error) {
        for (const phase of phases)
          records[phase].failures.push({ key, message: String(error.stack ?? error) });
        console.error(key, error.message);
      } finally {
        await context.close();
      }
    }
await browser.close();
for (const phase of phases) {
  const out = path.join(root, 'artifacts/visual', phase),
    rec = records[phase];
  await writeFile(
    path.join(out, 'manifest.json'),
    JSON.stringify(
      {
        phase,
        baseUrl: args.storybook,
        buildFingerprint: hash(iframe + JSON.stringify(index)),
        harnessFingerprint,
        expected: 28,
        targets: {
          scenes,
          clock: '2026-10-22T09:00:00Z',
          referenceOnlySelectedColor: phase !== args.phase,
        },
        entries: rec.entries,
      },
      null,
      2
    )
  );
  await writeFile(path.join(out, 'controls.json'), JSON.stringify(rec.controls, null, 2));
  await writeFile(path.join(out, 'failures.json'), JSON.stringify(rec.failures, null, 2));
  console.log(`${phase}: ${rec.entries.length}/28 frames; ${rec.failures.length} failures`);
  if (rec.failures.length) process.exitCode = 1;
}
