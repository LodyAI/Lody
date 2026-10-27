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
const storyIndex = await (await fetch(new URL('/index.json', args.storybook))).text();
const buildFingerprint = createHash('sha256').update(iframe).update(storyIndex).digest('hex');
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
    'scrollbarWidth',
    'maskImage',
    'WebkitMaskImage',
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
        ['::before', '::after', '::-webkit-scrollbar'].map((selector) => {
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
                'scrollbarWidth',
                'maskImage',
                'WebkitMaskImage',
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
const scenarios = [
  { name: 'basic', story: 'basic', width: 1280 },
  { name: 'root', story: 'basic', width: 1280 },
  { name: 'subtree', story: 'subtree-variables', width: 1280 },
  { name: 'flex-last', story: 'caller-flex-last', width: 1280 },
  { name: 'hidden-last', story: 'caller-hidden-last', width: 1280 },
  { name: 'overflow', story: 'overflow', width: 1280 },
  { name: 'portal', story: 'portalled', width: 1280 },
  ...[927, 928, 929].map((width) => ({ name: `boundary-${width}`, story: 'basic', width })),
  { name: 'touch', story: 'basic', width: 1280, touch: true },
];
const settle = async (page) => {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => {
    if (
      document
        .getAnimations()
        .some(
          (a) =>
            a.effect?.getTiming().iterations !== Infinity &&
            ['running', 'pending'].includes(a.playState)
        )
    )
      return false;
    const signature = JSON.stringify(
      [...document.body.querySelectorAll('*')]
        .filter((e) => !['SCRIPT', 'STYLE', 'LINK'].includes(e.tagName))
        .map((e) => {
          const r = e.getBoundingClientRect(),
            s = getComputedStyle(e);
          return [
            e.tagName,
            r.x,
            r.y,
            r.width,
            r.height,
            s.backgroundColor,
            s.opacity,
            s.transform,
            s.maskImage,
          ];
        })
    );
    const state = window.__outlineRailStable ?? { signature: '', count: 0 };
    state.count = state.signature === signature ? state.count + 1 : 0;
    state.signature = signature;
    window.__outlineRailStable = state;
    return state.count >= 3;
  });
};
try {
  for (const theme of ['light', 'dark'])
    for (const scenario of scenarios) {
      if (args.only && !new RegExp(args.only).test(scenario.name)) continue;
      const context = await browser.newContext({
        viewport: { width: scenario.width, height: 700 },
        deviceScaleFactor: 1,
        hasTouch: Boolean(scenario.touch),
        isMobile: Boolean(scenario.touch),
        reducedMotion: ['root', 'subtree'].includes(scenario.name) ? 'no-preference' : 'reduce',
        colorScheme: theme,
      });
      const page = await context.newPage();
      const id = `sessions-ownedoutlinerailmigration--${scenario.story}`;
      let currentState = 'load';
      try {
        await page.clock.setFixedTime(new Date('2026-10-22T09:00:00Z'));
        await page.addInitScript(() => {
          window.__outlineRailEvents = [];
          for (const type of [
            'pointerdown',
            'pointerup',
            'pointerover',
            'pointerout',
            'keydown',
            'click',
            'focusin',
          ])
            document.addEventListener(
              type,
              (event) => {
                const target = event.target;
                window.__outlineRailEvents.push({
                  type,
                  trusted: event.isTrusted,
                  key: event.key ?? null,
                  pointerType: event.pointerType ?? null,
                  tag: target?.tagName ?? null,
                  tick:
                    target?.closest?.('[data-outline-index]')?.getAttribute('data-outline-index') ??
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
        await page.mouse.move(-10, -10);
        await page.goto(url.href);
        await page.waitForFunction(
          () => window.__STORYBOOK_PREVIEW__?.currentRender?.phase === 'finished'
        );
        const fixture = page.locator('[data-outline-fixture]');
        await expect(fixture).toBeVisible();
        if (scenario.name === 'root')
          await page.evaluate(() => {
            document.documentElement.style.setProperty('--muted-foreground', '280 80% 42%');
            document.documentElement.style.setProperty('--foreground', '175 70% 30%');
          });
        const rail = page.getByRole('navigation', { name: 'Conversation outline' });
        const firstIndex = scenario.name === 'overflow' ? 70 : 0;
        const hoverIndex = scenario.name === 'overflow' ? 70 : 1;
        const nextIndex = scenario.name === 'overflow' ? 71 : 2;
        const tick = (index) => page.locator(`[data-outline-index="${index}"]`);
        const save = async (state, assertions = {}) => {
          currentState = state;
          await settle(page);
          const key = `${scenario.name}__${theme}__${state}`,
            shot = `shots/${key}.png`;
          await page.screenshot({
            path: path.join(out, shot),
            animations: 'disabled',
            caret: 'hide',
          });
          const bytes = await readFile(path.join(out, shot));
          entries.push({
            key,
            id,
            viewport: scenario.name,
            theme,
            state,
            shot,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            assertions,
            layout: await page.evaluate(inspect),
            events: await page.evaluate(() => window.__outlineRailEvents),
            observation: await page.evaluate(() => ({
              viewport: [innerWidth, innerHeight],
              documentWidth: document.documentElement.scrollWidth,
              activeTag: document.activeElement?.tagName,
              activeTick: document.activeElement?.getAttribute('data-outline-index'),
              lastJump: document.querySelector('[data-outline-fixture]').dataset.lastJump,
              lastPreview: document.querySelector('[data-outline-fixture]').dataset.lastPreview,
              hoverMedia: matchMedia('(hover: hover)').matches,
              reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
              scroll: [...document.querySelectorAll('nav > div')].map((e) => ({
                top: e.scrollTop,
                height: e.clientHeight,
                fullHeight: e.scrollHeight,
                scrollbarWidth: getComputedStyle(e).scrollbarWidth,
                scrollbarDisplay: getComputedStyle(e, '::-webkit-scrollbar').display,
              })),
            })),
          });
          console.log(key);
        };
        if (scenario.name.startsWith('boundary-')) {
          const expected = scenario.width >= 928 ? 'flex' : 'none';
          await expect(page.locator('nav')).toHaveCSS('display', expected);
          await save('boundary-rest', { display: expected, exactContainerWidth: scenario.width });
          continue;
        }
        await expect(rail).toBeVisible();
        if (scenario.touch) {
          await save('touch-rest', { touch: true });
          await tick(1).tap();
          await expect(fixture).toHaveAttribute('data-last-jump', '1');
          await expect(fixture).toHaveAttribute('data-last-preview', '-1');
          await save('touch-jump', { jump: 1, hoverPreviewAbsent: true });
          continue;
        }
        await fixture.focus();
        await page.mouse.move(scenario.width - 30, 570);
        await save('outer-marker-rest', { unrelatedOuterMarker: true });
        await tick(firstIndex).focus();
        await tick(firstIndex).press('ArrowDown');
        await expect(tick(firstIndex + 1)).toBeFocused();
        await save('keyboard-focus', { focusedIndex: firstIndex + 1 });
        await tick(firstIndex + 1).press('Enter');
        await expect(fixture).toHaveAttribute('data-last-jump', String(firstIndex + 1));
        await save('keyboard-jump', { jump: firstIndex + 1 });
        await tick(hoverIndex).hover();
        await expect(fixture).toHaveAttribute('data-last-preview', String(hoverIndex));
        await save('hover-preview', { preview: hoverIndex });
        await tick(nextIndex).hover();
        await expect(fixture).toHaveAttribute('data-last-preview', String(nextIndex));
        if (scenario.name !== 'overflow')
          await expect(page.getByText('Started by the agent.', { exact: true })).toBeVisible();
        await save('hover-fallback', {
          preview: nextIndex,
          fallback: scenario.name !== 'overflow',
        });
        await tick(nextIndex).click();
        await expect(fixture).toHaveAttribute('data-last-jump', String(nextIndex));
        await page.mouse.move(scenario.width - 30, 570);
        await save('pointer-jump', { jump: nextIndex });
        if (scenario.name === 'overflow') {
          await tick(nextIndex).press('End');
          await expect(tick(99)).toBeFocused();
          await save('overflow-end', { focusedIndex: 99 });
        }
      } catch (error) {
        failures.push({
          scenario: scenario.name,
          theme,
          state: currentState,
          message: String(error.stack ?? error),
        });
        await page
          .screenshot({
            path: path.join(out, `failure-${scenario.name}-${theme}.png`),
            caret: 'hide',
          })
          .catch(() => {});
        console.error(scenario.name, theme, error.message);
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
      expected: args.only ? null : 96,
      entries,
    },
    null,
    2
  ) + '\n'
);
await writeFile(path.join(out, 'failures.json'), JSON.stringify(failures, null, 2) + '\n');
assert.equal(failures.length, 0);
if (!args.only) assert.equal(entries.length, 96);
console.log(`Captured ${entries.length}, failures0`);
