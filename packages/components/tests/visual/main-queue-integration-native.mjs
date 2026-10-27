import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices, expect } from '@playwright/test';
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

const properties = [
  'display',
  'position',
  'width',
  'height',
  'minWidth',
  'maxWidth',
  'minHeight',
  'maxHeight',
  'flex',
  'flexBasis',
  'flexGrow',
  'flexShrink',
  'flexDirection',
  'flexWrap',
  'gridTemplateColumns',
  'gridColumn',
  'gridRow',
  'alignItems',
  'justifyContent',
  'gap',
  'rowGap',
  'columnGap',
  'margin',
  'padding',
  'borderWidth',
  'borderStyle',
  'borderColor',
  'borderRadius',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'color',
  'backgroundColor',
  'opacity',
  'overflow',
  'overflowX',
  'overflowY',
  'overflowWrap',
  'whiteSpace',
  'textOverflow',
  'boxShadow',
  'outline',
  'outlineOffset',
  'transform',
  'transformOrigin',
  'transitionProperty',
  'transitionDuration',
  'transitionTimingFunction',
  'pointerEvents',
  'cursor',
  'webkitLineClamp',
  'strokeWidth',
];
const inspect = (keys) =>
  [...document.querySelectorAll('body *')]
    .filter((element) => !['SCRIPT', 'STYLE', 'LINK'].includes(element.tagName))
    .map((element, itemIndex) => {
      const css = getComputedStyle(element),
        rect = element.getBoundingClientRect();
      return {
        path: String(itemIndex),
        tag: element.tagName,
        text: element.textContent?.trim().slice(0, 160),
        role: element.getAttribute('role'),
        label: element.getAttribute('aria-label'),
        rect: [rect.x, rect.y, rect.width, rect.height],
        styles: Object.fromEntries(keys.map((key) => [key, css[key]])),
        active: document.activeElement === element,
        focusVisible: element.matches(':focus-visible'),
        disabled: 'disabled' in element ? element.disabled : null,
        value:
          element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
            ? element.value
            : null,
        scroll: [element.scrollLeft, element.scrollTop, element.scrollWidth, element.clientWidth],
        image:
          element instanceof HTMLImageElement
            ? { complete: element.complete, natural: [element.naturalWidth, element.naturalHeight] }
            : null,
      };
    });
const settle = async (page) => {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => [...document.images].every((image) => image.complete));
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
      .every((animation) => animation.playState !== 'running')
  );
  await page.evaluate(async () => {
    const animations = document
      .getAnimations()
      .filter((animation) => animation.effect?.getTiming().iterations === Infinity);
    for (const animation of animations) animation.pause();
    await Promise.all(animations.map((animation) => animation.ready));
    for (const animation of animations) animation.currentTime = 0;
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    delete window.__queueMergeStable;
  });
  await page.waitForFunction((keys) => {
    const value = JSON.stringify(
      [
        ...document.querySelectorAll(
          '.group\\/row,.group\\/row *,[role="menu"],[role="menu"] *,[role="dialog"],[role="dialog"] *'
        ),
      ].map((element) => [
        element.getBoundingClientRect().toJSON(),
        keys.map((key) => getComputedStyle(element)[key]),
        element.scrollLeft,
        element.scrollTop,
      ])
    );
    const prior = window.__queueMergeStable ?? { value: '', count: 0 };
    prior.count = prior.value === value ? prior.count + 1 : 0;
    prior.value = value;
    window.__queueMergeStable = prior;
    return prior.count >= 4;
  }, properties);
};
const entries = [],
  failures = [],
  browserErrors = [],
  externalRequests = [];
