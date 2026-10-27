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

const entries = [],
  failures = [],
  blockedRequests = [];
const scenarios = [
  { name: 'groups', id: 'components-sidebar-folded-group-status--folded' },
  { name: 'projects', id: 'components-lodysidebar--with-projects' },
  { name: 'removing', id: 'projects-localprojectremovalux--project-removing' },
  { name: 'waiting', id: 'projects-localprojectremovalux--project-waiting-for-device' },
];
const settle = async (page) => {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => {
    for (const animation of document.getAnimations())
      if (animation.effect?.getTiming().iterations === Infinity) {
        animation.pause();
        animation.currentTime = 0;
      }
  });
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
      .every((animation) => animation.playState !== 'running' && animation.playState !== 'pending')
  );
  await page.waitForFunction(() => {
    const nodes = [...document.body.querySelectorAll('*')].filter(
      (element) => !['SCRIPT', 'STYLE', 'LINK'].includes(element.tagName)
    );
    const signature = JSON.stringify(
      nodes.map((element) => {
        const rect = element.getBoundingClientRect();
        return [rect.x, rect.y, rect.width, rect.height, getComputedStyle(element).opacity];
      })
    );
    const previous = window.__mainSidebarStable || { signature: '', count: 0 };
    previous.count = previous.signature === signature ? previous.count + 1 : 0;
    previous.signature = signature;
    window.__mainSidebarStable = previous;
    return previous.count >= 3;
  });
};
try {
  for (const theme of ['light', 'dark'])
    for (const viewport of [
      { name: 'narrow', width: 320, height: 900 },
      { name: 'phone', width: 390, height: 900 },
      { name: 'desktop', width: 1280, height: 900 },
    ])
      for (const scenario of scenarios) {
        if (args.only && !new RegExp(args.only).test(scenario.name)) continue;
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: 1,
          reducedMotion: 'reduce',
          colorScheme: theme,
        });
        const page = await context.newPage();
        let currentState = 'load';
        try {
          await page.clock.setFixedTime(new Date('2026-10-22T09:00:00Z'));
          await context.route('**/*', (route) => {
            const url = route.request().url();
            if (
              url.startsWith(args.storybook) ||
              url.startsWith('data:') ||
              url.startsWith('blob:')
            )
              return route.continue();
            blockedRequests.push({ scenario: scenario.name, theme, viewport: viewport.name, url });
            return route.abort();
          });
          await page.addInitScript(() => {
            window.__mainSidebarEvents = [];
            for (const type of ['pointerdown', 'pointerup', 'contextmenu', 'click', 'keydown'])
              document.addEventListener(
                type,
                (event) =>
                  window.__mainSidebarEvents.push({
                    type,
                    key: event.key ?? null,
                    pointerType: event.pointerType ?? null,
                    trusted: event.isTrusted,
                    tag: event.target?.tagName ?? null,
                    label:
                      event.target?.getAttribute?.('aria-label') ??
                      event.target?.textContent?.trim().slice(0, 80) ??
                      null,
                  }),
                true
              );
          });
          const url = new URL('/iframe.html', args.storybook);
          url.search = new URLSearchParams({
            id: scenario.id,
            viewMode: 'story',
            globals: `theme:${theme};locale:en`,
          });
          await page.goto(url.href);
          await expect(page.locator('[data-sidebar-project-key]').first()).toBeVisible({
            timeout: 15_000,
          });
          const save = async (state, assertions = {}) => {
            currentState = state;
            await settle(page);
            const key = `${scenario.name}__${viewport.name}__${theme}__${state}`;
            const shot = `shots/${key}.png`;
            await page.screenshot({
              path: path.join(out, shot),
              animations: 'disabled',
              caret: 'hide',
            });
            entries.push({
              key,
              id: scenario.id,
              viewport: viewport.name,
              theme,
              state,
              shot,
              sha256: createHash('sha256')
                .update(await readFile(path.join(out, shot)))
                .digest('hex'),
              assertions,
              layout: await page.evaluate(inspect),
              events: await page.evaluate(() => window.__mainSidebarEvents),
              observation: await page.evaluate(() => ({
                viewport: [innerWidth, innerHeight],
                documentWidth: document.documentElement.scrollWidth,
                dialogs: document.querySelectorAll('[role="dialog"],[role="alertdialog"]').length,
                menus: document.querySelectorAll('[role="menu"]').length,
                resolvedMode: document.documentElement.classList.contains('dark')
                  ? 'dark'
                  : 'light',
                pausedInfiniteAnimations: document
                  .getAnimations()
                  .filter((animation) => animation.effect?.getTiming().iterations === Infinity)
                  .map((animation) => ({
                    target: animation.effect?.target?.tagName ?? null,
                    time: animation.currentTime,
                    state: animation.playState,
                  })),
              })),
            });
            console.log(key);
          };
          await save('rest');
          if (scenario.name === 'groups') {
            await page.getByText('Shop', { exact: true }).first().click({ button: 'right' });
            await expect(
              page.getByRole('menuitem', { name: 'Remove project', exact: true })
            ).toBeVisible();
            await save('owner-menu', { creatorRemovalPresent: true });
            await page.keyboard.press('Escape');
            await expect(page.getByRole('menu')).toHaveCount(0);
            await save('owner-escape', { menuClosed: true });
            await page.getByText('Docs site', { exact: true }).first().click({ button: 'right' });
            await expect(
              page.getByRole('menuitem', { name: 'Edit project…', exact: true })
            ).toBeVisible();
            await expect(
              page.getByRole('menuitem', { name: 'Remove project', exact: true })
            ).toHaveCount(0);
            await save('teammate-menu', { creatorOnlyRemovalAbsent: true, editAvailable: true });
            await page.keyboard.press('Escape');
            await expect(page.getByRole('menu')).toHaveCount(0);
            await save('teammate-escape', { menuClosed: true });
            const local = page.locator('[data-sidebar-project-key="machine-studio:proj-lody"]');
            await local.hover();
            const newChat = local.getByRole('button', { name: 'New chat', exact: true });
            await expect(newChat).toBeVisible();
            await newChat.click();
            await expect(page.getByRole('dialog')).toHaveCount(0);
            await save('local-new-chat-affordance', {
              trustedClick: true,
              callbackFixture: 'Existing no-op callback; no mutation outcome claimed.',
            });
            await local.click({ button: 'right' });
            await expect(
              page.getByRole('menuitem', { name: 'Remove folder', exact: true })
            ).toBeVisible();
            await save('local-menu', { removeFolderVisible: true });
            await page.getByRole('menuitem', { name: 'Remove folder', exact: true }).click();
            await expect(page.getByRole('menu')).toHaveCount(0);
            await expect(page.getByRole('dialog')).toHaveCount(0);
            await expect(page.getByRole('alertdialog')).toHaveCount(0);
            await save('local-removal-no-confirmation', {
              oldConfirmationAbsent: true,
              callbackFixture:
                'Existing onRequestRemoval is no-op. Does not prove durable remove mutation or router behavior.',
            });
          } else if (scenario.name === 'projects') {
            const newSession = page
              .getByRole('button', { name: 'New session', exact: true })
              .first();
            await newSession.locator('xpath=ancestor::*[@data-session-list-group][1]').hover();
            await newSession.click();
            await expect(page.getByText('New chat task', { exact: true })).toBeVisible();
            await save('new-chat-created-in-existing-story', {
              realFixtureListUpdated: true,
              backendMutation: false,
            });
          } else {
            const local = page.locator(
              '[data-sidebar-project-key="machine-mac-studio:local-project-lody"]'
            );
            await expect(local).toHaveAttribute('aria-disabled', 'true');
            await expect(
              page.getByText('完善移除项目的 UX', { exact: true }).first()
            ).toBeVisible();
            await expect(page.getByText('清理本地 worktree', { exact: true })).toBeVisible();
            const pendingBounds = await local.boundingBox();
            assert.ok(pendingBounds);
            await page.mouse.click(
              pendingBounds.x + pendingBounds.width / 2,
              pendingBounds.y + pendingBounds.height / 2
            );
            await expect(page.getByRole('dialog')).toHaveCount(0);
            await save('pending-still-readable', {
              projectInert: true,
              twoExistingSessionsReadable: true,
              oldConfirmationAbsent: true,
            });
          }
        } catch (error) {
          failures.push({
            scenario: scenario.name,
            viewport: viewport.name,
            theme,
            state: currentState,
            message: String(error.stack ?? error),
          });
          await page
            .screenshot({
              path: path.join(out, `failure-${scenario.name}-${viewport.name}-${theme}.png`),
              caret: 'hide',
            })
            .catch(() => {});
          console.error(scenario.name, viewport.name, theme, error.message);
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
      expected: args.only ? null : 84,
      animationPolicy:
        'Reduced motion; infinite WAAPI animations paused at time zero on their real targets before settled captures. No product CSS or DOM replacement.',
      blockedRequests,
      entries,
    },
    null,
    2
  ) + '\n'
);
await writeFile(path.join(out, 'failures.json'), JSON.stringify(failures, null, 2) + '\n');
assert.equal(failures.length, 0);
if (!args.only) assert.equal(entries.length, 84);
console.log(`Captured ${entries.length}, failures0`);
