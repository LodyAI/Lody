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
                'margin',
                'padding',
                'borderColor',
              ].map((property) => [property, computed[property]])
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
        styles: Object.fromEntries(properties.map((property) => [property, styles[property]])),
        pseudo,
        active: document.activeElement === e,
        focusVisible: e.matches(':focus-visible'),
        value: e instanceof HTMLInputElement ? e.value : null,
        disabled: 'disabled' in e ? e.disabled : null,
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
    window.__mobileWorkspaceStable = { value: '', count: 0 };
  });
  await page.waitForFunction(
    () => {
      const value = JSON.stringify(
        [
          ...document.querySelectorAll(
            '[data-slot="drawer-content"], [data-slot="drawer-content"] *, [data-mobile-workspace-fixture]'
          ),
        ].map((e) => e.getBoundingClientRect().toJSON())
      );
      const stable = window.__mobileWorkspaceStable;
      stable.count = stable.value === value ? stable.count + 1 : 0;
      stable.value = value;
      return stable.count >= 3;
    },
    undefined,
    { polling: 100, timeout: 15000 }
  );
};
const variables = {
  '--spacing': '0.3125rem',
  '--radius-2xl': '23px',
  '--font-weight-medium': '620',
  '--foreground': '225 43% 36%',
  '--destructive': '330 62% 43%',
  '--border': '160 42% 45%',
  '--color-amber-100': 'oklch(88% 0.13 70)',
};
const entries = [],
  failures = [];
