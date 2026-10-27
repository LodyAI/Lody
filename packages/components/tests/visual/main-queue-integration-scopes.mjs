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
    .flatMap((value, index, all) =>
      value.startsWith('--') ? [[value.slice(2), all[index + 1]]] : []
    )
);
assert.ok(args.phase && args.storybook, '--phase and --storybook required');
const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(pkg, 'artifacts/visual', args.phase);
await mkdir(path.join(out, 'shots'), { recursive: true });
const iframe = await (await fetch(new URL('/iframe.html', args.storybook))).text(),
  index = await (await fetch(new URL('/index.json', args.storybook))).text();
assert.ok(!iframe.includes('/@vite/client'), 'immutable build required');
const buildFingerprint = createHash('sha256').update(iframe).update(index).digest('hex');
const browser = await (async () => {
  try {
    return await chromium.launch();
  } catch (error) {
    const dir = path.join(os.homedir(), 'Library/Caches/ms-playwright');
    const candidates = existsSync(dir)
      ? (await readdir(dir))
          .flatMap((entry) => {
            const match = /^chromium_headless_shell-(\d+)$/.exec(entry);
            const shell = path.join(
              dir,
              entry,
              'chrome-headless-shell-mac-arm64/chrome-headless-shell'
            );
            return match && existsSync(shell) ? [{ shell, revision: Number(match[1]) }] : [];
          })
          .sort((a, b) => b.revision - a.revision)
      : [];
    if (!candidates.length) throw error;
    return chromium.launch({ executablePath: candidates[0].shell });
  }
})();

const entries = [],
  failures = [],
  browserErrors = [];
const properties = [
  'color',
  'backgroundColor',
  'borderColor',
  'boxShadow',
  'fontSize',
  'lineHeight',
  'transitionProperty',
  'padding',
  'gap',
  'width',
  'height',
];
const variables = {
  '--foreground': '281 50% 35%',
  '--muted-foreground': '166 55% 34%',
  '--hover': '44 75% 88%',
  '--ring': '315 70% 42%',
  '--destructive': '355 70% 38%',
  '--background': '220 60% 96%',
  '--border': '205 60% 50%',
};
const settle = async (page) => {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .filter((a) => a.effect?.getTiming().iterations !== Infinity)
      .every((a) => a.playState !== 'running')
  );
  await page.evaluate(() => delete window.__queueScopeStable);
  await page.waitForFunction(() => {
    const value = JSON.stringify(
      [...document.querySelectorAll('[class~="group/row"],[class~="group/row"] *')].map((e) => [
        e.getBoundingClientRect().toJSON(),
        getComputedStyle(e).color,
        getComputedStyle(e).backgroundColor,
        getComputedStyle(e).boxShadow,
      ])
    );
    const state = window.__queueScopeStable ?? { value: '', count: 0 };
    state.count = state.value === value ? state.count + 1 : 0;
    state.value = value;
    window.__queueScopeStable = state;
    return state.count >= 4;
  });
};
try {
  for (const theme of ['light', 'dark'])
    for (const scope of ['default', 'root', 'subtree']) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        colorScheme: theme,
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.on('pageerror', (e) => browserErrors.push(String(e)));
      try {
        const id = 'sessions-messagequeuedisplay--few-items',
          url = new URL('/iframe.html', args.storybook);
        url.search = new URLSearchParams({
          id,
          viewMode: 'story',
          globals: `theme:${theme};locale:en`,
        });
        await page.goto(url.href);
        await page.waitForFunction(
          () => window.__STORYBOOK_PREVIEW__?.currentRender?.phase === 'finished'
        );
        const first = page.locator('[class~="group/row"]').first();
        await first.waitFor();
        if (scope !== 'default')
          await page.evaluate(
            ({ scope: injectedScope, variables: injectedVariables }) => {
              const node =
                injectedScope === 'root'
                  ? document.documentElement
                  : document.querySelector('[class~="group/row"]');
              for (const [k, v] of Object.entries(injectedVariables)) node.style.setProperty(k, v);
            },
            { scope, variables }
          );
        const shot = async (state) => {
          await settle(page);
          const key = `queue-scope__${theme}__${scope}__${state}`;
          await page.screenshot({
            path: path.join(out, 'shots', key + '.png'),
            animations: 'disabled',
            caret: 'hide',
          });
          entries.push({
            id,
            key,
            theme,
            scope,
            state,
            shot: `shots/${key}.png`,
            variables: scope === 'default' ? null : variables,
            layout: await page.evaluate(
              (keys) =>
                [...document.querySelectorAll('[class~="group/row"],[class~="group/row"] *')].map(
                  (e, i) => {
                    const css = getComputedStyle(e),
                      r = e.getBoundingClientRect();
                    return {
                      path: String(i),
                      tag: e.tagName,
                      text: e.textContent?.trim().slice(0, 100),
                      label: e.getAttribute('aria-label'),
                      rect: [r.x, r.y, r.width, r.height],
                      styles: Object.fromEntries(keys.map((k) => [k, css[k]])),
                    };
                  }
                ),
              properties
            ),
          });
          console.log(key);
        };
        await shot('rest');
        await first.getByRole('button', { name: 'Drag to reorder', exact: true }).hover();
        await shot('handle-hover');
        await first
          .getByRole('button', { name: 'Steer the active response with this message', exact: true })
          .hover();
        await shot('steer-hover');
        await first.getByRole('button', { name: 'Edit queued message', exact: true }).click();
        await expect(
          page.getByRole('textbox', { name: 'Edit queued message', exact: true })
        ).toBeFocused();
        await shot('editor-focus');
      } catch (error) {
        failures.push({ scope, theme, message: String(error) });
      } finally {
        await context.close();
      }
    }
} finally {
  const browserVersion = browser.version();
  await browser.close();
  await writeFile(
    path.join(out, 'manifest.json'),
    JSON.stringify(
      {
        phase: args.phase,
        storybook: args.storybook,
        buildFingerprint,
        browserVersion,
        harnessSha256: createHash('sha256')
          .update(await readFile(fileURLToPath(import.meta.url)))
          .digest('hex'),
        entries,
        failures,
        browserErrors,
      },
      null,
      2
    )
  );
}
assert.equal(failures.length, 0, JSON.stringify(failures));
assert.equal(browserErrors.length, 0);
