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
const buildFingerprint = createHash('sha256').update(iframe).update(index).digest('hex');
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
    'minHeight',
    'maxHeight',
    'flex',
    'flexDirection',
    'flexGrow',
    'flexShrink',
    'flexBasis',
    'alignItems',
    'justifyContent',
    'gap',
    'margin',
    'marginTop',
    'marginBottom',
    'marginInlineStart',
    'marginInlineEnd',
    'padding',
    'paddingTop',
    'paddingBottom',
    'paddingInlineStart',
    'paddingInlineEnd',
    'borderWidth',
    'borderStyle',
    'borderColor',
    'borderRadius',
    'borderTopLeftRadius',
    'borderTopRightRadius',
    'boxSizing',
    'color',
    'backgroundColor',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'lineHeight',
    'letterSpacing',
    'whiteSpace',
    'textOverflow',
    'overflow',
    'overflowX',
    'overflowY',
    'opacity',
    'pointerEvents',
    'cursor',
    'outline',
    'outlineOffset',
    'boxShadow',
    'transform',
    'translate',
    'transitionProperty',
    'transitionDuration',
    'transitionDelay',
    'animationDelay',
    '--tw-content',
    '--tw-duration',
    '--tw-animation-delay',
    '--tw-translate-x',
    '--tw-translate-y',
    '--tw-ease',
    'transitionTimingFunction',
  ];
  return [...document.body.querySelectorAll('*')]
    .filter((e) => !['SCRIPT', 'STYLE', 'LINK'].includes(e.tagName))
    .map((e, i) => {
      const rect = e.getBoundingClientRect();
      const styles = getComputedStyle(e);
      const pseudo = Object.fromEntries(
        ['::before', '::after'].map((selector) => {
          const computed = getComputedStyle(e, selector);
          return [
            selector,
            Object.fromEntries(
              [
                'content',
                'display',
                'color',
                'backgroundColor',
                'boxShadow',
                'width',
                'height',
                'top',
                'bottom',
                'left',
                'right',
                'translate',
                'transform',
                'opacity',
                'transitionProperty',
                'transitionDuration',
                'transitionDelay',
                'animationDelay',
                '--tw-content',
                '--tw-duration',
                '--tw-animation-delay',
                '--tw-translate-x',
                '--tw-translate-y',
                '--tw-ease',
                'transitionTimingFunction',
                'margin',
                'padding',
                'borderColor',
              ].map((property) => [
                property,
                property.startsWith('--')
                  ? computed.getPropertyValue(property)
                  : computed[property],
              ])
            ),
          ];
        })
      );
      return {
        path: String(i),
        tag: e.tagName,
        text: e.textContent?.trim().slice(0, 200),
        role: e.getAttribute('role'),
        label: e.getAttribute('aria-label'),
        rect: [rect.x, rect.y, rect.width, rect.height],
        styles: Object.fromEntries(
          properties.map((property) => [
            property,
            property.startsWith('--') ? styles.getPropertyValue(property) : styles[property],
          ])
        ),
        pseudo,
        active: document.activeElement === e,
        focusVisible: e.matches(':focus-visible'),
        value: e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement ? e.value : null,
        disabled: 'disabled' in e ? e.disabled : null,
      };
    });
};

