import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

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
    delete window.__ownedUpdatedStable;
  });
  await page.waitForFunction(() => {
    const value = JSON.stringify(
      [...document.querySelectorAll('[data-owned-updated-fixture] *,[role="menu"]')].map((e) =>
        e.getBoundingClientRect().toJSON()
      )
    );
    const previous = window.__ownedUpdatedStable ?? { value: '', count: 0 };
    previous.count = previous.value === value ? previous.count + 1 : 0;
    previous.value = value;
    window.__ownedUpdatedStable = previous;
    return previous.count >= 3;
  });
};
let expected = 0;
try {
  for (const viewport of [
    { name: 'desktop', width: 1280, height: 1000 },
    { name: 'narrow', width: 320, height: 1000 },
    { name: 'touch', width: 390, height: 1000 },
  ])
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport,
        deviceScaleFactor: 1,
        reducedMotion: 'reduce',
        colorScheme: theme,
        hasTouch: viewport.name === 'touch',
      });
      const seed = await context.newPage();
      await seed.clock.setFixedTime(new Date('2026-10-22T09:00Z'));
      await seed.close();
      const scenarios =
        viewport.name === 'touch'
          ? ['mobile-rows']
          : [
              'tree-and-projects',
              'anchor-rows',
              'read-only',
              'caller-overrides',
              'scoped-variables',
              ...(viewport.name === 'desktop' ? ['root-variables'] : []),
            ];
      for (const scenario of scenarios) {
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        const key = `${scenario}__${viewport.name}__${theme}`;
        const row = (id = 'opener') => page.locator(`[data-sidebar-updated-id="${id}"]`);
        expected +=
          scenario === 'tree-and-projects'
            ? 14
            : scenario === 'anchor-rows'
              ? 3
              : scenario === 'read-only'
                ? 3
                : scenario === 'mobile-rows'
                  ? 3
                  : 4;
        try {
          await page.addInitScript(() => {
            window.__ownedUpdatedInputs = [];
            for (const type of [
              'pointerdown',
              'pointerup',
              'keydown',
              'contextmenu',
              'dragstart',
              'drop',
              'dragend',
            ])
              document.addEventListener(
                type,
                (e) =>
                  window.__ownedUpdatedInputs.push({
                    type,
                    trusted: e.isTrusted,
                    pointerType: e.pointerType ?? null,
                    key: e.key ?? null,
                    button: e.button ?? null,
                    transfer: e.dataTransfer ? [...e.dataTransfer.types] : null,
                  }),
                true
              );
          });
          const url = new URL('/iframe.html', args.storybook);
          url.search = new URLSearchParams({
            id: `components-ownedupdatedsessionmigration--${scenario === 'root-variables' ? 'tree-and-projects' : scenario}`,
            viewMode: 'story',
            globals: `theme:${theme};locale:en`,
          });
          await page.goto(url.href);
          await row().waitFor();
          const result = page.locator('[data-owned-updated-result]');
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
              events: await page.evaluate(() => window.__ownedUpdatedInputs),
            });
            console.log(name);
          };
          const menu = async (id = 'opener') => {
            await row(id).click({ button: 'right' });
            await page.getByRole('menuitem').first().waitFor();
          };
          const waitOpacity = (value, id = 'opener') =>
            expect(row(id).getByRole('button', { name: 'More actions', exact: true })).toHaveCSS(
              'opacity',
              value
            );
          const neutralRest = async () => {
            await expect(page.locator('[role="menu"]')).toHaveCount(0);
            await row().hover();
            await page.mouse.move(8, 8);
            await expect(page.locator('[role="presentation"]')).toHaveCount(0);
            await expect(page.locator('[data-sidebar-updated-id]:hover')).toHaveCount(0);
            await page.evaluate(() => {
              window.__ownedNeutralCount = 0;
            });
            await page.waitForFunction(
              () => {
                const absent =
                  document.querySelector(
                    '[role="menu"], [role="presentation"], [data-sidebar-updated-id]:hover'
                  ) === null;
                window.__ownedNeutralCount = absent ? window.__ownedNeutralCount + 1 : 0;
                return window.__ownedNeutralCount >= 3;
              },
              undefined,
              { polling: 100, timeout: 15000 }
            );
            return page.evaluate(() => {
              const active = document.activeElement;
              const trigger = document.querySelector('[data-sidebar-updated-id="opener"]');
              return {
                gesture: 'Menu detached, trusted pointer re-enters opener then leaves; no blur',
                active: {
                  tag: active.tagName,
                  role: active.getAttribute('role'),
                  label: active.getAttribute('aria-label'),
                  id: active.getAttribute('data-sidebar-updated-id'),
                  focusVisible: active.matches(':focus-visible'),
                },
                trigger: {
                  hovered: trigger.matches(':hover'),
                  focusWithin: trigger.matches(':focus-within'),
                },
                cardCount: document.querySelectorAll('[role="presentation"]').length,
              };
            });
          };
          if (scenario === 'mobile-rows') {
            await shot('rest');
            const cdp = await context.newCDPSession(page);
            const swipe = async () => {
              const box = await row('waiting').boundingBox();
              const x = box.x + box.width - 36,
                y = box.y + 12;
              await cdp.send('Input.dispatchTouchEvent', {
                type: 'touchStart',
                touchPoints: [{ x, y }],
              });
              for (const d of [12, 30, 50, 80])
                await cdp.send('Input.dispatchTouchEvent', {
                  type: 'touchMove',
                  touchPoints: [{ x: x - d, y }],
                });
              await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            };
            await swipe();
            await shot('touch-revealed');
            await swipe();
            await row('waiting').waitFor({ state: 'hidden' });
            assert.equal(await result.textContent(), 'Archived waiting');
            await shot('touch-committed', { archiveCallback: true });
            await cdp.detach();
          } else if (scenario === 'tree-and-projects') {
            await page.mouse.move(8, 8);
            await waitOpacity('0');
            await shot('outer-marker-hover', { leadingMenuHidden: true });
            await row().hover();
            await waitOpacity('1');
            await shot('opener-hover', { leadingMenuVisible: true });
            await row('child-a').hover();
            await waitOpacity('1', 'child-a');
            await shot('child-hover');
            await menu();
            await shot('menu-open');
            await page.keyboard.press('Escape');
            await shot('menu-escape');
            await menu();
            await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
            const dialog = page.getByRole('dialog', { name: 'Rename Chat', exact: true });
            await dialog.waitFor();
            await shot('rename-dialog');
            await dialog
              .locator('textarea')
              .fill('Updated renamed title 中文 / long title / project / branch');
            await dialog.getByRole('button', { name: 'Save', exact: true }).click();
            await dialog.waitFor({ state: 'hidden' });
            assert.equal(
              await result.textContent(),
              'Renamed opener: Updated renamed title 中文 / long title / project / branch'
            );
            await shot('rename-saved', { renameCallback: true });
            await menu();
            await page.getByRole('menuitem', { name: 'Hide opened sessions', exact: true }).click();
            await row('child-a').waitFor({ state: 'hidden' });
            await shot('tree-collapsed');
            await menu();
            await page
              .getByRole('menuitem', { name: 'Show 2 opened sessions', exact: true })
              .click();
            await row('child-a').waitFor();
            await shot('tree-expanded');
            await row().hover();
            const titleBefore = await row().locator(':scope > div > div').nth(1).boundingBox();
            await row().getByRole('button', { name: 'Archive session', exact: true }).click();
            const confirm = row().getByRole('button', {
              name: 'Confirm Archive session',
              exact: true,
            });
            await confirm.waitFor();
            const titleAfter = await row().locator(':scope > div > div').nth(1).boundingBox();
            assert.deepEqual(titleAfter, titleBefore);
            await shot('archive-confirm', { titleColumnPreserved: true });
            await confirm.press('Escape');
            await shot('archive-escape');
            await row('child-b').dragTo(page.locator('[data-owned-updated-drop-target]'));
            assert.ok((await result.textContent()).includes('application/x-lody-session-mention'));
            const events = await page.evaluate(() => window.__ownedUpdatedInputs);
            assert.ok(events.some((e) => e.type === 'dragstart' && e.trusted));
            await shot('mention-dropped', { trustedDrag: true });
            await menu('child-a');
            await page.getByRole('menuitem', { name: 'Go to Opener Session', exact: true }).click();
            assert.equal(await result.textContent(), 'Selected opener tab opener-tab');
            const selectedRest = await neutralRest();
            await shot('precise-opener-selected', {
              root: 'opener',
              tab: 'opener-tab',
              selectedRest,
            });
            await menu('child-a');
            await page.getByRole('menuitem', { name: 'Mark as unread', exact: true }).click();
            assert.equal(await result.textContent(), 'Unread child-a');
            await menu('child-a');
            assert.equal(
              await page.getByRole('menuitem', { name: 'Mark as unread', exact: true }).count(),
              0
            );
            await shot('marked-unread', { callback: true, menuActionRemoved: true });
          } else if (scenario === 'anchor-rows') {
            await page.mouse.move(8, 8);
            await page.keyboard.press('Tab');
            await row().locator('a').focus();
            assert.ok(
              await row()
                .locator('a')
                .evaluate((e) => e.matches(':focus-visible'))
            );
            await shot('anchor-focus');
            await row().locator('a').press('Enter');
            assert.equal(await result.textContent(), 'Selected opener');
            await shot('anchor-selected');
            assert.equal(await row('child-b').locator('a').getAttribute('draggable'), 'false');
            await row('child-b')
              .locator('a')
              .dragTo(page.locator('[data-owned-updated-drop-target]'));
            assert.ok((await result.textContent()).includes('application/x-lody-session-mention'));
            await shot('anchor-mention-dropped');
          } else if (scenario === 'read-only') {
            await page.mouse.move(8, 8);
            await shot('rest');
            await row('waiting').click();
            assert.equal(await result.textContent(), 'Ready');
            assert.equal(await row('waiting').getAttribute('role'), null);
            await shot('readonly-click', { inert: true });
            await menu();
            await page.getByRole('menuitem', { name: 'Hide opened sessions', exact: true }).click();
            await row('child-a').waitFor({ state: 'hidden' });
            await shot('readonly-tree-toggle');
          } else {
            if (scenario === 'root-variables')
              await page.evaluate((values) => {
                for (const [k, v] of Object.entries(values))
                  document.documentElement.style.setProperty(k, v);
              }, scopes);
            await page.mouse.move(8, 8);
            await waitOpacity(scenario === 'caller-overrides' ? '0.5' : '0');
            await shot('outer-hover');
            await row().hover();
            await waitOpacity(scenario === 'caller-overrides' ? '0.5' : '1');
            await shot('row-hover');
            await menu();
            await shot('menu-open');
            await page.keyboard.press('Escape');
            const closedRest = await neutralRest();
            await shot('menu-closed', { closedRest });
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
} finally {
  const harnessSha = createHash('sha256')
    .update(await readFile(fileURLToPath(import.meta.url)))
    .digest('hex');
  await writeFile(
    path.join(out, 'manifest.json'),
    JSON.stringify(
      {
        phase: args.phase,
        storybook: args.storybook,
        fingerprint,
        harnessSha,
        expected,
        entries,
        failures,
      },
      null,
      2
    )
  );
  await browser.close();
}
console.log(JSON.stringify({ expected, entries: entries.length, failures }));
if (failures.length || entries.length !== expected) process.exitCode = 1;
