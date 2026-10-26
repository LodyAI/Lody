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
      .filter((a) => a.effect?.getTiming().iterations !== Infinity)
      .every((a) => a.playState !== 'running')
  );
  await page.evaluate(() => {
    window.__markdownLinksStable = { value: '', count: 0 };
  });
  await page.waitForFunction(
    () => {
      const value = JSON.stringify(
        [
          ...document.querySelectorAll(
            '[data-markdown-links-fixture], [data-markdown-links-fixture] *,[role="menu"], [role="menu"] *'
          ),
        ].map((e) => e.getBoundingClientRect().toJSON())
      );
      const state = window.__markdownLinksStable;
      state.count = state.value === value ? state.count + 1 : 0;
      state.value = value;
      return state.count >= 3;
    },
    undefined,
    { polling: 100 }
  );
};
const entries = [],
  failures = [];
let expected = 0;
const bodySelector = '.markdown-renderer button[title="./body.tsx#L8"]';
const prSelector =
  '.markdown-reference-chip[href="https://github.com/synthetic-owner/synthetic-repo/pull/42"]';
try {
  for (const viewport of [
    { name: 'desktop', width: 960, height: 1000, touch: false },
    { name: 'phone-touch', width: 390, height: 1000, touch: true },
  ])
    for (const theme of ['light', 'dark']) {
      const scenarios = viewport.touch
        ? ['copy', 'open', 'scope', 'readonly']
        : ['copy', 'open', 'menu'];
      for (const scenario of scenarios) {
        const key = `${scenario}__${viewport.name}__${theme}`;
        if (args.only && !new RegExp(args.only).test(key)) continue;
        const count = { copy: 6, open: 3, menu: 3, scope: 2, readonly: 1 }[scenario];
        expected += count;
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: 1,
          hasTouch: viewport.touch,
          isMobile: viewport.touch,
          colorScheme: theme,
          reducedMotion: 'reduce',
        });
        const externalRequests = [];
        await context.route('**/*', async (route) => {
          const url = new URL(route.request().url());
          if (
            url.origin === new URL(args.storybook).origin ||
            ['data:', 'blob:'].includes(url.protocol)
          ) {
            await route.continue();
            return;
          }
          externalRequests.push(url.href);
          await route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: '<!doctype html><title>Intercepted synthetic external navigation</title><p>Intercepted synthetic external navigation</p>',
          });
        });
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        let clockPaused = false;
        try {
          await page.clock.install({ time: new Date('2026-10-22T09:00:00Z') });
          await page.addInitScript(() => {
            window.__markdownLinksEvents = [];
            for (const type of ['pointerdown', 'pointerup', 'keydown', 'contextmenu'])
              document.addEventListener(
                type,
                (event) =>
                  window.__markdownLinksEvents.push({
                    type,
                    trusted: event.isTrusted,
                    key: event.key ?? null,
                    pointerType: event.pointerType ?? null,
                    target:
                      event.target.closest?.('[title]')?.getAttribute('title') ??
                      event.target.getAttribute?.('aria-label') ??
                      event.target.tagName,
                  }),
                true
              );
          });
          const suffix = {
            copy: 'copy-links',
            open: 'open-links',
            menu: 'context-menus',
            scope: 'scoped-caller-overrides',
            readonly: 'read-only',
          }[scenario];
          const id = `components-ownedmarkdownlinksmigration--${suffix}`;
          const url = new URL('/iframe.html', args.storybook);
          url.search = new URLSearchParams({
            id,
            viewMode: 'story',
            globals: `theme:${theme};locale:en`,
          });
          await page.goto(url.href);
          await expect(page.locator('[data-markdown-links-fixture]')).toBeVisible();
          await expect(page.locator('[data-markdown-table]')).toBeVisible();
          await settle(page);
          assert.equal(await page.locator('a[href^="javascript:"],a[href^="data:"]').count(), 0);
          const body = page.locator(bodySelector),
            pr = page.locator(prSelector),
            result = page.locator('[data-markdown-links-result]');
          const press = async (locator) => (viewport.touch ? locator.tap() : locator.click());
          const shot = async (state, assertions = {}) => {
            if (clockPaused) {
              await page.clock.runFor(96);
            } else await settle(page);
            const name = `${key}__${state}`,
              shotPath = `shots/${name}.png`;
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
              events: await page.evaluate(() => window.__markdownLinksEvents),
              externalRequests: [...externalRequests],
              observation: await page.evaluate(() => ({
                viewport: [innerWidth, innerHeight],
                documentWidth: document.documentElement.scrollWidth,
                scroll: [scrollX, scrollY],
                pointerCoarse: matchMedia('(pointer:coarse)').matches,
                hover: matchMedia('(hover:hover)').matches,
                clipboardResult: document.querySelector('[data-markdown-links-result]').textContent,
              })),
            });
            console.log(name);
          };
          const pause = async () => {
            await page.clock.pauseAt(await page.evaluate(() => Date.now() + 16));
            clockPaused = true;
          };
          if (scenario === 'copy') {
            await shot('rest', { unsafeUrlsRemoved: true });
            await body.focus();
            await body.press('Tab');
            await shot('keyboard-focus', { keyboardUsed: true });
            await press(body);
            await expect(result).toHaveText('Copy pending: ./body.tsx#L8');
            await expect(body.locator('.lucide-copy')).toHaveCount(1);
            await shot('copy-pending', { copied: false, payload: './body.tsx#L8' });
            await pause();
            await page.evaluate(() =>
              window.dispatchEvent(
                new CustomEvent('markdown-links-clipboard-settle', { detail: 'resolve' })
              )
            );
            await page.clock.runFor(32);
            await expect(body.locator('.lucide-check')).toHaveCount(1);
            await shot('copy-success', {
              copied: true,
              payload: './body.tsx#L8',
              clock: 'paused before response, advanced32ms',
            });
            await page.clock.runFor(1200);
            await expect(body.locator('.lucide-copy')).toHaveCount(1);
            await expect(body.locator('.lucide-check')).toHaveCount(0);
            await shot('copy-reset', {
              copied: false,
              clock: 'advanced1200ms through real feedback timer',
            });
            await page.clock.resume();
            clockPaused = false;
            await press(body);
            await expect(result).toHaveText('Copy pending: ./body.tsx#L8');
            await pause();
            await page.evaluate(() =>
              window.dispatchEvent(
                new CustomEvent('markdown-links-clipboard-settle', { detail: 'reject' })
              )
            );
            await page.clock.runFor(32);
            await expect(result).toHaveText('Copy rejected: ./body.tsx#L8');
            await expect(body.locator('.lucide-check')).toHaveCount(0);
            await expect(page.locator('textarea')).toHaveCount(0);
            await shot('copy-rejected', { copied: false, fallbackTextAreaRemoved: true });
          } else if (scenario === 'open') {
            await press(body);
            await expect(result).toHaveText('Opened: ./body.tsx#L8');
            await shot('file-opened', { href: './body.tsx#L8', clipboardUntouched: true });
            await press(pr);
            await expect(result).toHaveText('PR opened: synthetic #42');
            await shot('pr-opened', { interceptedInApp: true });
            const article = page.getByRole('link', { name: 'ordinary article', exact: true });
            await expect(article).toHaveAttribute('target', '_blank');
            await expect(article).toHaveAttribute('rel', /noopener/);
            await expect(article).toHaveAttribute('rel', /noreferrer/);
            const popupPromise = context.waitForEvent('page');
            await press(article);
            const popup = await popupPromise;
            await expect(popup.locator('body')).toContainText(
              'Intercepted synthetic external navigation'
            );
            await popup.close();
            assert.deepEqual(externalRequests, ['https://example.invalid/synthetic-article']);
            await shot('external-opened', {
              safeExternal: true,
              requestIntercepted: 'https://example.invalid/synthetic-article',
            });
          } else if (scenario === 'menu') {
            await body.click({ button: 'right' });
            await expect(
              page.getByRole('menuitem', { name: 'Record path', exact: true })
            ).toBeVisible();
            await shot('context-menu', { menuOpen: true });
            await page.getByRole('menuitem', { name: 'Open using', exact: true }).hover();
            await expect(
              page.getByRole('menuitem', { name: 'Synthetic editor', exact: true })
            ).toBeVisible();
            await shot('submenu', { submenuOpen: true });
            await page.getByRole('menuitem', { name: 'Synthetic editor', exact: true }).click();
            await expect(result).toHaveText('Editor: ./body.tsx#L8');
            await expect(page.locator('[role="menu"]')).toHaveCount(0);
            await shot('menu-selected', { href: './body.tsx#L8', menusClosed: true });
          } else if (scenario === 'scope') {
            await shot('descendant-vars', { callerOverrides: true });
            await page.evaluate(() => {
              for (const [variableName, value] of Object.entries({
                '--spacing': '0.375rem',
                '--radius-md': '21px',
                '--default-transition-duration': '250ms',
                '--default-transition-timing-function': 'ease-in',
              }))
                document.documentElement.style.setProperty(variableName, value);
            });
            await pr.focus();
            await shot('root-vars-focus', { rootAndSubtreeVars: true, callerOverrides: true });
          } else {
            assert.equal(
              await page
                .locator(
                  '.markdown-renderer button[title="./guide.md"], .markdown-renderer button[title="./header.tsx#L3"], .markdown-renderer button[title="./body.tsx#L8"]'
                )
                .count(),
              0
            );
            await expect(pr).toBeVisible();
            await shot('readonly', {
              fileActionsAbsent: true,
              ordinaryLinksRemain: true,
              unsafeUrlsRemoved: true,
            });
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
      browserVersion: browser.version(),
      entries,
    },
    null,
    2
  ) + '\n'
);
await writeFile(path.join(out, 'failures.json'), JSON.stringify(failures, null, 2) + '\n');
assert.equal(failures.length, 0);
assert.equal(entries.length, expected);
console.log(`Captured ${entries.length}/${expected}, failures ${failures.length}`);
