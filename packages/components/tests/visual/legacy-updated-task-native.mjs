import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .flatMap((arg, i, all) => (arg.startsWith('--') ? [[arg.slice(2), all[i + 1]]] : []))
);
if (!args.phase || !args.storybook) throw new Error('--phase and --storybook required');
const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(pkg, 'artifacts/visual', args.phase);
await mkdir(path.join(out, 'shots'), { recursive: true });
const iframe = await (await fetch(new URL('/iframe.html', args.storybook))).text();
if (iframe.includes('/@vite/client')) throw new Error('Immutable Storybook build required');
const index = await (await fetch(new URL('/index.json', args.storybook))).text();
const fingerprint = createHash('sha256').update(iframe).update(index).digest('hex');
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
const scopes = {
  '--spacing': '0.3125rem',
  '--radius-md': '11px',
  '--radius-sm': '5px',
  '--font-weight-normal': '450',
  '--text-sm': '15px',
  '--text-sm--line-height': '22px',
  '--sidebar-row-foreground': '245 42% 42%',
  '--sidebar-foreground-muted': '285 36% 44%',
  '--sidebar-hover': '165 28% 84%',
  '--sidebar-hover-foreground': '165 52% 25%',
  '--sidebar-selection': '212 44% 40%',
  '--sidebar-selection-foreground': '0 0% 98%',
  '--sidebar-ring': '310 62% 45%',
};
const inspect = () => {
  const properties = [
    'display',
    'position',
    'inset',
    'top',
    'right',
    'bottom',
    'left',
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
    'margin',
    'padding',
    'borderWidth',
    'borderStyle',
    'borderColor',
    'borderRadius',
    'boxSizing',
    'color',
    'backgroundColor',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'lineHeight',
    'fontVariantNumeric',
    'whiteSpace',
    'textOverflow',
    'overflow',
    'opacity',
    'pointerEvents',
    'cursor',
    'outline',
    'outlineOffset',
    'boxShadow',
    'transform',
    'transitionProperty',
    'transitionDuration',
    'transitionTimingFunction',
  ];
  return [...document.body.querySelectorAll('*')]
    .filter((e) => !['SCRIPT', 'STYLE', 'LINK'].includes(e.tagName))
    .map((e, i) => {
      const r = e.getBoundingClientRect(),
        s = getComputedStyle(e),
        before = getComputedStyle(e, '::before'),
        after = getComputedStyle(e, '::after');
      return {
        path: String(i),
        tag: e.tagName,
        text: e.textContent?.trim().slice(0, 160),
        label: e.getAttribute('aria-label'),
        role: e.getAttribute('role'),
        current: e.getAttribute('aria-current'),
        rect: [r.x, r.y, r.width, r.height],
        styles: Object.fromEntries(properties.map((p) => [p, s[p]])),
        pseudo: {
          before: { content: before.content, color: before.color, shadow: before.boxShadow },
          after: { content: after.content, color: after.color, shadow: after.boxShadow },
        },
        active: document.activeElement === e,
        focusVisible: e.matches(':focus-visible'),
        inputValue: e instanceof HTMLInputElement ? e.value : null,
      };
    });
};
const settle = async (page) => {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
      .every((animation) => animation.playState !== 'running')
  );
  await page.evaluate(() => {
    delete window.__legacyStable;
  });
  await page.waitForFunction(() => {
    const value = JSON.stringify(
      [...document.querySelectorAll('[data-legacy-updated-fixture] *,[role="menu"]')].map((e) =>
        e.getBoundingClientRect().toJSON()
      )
    );
    const previous = window.__legacyStable ?? { value: '', count: 0 };
    previous.count = previous.value === value ? previous.count + 1 : 0;
    previous.value = value;
    window.__legacyStable = previous;
    return previous.count >= 3;
  });
};
try {
  for (const viewport of [
    { name: 'desktop', width: 1280, height: 1000 },
    { name: 'narrow', width: 320, height: 900 },
    { name: 'touch', width: 390, height: 1000 },
  ]) {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport,
        deviceScaleFactor: 1,
        reducedMotion: 'reduce',
        colorScheme: theme,
        hasTouch: viewport.name === 'touch',
      });
      const seed = await context.newPage();
      await seed.clock.setFixedTime(new Date('2026-10-22T09:00:00Z'));
      await seed.close();
      const scenarios =
        viewport.name === 'touch'
          ? ['mobile-rows']
          : [
              'interactions',
              'anchor-rows',
              ...(viewport.name === 'desktop'
                ? ['root-variables', 'scoped-variables', 'forced-colors']
                : []),
            ];
      for (const scenario of scenarios) {
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        const key = `${scenario}__${viewport.name}__${theme}`;
        const row = (id = 'long') => page.locator(`[data-sidebar-updated-id="${id}"]`);
        try {
          await page.addInitScript(() => {
            window.__legacyInputs = [];
            for (const type of [
              'pointerdown',
              'pointerup',
              'pointercancel',
              'keydown',
              'contextmenu',
            ])
              document.addEventListener(
                type,
                (e) =>
                  window.__legacyInputs.push({
                    type,
                    trusted: e.isTrusted,
                    pointerType: e.pointerType ?? null,
                    key: e.key ?? null,
                    button: e.button ?? null,
                  }),
                true
              );
          });
          const url = new URL('/iframe.html', args.storybook);
          url.search = new URLSearchParams({
            id: `components-legacyupdatedtasklistmigration--${scenario === 'root-variables' ? 'interactions' : scenario === 'forced-colors' ? 'anchor-rows' : scenario}`,
            viewMode: 'story',
            globals: `theme:${theme};locale:en`,
          });
          if (scenario === 'forced-colors') await page.emulateMedia({ forcedColors: 'active' });
          await page.goto(url.href);
          await page.locator('[data-legacy-updated-fixture]').waitFor();
          const shot = async (state, assertions = {}) => {
            await settle(page);
            const name = `${key}__${state}`;
            await page.screenshot({
              path: path.join(out, 'shots', `${name}.png`),
              animations: 'disabled',
              caret: 'hide',
            });
            entries.push({
              key: name,
              state,
              scenario,
              viewport: viewport.name,
              theme,
              shot: `shots/${name}.png`,
              assertions,
              layout: await page.evaluate(inspect),
              events: await page.evaluate(() => window.__legacyInputs),
            });
            console.log(name);
          };
          const rename = async () => {
            await row().click({ button: 'right' });
            await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
            await row().locator('input').waitFor();
          };
          if (scenario === 'forced-colors') {
            await page.keyboard.press('Tab');
            await row().locator('a').focus();
            assert.ok(
              await row()
                .locator('a')
                .evaluate((e) => e.matches(':focus-visible'))
            );
            assert.ok(await page.evaluate(() => matchMedia('(forced-colors: active)').matches));
            await shot('anchor-focus', { forcedColors: true, focusVisible: true });
            await rename();
            assert.ok(
              await row()
                .locator('input')
                .evaluate((e) => document.activeElement === e)
            );
            await shot('rename-input', { forcedColors: true, inputFocused: true });
          } else if (scenario === 'root-variables' || scenario === 'scoped-variables') {
            if (scenario === 'root-variables')
              await page.evaluate((values) => {
                for (const [name, value] of Object.entries(values))
                  document.documentElement.style.setProperty(name, value);
              }, scopes);
            await shot('rest');
            await row().hover();
            await shot('hover');
            await rename();
            await shot('rename');
            await row().locator('input').press('Escape');
            await row().hover();
            await row().getByRole('button', { name: 'Archive session', exact: true }).click();
            await row()
              .getByRole('button', { name: 'Confirm Archive session', exact: true })
              .waitFor();
            await shot('archive-confirm');
          } else if (scenario === 'interactions') {
            await shot('rest');
            const bounds = await row().boundingBox();
            await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
            await page.mouse.down();
            await shot('pointer-held');
            await page.mouse.up();
            await row().click({ button: 'right' });
            await page.getByRole('menuitem', { name: 'Rename', exact: true }).waitFor();
            await shot('trusted-context-menu');
            await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
            const input = row().locator('input');
            await input.waitFor();
            await input.fill('  Committed by Enter 中文  ');
            await shot('rename-input');
            await input.press('Enter');
            await page
              .getByText('Renamed long: Committed by Enter 中文', { exact: true })
              .waitFor();
            await shot('rename-enter', { title: 'Committed by Enter 中文' });
            await rename();
            await input.fill('Cancelled name');
            await input.press('Escape');
            assert.equal(await row().locator('input').count(), 0);
            assert.ok((await row().textContent()).includes('Committed by Enter 中文'));
            await shot('rename-escape', { titlePreserved: true });
            await rename();
            await input.fill('   ');
            await input.press('Enter');
            assert.ok((await row().textContent()).includes('Committed by Enter 中文'));
            await page
              .getByText('Renamed long: Committed by Enter 中文', { exact: true })
              .waitFor();
            await shot('rename-empty-rejected', { titlePreserved: true });
            await rename();
            const blurTitle =
              'Committed by blur 中文 · exceptionally long title / branch / repository boundaries';
            await input.fill(blurTitle);
            await page.locator('[data-legacy-blur-target]').click();
            await page.getByText(`Renamed long: ${blurTitle}`, { exact: true }).waitFor();
            await shot('rename-blur');
            await row().hover();
            const titleBefore = await row().locator(':scope > div > div').nth(1).boundingBox();
            await row().getByRole('button', { name: 'Archive session', exact: true }).click();
            const confirm = row().getByRole('button', {
              name: 'Confirm Archive session',
              exact: true,
            });
            await confirm.waitFor();
            const titleAfter = await row().locator(':scope > div > div').nth(1).boundingBox();
            assert.deepEqual(
              titleAfter,
              titleBefore,
              'Archive confirmation must preserve title-column geometry'
            );
            await shot('archive-confirm', { titleColumnUnchanged: true });
            await confirm.press('Escape');
            assert.equal(
              await row()
                .getByRole('button', { name: 'Confirm Archive session', exact: true })
                .count(),
              0
            );
            await shot('archive-escape');
            for (const nextPinned of [true, false]) {
              await row().click({ button: 'right' });
              await page
                .getByRole('menuitem', {
                  name: nextPinned ? 'Pin Session' : 'Unpin Session',
                  exact: true,
                })
                .click();
              await page
                .getByText(`${nextPinned ? 'Pinned' : 'Unpinned'} long`, { exact: true })
                .waitFor();
              await shot(nextPinned ? 'pinned' : 'unpinned', { nextPinned });
            }
            await row().hover();
            await row().getByRole('button', { name: 'Archive session', exact: true }).click();
            await row()
              .getByRole('button', { name: 'Confirm Archive session', exact: true })
              .click();
            await row().waitFor({ state: 'hidden' });
            await page.getByText('Archived long', { exact: true }).waitFor();
            await shot('archive-completed', { archiveCallback: true });
          } else if (scenario === 'anchor-rows') {
            await shot('rest');
            await page.keyboard.press('Tab');
            await row().locator('a').focus();
            assert.ok(
              await row()
                .locator('a')
                .evaluate((e) => e.matches(':focus-visible'))
            );
            await shot('keyboard-focus');
            await row().locator('a').press('Enter');
            await page.getByText('Selected long', { exact: true }).waitFor();
            await shot('keyboard-selected', { selectionCallback: true });
          } else {
            await shot('rest');
            const cdp = await context.newCDPSession(page);
            const swipe = async (id) => {
              const bounds = await row(id).boundingBox();
              const x = bounds.x + bounds.width - 36,
                y = bounds.y + bounds.height / 2;
              await cdp.send('Input.dispatchTouchEvent', {
                type: 'touchStart',
                touchPoints: [{ x, y }],
              });
              for (const distance of [12, 30, 50, 80])
                await cdp.send('Input.dispatchTouchEvent', {
                  type: 'touchMove',
                  touchPoints: [{ x: x - distance, y }],
                });
              await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            };
            await swipe('pinned');
            await shot('touch-revealed');
            await swipe('pinned');
            await row('pinned').waitFor({ state: 'hidden' });
            await page.getByText('Archived pinned', { exact: true }).waitFor();
            await shot('touch-committed', { archiveCallback: true });
            assert.ok(
              (await page.evaluate(() => window.__legacyInputs)).some(
                (event) => event.pointerType === 'touch' && event.trusted
              )
            );
            await cdp.detach();
          }
        } catch (error) {
          failures.push({ key, error: String(error) });
          await page
            .screenshot({
              path: path.join(out, 'shots', `${key}__error.png`),
              animations: 'disabled',
            })
            .catch(() => {});
        } finally {
          await page.close();
        }
      }
      await context.close();
    }
  }
} finally {
  const harnessSha = createHash('sha256')
    .update(await readFile(fileURLToPath(import.meta.url)))
    .digest('hex');
  await writeFile(
    path.join(out, 'manifest.json'),
    JSON.stringify(
      { phase: args.phase, storybook: args.storybook, fingerprint, harnessSha, entries, failures },
      null,
      2
    )
  );
  await browser.close();
}
console.log(JSON.stringify({ entries: entries.length, failures }));
if (failures.length || entries.length !== 90) process.exitCode = 1;