let expected = 0;
try {
  for (const viewport of [
    { name: 'narrow-touch', width: 320, height: 720, hasTouch: true },
    { name: 'phone-touch', width: 390, height: 844, hasTouch: true },
    { name: 'tablet', width: 768, height: 1024, hasTouch: false },
  ]) {
    for (const theme of ['light', 'dark']) {
      const scenarios = [
        'create',
        'delete',
        ...(viewport.name === 'phone-touch'
          ? [
              'create-root',
              'delete-root',
              'create-portal',
              'delete-portal',
              'create-keyboard-inset',
              'delete-keyboard-inset',
            ]
          : []),
      ];
      for (const scenario of scenarios) {
        if (args.only && !new RegExp(args.only).test(`${scenario}__${viewport.name}__${theme}`))
          continue;
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: 1,
          reducedMotion: 'reduce',
          colorScheme: theme,
          hasTouch: viewport.hasTouch,
          isMobile: viewport.hasTouch,
        });
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        const kind = scenario.startsWith('create') ? 'create' : 'delete';
        const key = `${scenario}__${viewport.name}__${theme}`;
        const id = `components-ownedmobileworkspacesheetsmigration--${kind === 'delete' ? 'delete-warning' : 'create'}`;
        expected += scenario === kind ? 7 : 2;
        try {
          await page.clock.setFixedTime(new Date('2026-10-22T09:00:00Z'));
          await page.addInitScript(() => {
            window.__mobileWorkspaceEvents = [];
            window.__mobileWorkspaceErrors = [];
            for (const type of ['pointerdown', 'pointerup', 'keydown', 'input', 'change'])
              document.addEventListener(
                type,
                (event) => {
                  window.__mobileWorkspaceEvents.push({
                    type,
                    trusted: event.isTrusted,
                    pointerType: event.pointerType ?? null,
                    key: event.key ?? null,
                    target:
                      event.target.id ||
                      event.target.getAttribute('aria-label') ||
                      event.target.tagName,
                  });
                },
                true
              );
            const original = console.error;
            console.error = (...items) => {
              window.__mobileWorkspaceErrors.push(
                items.map((item) => (item instanceof Error ? item.message : String(item))).join(' ')
              );
              original(...items);
            };
          });
          const url = new URL('/iframe.html', args.storybook);
          url.search = new URLSearchParams({
            id,
            viewMode: 'story',
            globals: `theme:${theme};locale:en`,
          });
          await page.goto(url.href);
          const drawer = page.locator('[data-slot="drawer-content"]');
          await expect(drawer).toBeVisible();
          if (
            scenario.includes('-root') ||
            scenario.includes('-portal') ||
            scenario.includes('-keyboard-inset')
          ) {
            await page.evaluate(
              ({ scope, values }) => {
                const target =
                  scope === 'root'
                    ? document.documentElement
                    : document.querySelector('[data-slot="drawer-content"]');
                for (const [name, value] of Object.entries(values))
                  target.style.setProperty(name, value);
              },
              {
                scope: scenario.includes('-root') ? 'root' : 'portal',
                values: scenario.includes('-keyboard-inset')
                  ? { '--native-keyboard-height': '240px', '--safe-area-bottom': '34px' }
                  : variables,
              }
            );
          }
          const input = page.locator(
            kind === 'create' ? '#mobile-create-workspace-name' : '#mobile-delete-workspace-confirm'
          );
          const primary = () =>
            page.getByRole('button', {
              name: kind === 'create' ? 'Create' : 'Delete Permanently',
              exact: true,
            });
          const press = async (locator) => (viewport.hasTouch ? locator.tap() : locator.click());
          const shot = async (state, assertions = {}) => {
            await settle(page);
            await page.evaluate(() => {
              for (const animation of document.getAnimations()) {
                if (animation.effect?.getTiming().iterations === Infinity) {
                  animation.pause();
                  animation.currentTime = 0;
                }
              }
            });
            const name = `${key}__${state}`;
            const shotPath = `shots/${name}.png`;
            await page.screenshot({
              path: path.join(out, shotPath),
              animations: 'disabled',
              caret: 'hide',
            });
            const bytes = await readFile(path.join(out, shotPath));
            entries.push({
              key: name,
              id,
              scenario,
              viewport: viewport.name,
              theme,
              state,
              shot: shotPath,
              sha256: createHash('sha256').update(bytes).digest('hex'),
              assertions,
              layout: await page.evaluate(inspect),
              events: await page.evaluate(() => window.__mobileWorkspaceEvents),
              errors: await page.evaluate(() => window.__mobileWorkspaceErrors),
              observation: await page.evaluate(() => ({
                viewport: [innerWidth, innerHeight],
                documentWidth: document.documentElement.scrollWidth,
                pointerCoarse: matchMedia('(pointer: coarse)').matches,
                hover: matchMedia('(hover: hover)').matches,
              })),
            });
            console.log(name);
          };
          await expect(primary()).toBeDisabled();
          await shot('rest', { submitDisabled: true });
          if (scenario !== kind) {
            await press(input);
            await input.pressSequentially(
              kind === 'create' ? 'Scoped Workspace' : 'Synthetic Workspace'
            );
            await expect(input).toBeFocused();
            await expect(primary()).toBeEnabled();
            await shot('focused-filled', {
              submitEnabled: true,
              focused: true,
              scope: scenario.split('-').slice(1).join('-'),
            });
          } else if (kind === 'create') {
            await press(input);
            await input.pressSequentially('Synthetic Team');
            await expect(page.locator('#mobile-create-workspace-slug')).toHaveValue(
              'synthetic-team'
            );
            await expect(primary()).toBeEnabled();
            await shot('entered', { suggestion: 'synthetic-team', submitEnabled: true });
            const slug = page.locator('#mobile-create-workspace-slug');
            await slug.fill('a');
            await expect(primary()).toBeDisabled();
            await shot('invalid', { slug: 'a', submitDisabled: true });
            await press(page.getByRole('button', { name: 'Use suggestion', exact: true }));
            await expect(slug).toHaveValue('synthetic-team');
            await expect(primary()).toBeEnabled();
            await shot('reset-suggestion', { slug: 'synthetic-team' });
            await slug.press('Enter');
            await page.waitForFunction(() =>
              window.__mobileWorkspaceErrors.some((message) =>
                message.includes('Workspace management is not available on the local platform')
              )
            );
            await expect(primary()).toBeEnabled();
            await expect(drawer).toBeVisible();
            await shot('local-rejection', {
              localGuard: 'Workspace management is not available on the local platform',
              sheetOpen: true,
              submitEnabled: true,
            });
            await press(page.getByRole('button', { name: 'Cancel', exact: true }));
            await expect(drawer).toHaveCount(0);
            await shot('closed', { sheetAbsent: true });
            await press(page.locator('[data-mobile-workspace-reopen]'));
            await expect(input).toHaveValue('');
            await expect(slug).toHaveValue('');
            await shot('reopened', {
              name: '',
              slug: '',
              submitDisabled: await primary().isDisabled(),
            });
          } else {
            await press(input);
            await input.pressSequentially('Synthetic WorkspacE');
            await expect(primary()).toBeDisabled();
            await shot('mismatch', { submitDisabled: true, caseSensitive: true });
            await input.fill('Synthetic Workspace');
            await expect(primary()).toBeEnabled();
            await input.press('Tab');
            await shot('matching-keyboard', { submitEnabled: true });
            await input.press('Enter');
            await expect(input).toBeDisabled();
            await expect(page.getByRole('button', { name: /Processing/ })).toBeDisabled();
            await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
            await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeDisabled();
            await shot('pending', {
              inputDisabled: true,
              submitDisabled: true,
              cancelDisabled: true,
              closeDisabled: true,
            });
            await page.evaluate(() =>
              window.dispatchEvent(new Event('mobile-workspace-fixture-settle'))
            );
            await expect(drawer).toHaveCount(0);
            await expect(page.locator('[data-mobile-workspace-result]')).toHaveText('Closed');
            await shot('completed-closed', { deferredResponse: 'resolved', sheetAbsent: true });
            await press(page.locator('[data-mobile-workspace-reopen]'));
            await expect(input).toHaveValue('');
            await expect(primary()).toBeDisabled();
            await shot('reopened', { confirmation: '', submitDisabled: true });
            await press(page.getByRole('button', { name: 'Cancel', exact: true }));
            await expect(drawer).toHaveCount(0);
            await shot('cancelled', { sheetAbsent: true });
          }
        } catch (error) {
          const shotPath = `shots/${key}__error.png`;
          await page.screenshot({ path: path.join(out, shotPath), caret: 'hide' }).catch(() => {});
          failures.push({ key, message: String(error.message ?? error), shot: shotPath });
          console.error(key, error.message);
        } finally {
          await context.close();
        }
      }
    }
  }
} finally {
  await browser.close();
}
const harnessFingerprint = createHash('sha256')
  .update(await readFile(fileURLToPath(import.meta.url)))
  .digest('hex');
await writeFile(
  path.join(out, 'manifest.json'),
  JSON.stringify(
    {
      phase: args.phase,
      baseUrl: args.storybook,
      buildFingerprint,
      harnessFingerprint,
      expected,
      entries,
    },
    null,
    2
  ) + '\n'
);
await writeFile(path.join(out, 'failures.json'), JSON.stringify(failures, null, 2) + '\n');
assert.equal(failures.length, 0, `${failures.length} capture failures`);
assert.equal(entries.length, expected);
console.log(`Captured ${entries.length}/${expected}, failures ${failures.length}`);