try {
  for (const viewport of [
    { name: 'desktop', width: 1280, height: 900 },
    { name: 'phone390', width: 390, height: 844, device: 'iPhone 13' },
    { name: 'phone320', width: 320, height: 720, device: 'iPhone SE' },
  ])
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        ...(viewport.device ? devices[viewport.device] : {}),
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
        colorScheme: theme,
        reducedMotion: 'reduce',
        timezoneId: 'Asia/Shanghai',
      });
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (
          ['http:', 'https:'].includes(url.protocol) &&
          !['127.0.0.1', 'localhost'].includes(url.hostname)
        ) {
          externalRequests.push(url.origin + url.pathname);
          return route.abort();
        }
        return route.continue();
      });
      for (const scenario of viewport.device ? ['scheduled'] : ['scheduled', 'deferred']) {
        if (args.only && !new RegExp(args.only).test(`${scenario}__${viewport.name}__${theme}`))
          continue;
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        page.on('pageerror', (error) => browserErrors.push(String(error)));
        const id =
          scenario === 'scheduled'
            ? 'chat-chatcomposer--queued-scheduled-message'
            : 'sessions-messagequeuedisplay--deferred-editing';
        const rows = () => page.locator('.group\\/row');
        const press = async (locator) => (viewport.device ? locator.tap() : locator.click());
        const shot = async (state, assertions = {}) => {
          await settle(page);
          const key = `${id}__${viewport.name}__${theme}__${state}`;
          await page.screenshot({
            path: path.join(out, 'shots', key + '.png'),
            animations: 'allow',
            caret: 'hide',
          });
          entries.push({
            key,
            id,
            viewport: viewport.name,
            theme,
            state,
            shot: `shots/${key}.png`,
            assertions,
            layout: await page.evaluate(inspect, properties),
            events: await page.evaluate(() => window.__queueMergeEvents),
            observation: await page.evaluate(() => ({
              rows: [...document.querySelectorAll('.group\\/row')].map(
                (element) => element.textContent
              ),
              viewport: [innerWidth, innerHeight],
              documentWidth: document.documentElement.scrollWidth,
              media: {
                hover: matchMedia('(hover:hover)').matches,
                pointerCoarse: matchMedia('(pointer:coarse)').matches,
                reducedMotion: matchMedia('(prefers-reduced-motion:reduce)').matches,
              },
            })),
          });
          console.log(key);
        };
        try {
          await page.addInitScript(() => {
            const OriginalDate = Date;
            const instant = Date.parse('2026-10-27T08:00:00Z');
            window.Date = class extends OriginalDate {
              constructor(...dateArgs) {
                super(...(dateArgs.length ? dateArgs : [instant]));
              }
              static now() {
                return instant;
              }
            };
            window.__queueMergeEvents = [];
            for (const type of ['pointerdown', 'pointerup', 'click', 'keydown'])
              document.addEventListener(
                type,
                (event) => {
                  if (event.target instanceof Element)
                    window.__queueMergeEvents.push({
                      type,
                      trusted: event.isTrusted,
                      key: event.key ?? null,
                      pointerType: event.pointerType ?? null,
                      target: event.target.tagName,
                      label: event.target.getAttribute('aria-label'),
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
          await page.waitForFunction(
            () => window.__STORYBOOK_PREVIEW__?.currentRender?.phase === 'finished'
          );
          await expect(page.locator('[data-message-queue-toggle]')).toBeVisible();
          await settle(page);
          await shot('rest');
          if (scenario === 'scheduled') {
            await expect(rows()).toHaveCount(3);
            const ordinary = rows().filter({ hasText: '先检查测试结果' }),
              scheduled = rows().filter({ hasText: 'continue' });
            await expect(
              scheduled.getByRole('button', { name: 'Drag to reorder', exact: true })
            ).toHaveCount(0);
            await expect(scheduled.getByRole('button', { name: 'Steer', exact: true })).toHaveCount(
              0
            );
            if (viewport.device) {
              await press(ordinary.getByRole('button', { name: 'More', exact: true }));
              await expect(
                page.getByRole('menuitem', { name: 'Move to top', exact: true })
              ).toBeDisabled();
              await shot('ordinary-more-head-disabled');
              await page.keyboard.press('Escape');
              await press(scheduled.getByRole('button', { name: 'More', exact: true }));
              await expect(
                page.getByRole('menuitem', { name: 'Move to top', exact: true })
              ).toHaveCount(0);
              await shot('scheduled-more-no-move');
              await press(page.getByRole('menuitem', { name: 'Edit', exact: true }));
            } else {
              await scheduled.hover();
              await shot('scheduled-hover');
              await scheduled
                .getByRole('button', { name: 'Edit queued message', exact: true })
                .click();
            }
            const edit = page.getByRole('textbox', { name: 'Edit queued message', exact: true });
            await expect(edit).toBeFocused();
            await edit.fill('Synthetic scheduled message edited 中文');
            await shot('scheduled-edit');
            await edit.press('Enter');
            await expect(edit).toHaveCount(0);
            await expect(
              rows().filter({ hasText: 'Synthetic scheduled message edited 中文' })
            ).toHaveCount(1);
            await shot('scheduled-saved');
            const edited = rows().filter({ hasText: 'Synthetic scheduled message edited 中文' });
            await press(edited.getByRole('button', { name: '10/27 21:00 发送', exact: true }));
            await expect(
              page.getByRole('button', { name: '30 分钟后', exact: true })
            ).toBeVisible();
            await shot('time-editor-open', { mobileDialog: Boolean(viewport.device) });
            await press(page.getByRole('button', { name: '30 分钟后', exact: true }));
            await press(page.getByRole('button', { name: '确定', exact: true }));
            await expect(
              edited.getByRole('button', { name: '10/27 16:30 发送', exact: true })
            ).toBeVisible();
            await shot('time-edited', { time: '2026-10-27T16:30', scheduledStillNoDrag: true });
            if (viewport.device) {
              const composer = page.locator('textarea').last();
              await composer.fill('Synthetic ordinary second row');
              await press(page.getByRole('button', { name: '加入预览队列', exact: true }));
              await expect(rows()).toHaveCount(4);
              await shot('ordinary-added');
              const second = rows().filter({ hasText: 'Synthetic ordinary second row' });
              await press(second.getByRole('button', { name: 'More', exact: true }));
              await expect(
                page.getByRole('menuitem', { name: 'Move to top', exact: true })
              ).toBeEnabled();
              await shot('ordinary-more-move-enabled');
              await press(page.getByRole('menuitem', { name: 'Move to top', exact: true }));
              await expect(rows().first()).toContainText('Synthetic ordinary second row');
              await shot('ordinary-moved-to-top');
              await press(edited.getByRole('button', { name: 'More', exact: true }));
              await press(page.getByRole('menuitem', { name: 'Delete', exact: true }));
            } else
              await edited.getByRole('button', { name: 'Remove from queue', exact: true }).click();
            await expect(rows()).toHaveCount(viewport.device ? 3 : 2);
            await expect(
              rows().filter({ hasText: 'Synthetic scheduled message edited 中文' })
            ).toHaveCount(0);
            await shot('scheduled-deleted');
            if (viewport.device)
              assert.ok(
                (await page.evaluate(() => window.__queueMergeEvents)).some(
                  (event) => event.trusted && event.pointerType === 'touch'
                )
              );
          } else {
            await expect(rows()).toHaveCount(2);
            await rows()
              .first()
              .getByRole('button', { name: 'Edit queued message', exact: true })
              .click();
            const edit = page.getByRole('textbox', { name: 'Edit queued message', exact: true });
            await edit.fill('Synthetic first pending save');
            await shot('first-edit');
            await edit.press('Enter');
            await expect(edit).toBeDisabled();
            await shot('first-save-pending');
            await rows()
              .nth(1)
              .getByRole('button', { name: 'Edit queued message', exact: true })
              .click();
            await expect(
              page.getByRole('textbox', { name: 'Edit queued message', exact: true })
            ).toBeEnabled();
            await page
              .getByRole('textbox', { name: 'Edit queued message', exact: true })
              .fill('Synthetic second draft retained');
            await shot('second-edit-before-ack');
            await page.evaluate(() =>
              window.dispatchEvent(new Event('storybook:release-queue-save'))
            );
            await expect(
              page.getByRole('textbox', { name: 'Edit queued message', exact: true })
            ).toHaveValue('Synthetic second draft retained');
            await shot('second-edit-after-ack');
            await page
              .getByRole('textbox', { name: 'Edit queued message', exact: true })
              .press('Enter');
            await expect(
              page.getByRole('textbox', { name: 'Edit queued message', exact: true })
            ).toHaveCount(0);
            await expect(rows().nth(1)).toContainText('Synthetic second draft retained');
            await shot('second-saved');
          }
        } catch (error) {
          failures.push({
            id,
            viewport: viewport.name,
            theme,
            message: String(error),
            diagnostic: await page
              .evaluate(() => ({
                text: document.body.innerText.slice(-2000),
                events: window.__queueMergeEvents,
              }))
              .catch(() => null),
          });
          await page
            .screenshot({
              path: path.join(out, `failure-${scenario}-${viewport.name}-${theme}.png`),
            })
            .catch(() => {});
        } finally {
          await page.close();
        }
      }
      await context.close();
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
        externalRequests,
      },
      null,
      2
    )
  );
}
assert.equal(failures.length, 0, JSON.stringify(failures));
assert.equal(browserErrors.length, 0);
assert.equal(externalRequests.length, 0);
