/** Real TaskList geometry, caller precedence and gestures complement the primary PNG matrix. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from '@playwright/test';
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .flatMap((arg, i, all) => (arg.startsWith('--') ? [[arg.slice(2), all[i + 1]]] : []))
);
if (!args.phase || !args.storybook) throw new Error('--phase and --storybook required');
const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(pkg, 'artifacts/visual', args.phase);
const profile = JSON.parse(await readFile(new URL('./legacy-task-targets.json', import.meta.url)));
const iframe = await (await fetch(new URL('/iframe.html', args.storybook))).text();
assert.ok(!iframe.includes('/@vite/client'), 'Immutable build required');
const hash = (value) => createHash('sha256').update(value).digest('hex');
await mkdir(path.join(out, 'shots'), { recursive: true });
const browser = await (async () => {
  try {
    return await chromium.launch();
  } catch (error) {
    const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
    if (!existsSync(cache)) throw error;
    const candidates = (await readdir(cache))
      .flatMap((entry) => {
        const match = /^chromium_headless_shell-(\d+)$/.exec(entry);
        const executable = path.join(
          cache,
          entry,
          'chrome-headless-shell-mac-arm64/chrome-headless-shell'
        );
        return match && existsSync(executable) ? [{ executable, revision: Number(match[1]) }] : [];
      })
      .sort((a, b) => b.revision - a.revision);
    if (!candidates.length) throw error;
    return chromium.launch({ executablePath: candidates[0].executable });
  }
})();
const entries = [],
  failures = [];
const settle = async (page) => {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .filter((a) => a.effect?.getTiming().iterations !== Infinity)
      .every((a) => a.playState !== 'running')
  );
  await page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
};
const inspect = () =>
  [...document.querySelectorAll('#storybook-root *,[role=menu] *')].map((node) => {
    const r = node.getBoundingClientRect(),
      css = getComputedStyle(node);
    return {
      tag: node.tagName,
      row: node.getAttribute('data-sidebar-session-id'),
      text: node.childElementCount ? '' : node.textContent,
      rect: [r.x, r.y, r.width, r.height],
      current: node.getAttribute('aria-current'),
      active: node === document.activeElement,
      input: node instanceof HTMLInputElement ? node.value : null,
      styles: Object.fromEntries(
        [
          'display',
          'position',
          'zIndex',
          'width',
          'height',
          'minWidth',
          'maxWidth',
          'flex',
          'flexDirection',
          'alignItems',
          'justifyContent',
          'gap',
          'padding',
          'margin',
          'fontFamily',
          'fontSize',
          'lineHeight',
          'fontWeight',
          'fontVariantNumeric',
          'color',
          'backgroundColor',
          'borderWidth',
          'borderColor',
          'borderRadius',
          'whiteSpace',
          'overflow',
          'textOverflow',
          'pointerEvents',
          'opacity',
          'boxShadow',
          'outline',
          'cursor',
        ].map((key) => [key, css[key]])
      ),
    };
  });
async function steps(page, sequence = []) {
  for (const s of sequence) {
    if (s.action === 'movePointer') {
      await page.mouse.move(s.x, s.y);
      continue;
    }
    const t = s.role
      ? page.getByRole(s.role, { name: s.name, exact: s.exact ?? true })
      : s.text
        ? page.getByText(s.text, { exact: s.exact ?? true })
        : page.locator(s.selector);
    const l = s.index === undefined ? t : t.nth(s.index);
    if (s.action === 'click') await l.click();
    else if (s.action === 'hover') await l.hover();
    else if (s.action === 'focus') await l.focus();
    else if (s.action === 'press') await l.press(s.key);
    else if (s.action === 'fill') await l.fill(s.value);
    else if (s.action === 'visible' || s.action === 'hidden') await l.waitFor({ state: s.action });
    else throw new Error(`Unknown step ${s.action}`);
  }
  await settle(page);
}
async function open(viewport, theme, story) {
  const context = await browser.newContext({
    ...devices[viewport.device],
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    colorScheme: theme,
    reducedMotion: 'reduce',
  });
  const seed = await context.newPage();
  await seed.clock.setFixedTime(new Date('2026-10-22T09:00:00Z'));
  await seed.close();
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setBlockedURLs', { urls: ['*://avatars.githubusercontent.com/*'] });
  await page.goto(
    new URL(
      `/iframe.html?id=${story}&viewMode=story&globals=theme:${theme};locale:en`,
      args.storybook
    ).href
  );
  await page.waitForFunction(
    () => window.__STORYBOOK_PREVIEW__?.currentRender?.phase === 'finished'
  );
  await page.waitForFunction(
    (dark) => document.documentElement.classList.contains('dark') === dark,
    theme === 'dark'
  );
  await page.locator('[data-legacy-task-fixture]').waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('#storybook-root img')].every((img) => img.complete)
  );
  await page.mouse.move(0, 0);
  await settle(page);
  return { page, context, errors, cdp };
}
async function shot(page, key, state, withPng = false) {
  await settle(page);
  const entry = { key: `${key}__${state}`, state, layout: await page.evaluate(inspect) };
  if (withPng) {
    entry.shot = `shots/${entry.key}.png`;
    await page.screenshot({
      path: path.join(out, entry.shot),
      fullPage: true,
      animations: 'disabled',
      caret: 'hide',
    });
  }
  entries.push(entry);
  console.log(entry.key);
}
try {
  for (const viewport of profile.viewports)
    for (const theme of profile.themes)
      for (const story of profile.ids) {
        const key = `${story}__${viewport.name}__${theme}`;
        let scope;
        try {
          scope = await open(viewport, theme, story);
          const { page } = scope;
          if (story.endsWith('caller-overrides')) {
            const css = await page
              .locator('[data-legacy-task-panel] > div:has([data-sidebar-group-key])')
              .evaluate((e) => {
                const s = getComputedStyle(e);
                return { gap: s.gap, padding: s.padding, width: s.width };
              });
            assert.deepEqual(css, { gap: '20px', padding: '12px', width: '280px' });
          }
          if (story.endsWith('loading-and-empty')) {
            assert.equal(
              await page
                .locator('[data-legacy-task-loading] [data-sidebar-loading-skeleton]')
                .count(),
              1
            );
            assert.equal(await page.locator('[data-legacy-task-empty] button').count(), 1);
            assert.equal(
              await page
                .locator('[data-legacy-task-no-action]')
                .evaluate((e) => e.childElementCount),
              0
            );
          }
          await shot(page, key, 'rest');
          for (const state of profile.states[story] ?? []) {
            await steps(page, state.steps);
            await shot(page, key, state.name);
          }
          assert.deepEqual(scope.errors, []);
        } catch (error) {
          failures.push({ key, error: error.stack ?? String(error) });
        } finally {
          await scope?.context.close();
        }
      }
  const viewports = [
    ...profile.viewports,
    { name: 'phone', width: 390, height: 844, device: 'iPhone 13' },
    { name: 'touch-below-boundary', width: 767, height: 900, device: 'iPhone 13' },
    { name: 'touch-at-boundary', width: 768, height: 900, device: 'iPhone 13' },
  ];
  for (const viewport of viewports)
    for (const theme of profile.themes) {
      const key = `gestures__${viewport.name}__${theme}`;
      let scope;
      try {
        scope = await open(
          viewport,
          theme,
          'components-legacy-task-list-migration--natural-device'
        );
        const { page, cdp } = scope;
        const row = page.locator('[data-sidebar-session-id="alpha-pinned"]');
        const mobile = Boolean(viewport.device && viewport.width < 768);
        assert.equal(
          await row.locator('button[aria-label="More actions"]').count(),
          mobile ? 0 : 1
        );
        await shot(page, key, 'device-rest', true);
        if (mobile) {
          const box = await row.boundingBox(),
            y = box.y + box.height / 2;
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [{ x: box.x + box.width - 12, y }],
          });
          for (const delta of [20, 45, 75])
            await cdp.send('Input.dispatchTouchEvent', {
              type: 'touchMove',
              touchPoints: [{ x: box.x + box.width - 12 - delta, y }],
            });
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          const archive = page
            .getByRole('button', { name: 'Archive session', exact: true })
            .first();
          await archive.waitFor();
          await shot(page, key, 'swipe-open', true);
          await archive.tap();
          await page.getByText('Archived alpha-pinned', { exact: true }).waitFor();
          await shot(page, key, 'swipe-archived', true);
        } else {
          const handle = page.locator(
            '[data-repo-full-name="migration-fixture/alpha-project"] button[aria-label="Reorder repo"]'
          );
          await handle.focus();
          await handle.press('Space');
          await page.waitForFunction(() =>
            document
              .querySelector('[data-repo-full-name="migration-fixture/alpha-project"]')
              .style.transform.includes('translate3d')
          );
          await settle(page);
          await handle.press('ArrowDown');
          await settle(page);
          const transforms = await page.locator('[data-repo-full-name]').evaluateAll((nodes) =>
            nodes.map((e) => ({
              repo: e.getAttribute('data-repo-full-name'),
              transform: e.style.transform,
            }))
          );
          for (const value of transforms)
            if (value.transform)
              assert.ok(
                value.transform.includes('translate3d(0px,') &&
                  value.transform.includes('scaleX(1)') &&
                  value.transform.includes('scaleY(1)'),
                JSON.stringify(value)
              );
          await shot(page, key, 'keyboard-dragging', true);
          await handle.press('Escape');
          await page.waitForFunction(
            () =>
              document.querySelector('[data-repo-full-name="migration-fixture/alpha-project"]')
                .style.transform === ''
          );
          await shot(page, key, 'keyboard-cancelled', true);
          const target = page.locator('[data-repo-full-name="migration-fixture/beta-project"]');
          if (viewport.device) {
            await shot(page, key, 'touch-desktop-hover-unavailable', true);
            continue;
          }
          await page.locator('[data-sidebar-group-key="migration-fixture/alpha-project"]').hover();
          await handle.hover();
          const from = await handle.boundingBox(),
            to = await target.boundingBox();
          await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
          await page.mouse.down();
          await page.mouse.move(from.x + from.width / 2, to.y + to.height / 2 + 100, { steps: 12 });
          await page.waitForFunction(() =>
            document.querySelector('[role=status]')?.textContent.includes('beta-project')
          );
          await page.mouse.up();
          await page
            .getByText('Moved migration-fixture/alpha-project to 1', { exact: true })
            .waitFor();
          assert.equal(
            await page.locator('[data-repo-full-name]').first().getAttribute('data-repo-full-name'),
            'migration-fixture/beta-project'
          );
          await shot(page, key, 'pointer-reordered', true);
          if (viewport.name === 'desktop') {
            await page.emulateMedia({ forcedColors: 'active' });
            await row.click({ button: 'right' });
            await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
            await row.locator('input').waitFor();
            assert.equal(
              await row.locator('input').evaluate((node) => getComputedStyle(node).outlineWidth),
              '2px'
            );
            await shot(page, key, 'forced-colors-rename', true);
          }
        }
        assert.deepEqual(scope.errors, []);
      } catch (error) {
        failures.push({ key, error: error.stack ?? String(error) });
      } finally {
        await scope?.context.close();
      }
    }
} finally {
  await writeFile(
    path.join(out, 'pre-cleanup.json'),
    JSON.stringify({ entries, failures }, null, 2)
  );
  await browser.close();
}
await writeFile(
  path.join(out, 'proof.json'),
  JSON.stringify(
    {
      kind: 'Real TaskList primary-state computed contracts plus touch/keyboard gesture screenshots',
      harnessFingerprint: hash(await readFile(fileURLToPath(import.meta.url))),
      profileFingerprint: hash(JSON.stringify(profile)),
      buildFingerprint: hash(iframe),
      entries,
      failures,
    },
    null,
    2
  ) + '\n'
);
console.log(JSON.stringify({ output: out, entries: entries.length, failures }, null, 2));
if (failures.length) process.exitCode = 1;