const entries = [];
const failures = [];
const scenarioSizes = { desktop: 1280, compact: 767, root: 1280, subtree: 1280, caller: 1280 };
const settle = async (page) => {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
      .every((animation) => animation.playState !== 'running' && animation.playState !== 'pending')
  );
  await page.waitForFunction(() => {
    const root = document.querySelector('[data-session-layout-fixture]');
    if (!root) return false;
    const signature = JSON.stringify(
      [...root.querySelectorAll('*')].map((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const after = getComputedStyle(element, '::after');
        return [
          rect.x,
          rect.y,
          rect.width,
          rect.height,
          style.opacity,
          style.transform,
          style.transitionDuration,
          after.backgroundColor,
          after.width,
          after.left,
          after.translate,
        ];
      })
    );
    const state = window.__sessionLayoutStable ?? { signature: '', count: 0 };
    state.count = signature === state.signature ? state.count + 1 : 0;
    state.signature = signature;
    window.__sessionLayoutStable = state;
    return state.count >= 3;
  });
};
try {
  for (const theme of ['light', 'dark'])
    for (const scenario of Object.keys(scenarioSizes)) {
      if (args.only && !new RegExp(args.only).test(scenario)) continue;
      const viewport = { width: scenarioSizes[scenario], height: 800 };
      const context = await browser.newContext({
        viewport,
        deviceScaleFactor: 1,
        reducedMotion: scenario === 'compact' || scenario === 'caller' ? 'reduce' : 'no-preference',
        colorScheme: theme,
      });
      const page = await context.newPage();
      const id =
        'sessions-ownedsessionlayoutmigration--' +
        (scenario === 'subtree'
          ? 'subtree-variables'
          : scenario === 'caller'
            ? 'caller-overrides'
            : 'open');
      let currentState = 'load';
      try {
        await page.clock.setFixedTime(new Date('2026-10-22T09:00:00Z'));
        await page.addInitScript(() => {
          window.__sessionLayoutEvents = [];
          for (const type of ['pointerdown', 'pointerup', 'keydown', 'input', 'click'])
            document.addEventListener(
              type,
              (event) => {
                const target = event.target;
                window.__sessionLayoutEvents.push({
                  type,
                  trusted: event.isTrusted,
                  key: event.key ?? null,
                  pointerType: event.pointerType ?? null,
                  tag: target?.tagName ?? null,
                  label:
                    target?.getAttribute?.('aria-label') ??
                    target?.textContent?.trim().slice(0, 60) ??
                    null,
                });
              },
              true
            );
        });
        const url = new URL('/iframe.html', args.storybook);
        url.search = new URLSearchParams({
          id,
          viewMode: 'story',
          globals: `theme:${theme};locale:en`,
        });
        await page.goto(url.href);
        await expect(page.locator('[data-session-layout-fixture]')).toBeVisible();
        if (scenario === 'root')
          await page.evaluate(() => {
            document.documentElement.style.setProperty('--spacing', '5px');
            document.documentElement.style.setProperty('--sidebar-ring', '300 80% 40%');
          });
        const fixture = page.locator('[data-session-layout-fixture]');
        const handle = page.locator('[data-slot="resizable-handle"]');
        const sidebar = page.locator('[data-panel-id="sidebar"]');
        const save = async (state, assertions = {}) => {
          currentState = state;
          await settle(page);
          const key = `${scenario}__${theme}__${state}`;
          const shot = `shots/${key}.png`;
          await page.screenshot({
            path: path.join(out, shot),
            animations: 'disabled',
            caret: 'hide',
          });
          const bytes = await readFile(path.join(out, shot));
          entries.push({
            key,
            id,
            viewport: scenario,
            theme,
            state,
            shot,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            assertions,
            layout: await page.evaluate(inspect),
            events: await page.evaluate(() => window.__sessionLayoutEvents),
            observation: await page.evaluate(() => ({
              viewport: [innerWidth, innerHeight],
              documentWidth: document.documentElement.scrollWidth,
              sidebarOpen: document.querySelector('[data-session-layout-fixture]').dataset
                .sidebarOpen,
              restoreSeq: document.querySelector('[data-session-layout-fixture]').dataset
                .restoreSeq,
              reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
              handle: {
                disabled: document
                  .querySelector('[data-slot="resizable-handle"]')
                  .getAttribute('data-panel-resize-handle-enabled'),
                state: document
                  .querySelector('[data-slot="resizable-handle"]')
                  .getAttribute('data-resize-handle-state'),
              },
            })),
          });
          console.log(key);
        };
        await settle(page);
        await save('rest');
        if (scenario === 'compact') {
          await expect(handle).toHaveAttribute('data-panel-resize-handle-enabled', 'false');
          await page.getByRole('button', { name: 'Toggle panel', exact: true }).click();
          await expect(fixture).toHaveAttribute('data-sidebar-open', 'false');
          await save('closed', { handleDisabled: true });
          await page.getByRole('button', { name: 'Restore open', exact: true }).click();
          await expect(page.locator('[data-layout-pane="secondary"]')).toBeVisible();
          await save('overlay-restored', { secondaryVisible: true });
        } else if (scenario === 'caller') {
          await expect(page.locator('[data-workspace-card]')).toHaveCSS('flex-direction', 'row');
          await expect(page.locator('[data-workspace-card]')).toHaveCSS('overflow', 'visible');
          await expect(page.locator('[data-workspace-card]')).toHaveCSS('min-width', '360px');
          await save('caller-winners', {
            flexDirection: 'row',
            overflow: 'visible',
            minWidth: '360px',
          });
        } else {
          await handle.hover();
          await save('hover');
          if (scenario !== 'desktop') {
            await handle.focus();
            await handle.press('ArrowLeft');
            await save('keyboard-resized');
          } else {
            const initial = await sidebar.boundingBox();
            const bounds = await handle.boundingBox();
            assert.ok(initial && bounds);
            await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
            await page.mouse.down();
            await page.mouse.move(bounds.x - 80, bounds.y + bounds.height / 2, { steps: 5 });
            await expect(handle).toHaveAttribute('data-resize-handle-state', 'drag');
            await save('pointer-held', { drag: true });
            assert.ok((await sidebar.boundingBox()).width > initial.width + 20);
            await expect(sidebar).toHaveCSS('transition-duration', '0s');
            await page.mouse.up();
            await save('pointer-released');
            await handle.focus();
            await handle.press('ArrowLeft');
            await save('keyboard-resized');
            const draft = page.getByRole('textbox', { name: 'Panel retained draft' });
            await draft.fill('Retained across hide');
            const originalNode = await draft.elementHandle();
            await page.getByRole('button', { name: 'Toggle panel', exact: true }).click();
            await expect(fixture).toHaveAttribute('data-sidebar-open', 'false');
            await save('closed');
            assert.equal(await originalNode.evaluate((node) => node.isConnected), true);
            await page.getByRole('button', { name: 'Restore open', exact: true }).click();
            await expect(draft).toHaveValue('Retained across hide');
            assert.equal(
              await draft.evaluate((node, previous) => node === previous, originalNode),
              true
            );
            await save('restored-open', { retainedDraft: true, retainedNode: true });
            await page.getByRole('button', { name: 'Request 500px', exact: true }).click();
            await settle(page);
            assert.ok((await sidebar.boundingBox()).width >= 499);
            await save('minimum-width', { sidebarAtLeast499: true });
            await page.getByRole('button', { name: 'Restore closed', exact: true }).click();
            await expect(fixture).toHaveAttribute('data-sidebar-open', 'false');
            await save('restored-closed');
            await page.getByRole('button', { name: 'Toggle panel', exact: true }).click();
            await expect(draft).toHaveValue('Retained across hide');
            await save('reopened', { retainedDraft: true });
          }
        }
      } catch (error) {
        failures.push({
          scenario,
          theme,
          state: currentState,
          message: String(error.stack ?? error),
        });
        await page
          .screenshot({ path: path.join(out, `failure-${scenario}-${theme}.png`), caret: 'hide' })
          .catch(() => {});
        console.error(scenario, theme, error.message);
      } finally {
        await context.close();
      }
    }
} finally {
  await browser.close();
}
await writeFile(
  path.join(out, 'manifest.json'),
  JSON.stringify(
    {
      phase: args.phase,
      baseUrl: args.storybook,
      buildFingerprint,
      harnessFingerprint: createHash('sha256')
        .update(await readFile(fileURLToPath(import.meta.url)))
        .digest('hex'),
      expected: args.only ? null : 42,
      entries,
    },
    null,
    2
  ) + '\n'
);
await writeFile(path.join(out, 'failures.json'), JSON.stringify(failures, null, 2) + '\n');
assert.equal(failures.length, 0);
if (!args.only) assert.equal(entries.length, 42);
console.log(`Captured ${entries.length}, failures0`);
