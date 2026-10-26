/** Real SessionList computed contracts and browser interactions complement owned-session-list screenshots. */
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
const profile = JSON.parse(
  await readFile(new URL('./owned-session-list-targets.json', import.meta.url))
);
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
  await page.evaluate(() => {
    delete window.__ownedSessionStable;
  });
  await page.waitForFunction(() => {
    const value = JSON.stringify(
      [...document.querySelectorAll('#storybook-root *, [role=menu] *, [role=dialog] *')].map(
        (node) => {
          const r = node.getBoundingClientRect(),
            s = getComputedStyle(node);
          return [
            r.x,
            r.y,
            r.width,
            r.height,
            s.transform,
            s.translate,
            s.rotate,
            s.color,
            s.backgroundColor,
            s.opacity,
            s.pointerEvents,
          ];
        }
      )
    );
    const old = window.__ownedSessionStable ?? { value: '', count: 0 };
    old.count = old.value === value ? old.count + 1 : 0;
    old.value = value;
    window.__ownedSessionStable = old;
    return old.count >= 4;
  });
};
const inspect = () =>
  [...document.querySelectorAll('#storybook-root *,[role=menu] *,[role=dialog] *')].map((node) => {
    const r = node.getBoundingClientRect(),
      css = getComputedStyle(node);
    return {
      tag: node.tagName,
      row: node.getAttribute('data-sidebar-session-id'),
      text: node.childElementCount ? '' : node.textContent,
      expanded: node.getAttribute('aria-expanded'),
      disabled: node.getAttribute('aria-disabled'),
      rect: [r.x, r.y, r.width, r.height],
      current: node.getAttribute('aria-current'),
      active: node === document.activeElement,
      input:
        node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ? node.value : null,
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
          'translate',
          'rotate',
          'transform',
          'touchAction',
          'transitionProperty',
          'transitionDuration',
          'transitionTimingFunction',
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
    else if (s.action === 'disabled') assert.equal(await l.isDisabled(), true);
    else if (s.action === 'enabled') assert.equal(await l.isEnabled(), true);
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
  await page.addInitScript(() => {
    window.__ownedSessionPointer = null;
    for (const type of ['pointermove', 'pointerdown', 'pointerup', 'pointercancel'])
      document.addEventListener(
        type,
        (event) => {
          window.__ownedSessionPointer = {
            x: event.clientX,
            y: event.clientY,
            buttons: event.buttons,
            type: event.pointerType,
            trusted: event.isTrusted,
          };
        },
        true
      );
  });
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
  await page.locator('#storybook-root').waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('#storybook-root img')].every((img) => img.complete)
  );
  await page.mouse.move(0, 0);
  await settle(page);
  return { page, context, errors, cdp };
}
async function shot(page, key, state, withPng = false) {
  await settle(page);
  const entry = {
    key: `${key}__${state}`,
    state,
    layout: await page.evaluate(inspect),
    interaction: await page.evaluate(() => {
      const pointer = window.__ownedSessionPointer;
      const chain = [];
      let node = pointer ? document.elementFromPoint(pointer.x, pointer.y) : null;
      while (node && node !== document.body) {
        chain.push({
          tag: node.tagName,
          group: node.getAttribute('data-sidebar-group-key'),
          session: node.getAttribute('data-sidebar-session-id'),
          label: node.getAttribute('aria-label'),
          role: node.getAttribute('role'),
        });
        node = node.parentElement;
      }
      return {
        pointer,
        hitChain: chain,
        hoveredHeaders: [...document.querySelectorAll('[data-sidebar-group-key]')]
          .filter((e) => e.matches(':hover'))
          .map((e) => e.getAttribute('data-sidebar-group-key')),
        liveStatus: [...document.querySelectorAll('[role=status]')].map((e) => e.textContent),
      };
    }),
  };
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
          await steps(page, profile.ready?.[story]);
          if (story.endsWith('caller-overrides')) {
            const css = await page
              .locator('[data-owned-session-panel] > div:has([data-sidebar-group-key])')
              .evaluate((node) => {
                const s = getComputedStyle(node);
                return { gap: s.gap, padding: s.padding, width: s.width };
              });
            assert.deepEqual(css, { gap: '20px', padding: '12px', width: '280px' });
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
      const key = `native__${viewport.name}__${theme}`;
      let scope;
      try {
        scope = await open(
          viewport,
          theme,
          'components-owned-session-list-migration--project-groups'
        );
        const { page, cdp } = scope;
        const alpha = page.locator('[data-sidebar-group-key="projectGroup:alpha"]');
        const empty = page.locator('[data-sidebar-group-key="projectGroup:empty"]');
        const opener = page.locator('[data-sidebar-session-id="opener"]');
        const child = page.locator('[data-sidebar-session-id="child"]');
        const mobile = Boolean(viewport.device && viewport.width < 768);
        assert.equal(
          await alpha.locator('button[aria-label="More actions"]').count(),
          mobile ? 0 : 1
        );
        assert.equal(await opener.getAttribute('draggable'), 'true');
        assert.equal(await opener.locator('a').getAttribute('draggable'), 'false');
        await shot(page, key, 'device-rest', true);
        if (mobile) {
          await alpha.locator('button[aria-label="Toggle"]').tap();
          await opener.waitFor({ state: 'hidden' });
          await shot(page, key, 'mobile-group-collapsed', true);
          await alpha.locator('button[aria-label="Toggle"]').tap();
          await opener.waitFor();
          const box = await opener.boundingBox(),
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
          await shot(page, key, 'mobile-swipe-open', true);
          await archive.tap();
          await page.getByText('Archived opener', { exact: true }).waitFor();
          await shot(page, key, 'mobile-swipe-archived', true);
        } else {
          await page.keyboard.press('Tab');
          await opener.locator('a').focus();
          assert.equal(
            await opener.locator('a').evaluate((node) => node.matches(':focus-visible')),
            true
          );
          await shot(page, key, 'anchor-focus', true);
          const disclosure = opener.locator('button[aria-expanded]');
          await page.mouse.move(0, 0);
          await disclosure.focus();
          await disclosure.press('Space');
          await child.waitFor({ state: 'hidden' });
          await shot(page, key, 'opener-collapsed', true);
          await page.mouse.move(0, 0);
          await disclosure.focus();
          await disclosure.press('Space');
          await child.waitFor();
          await shot(page, key, 'opener-expanded', true);
          const handle = empty.locator('button[aria-label="Reorder project"]');
          await handle.focus();
          await handle.press('Space');
          await page.waitForFunction(() =>
            [...document.querySelectorAll('[data-owned-session-panel] [style]')].some((node) =>
              node.style.transform?.includes('translate3d')
            )
          );
          await settle(page);
          await handle.press('ArrowUp');
          await page.waitForFunction(() => {
            const alphaNode = document.querySelector(
              '[data-sidebar-group-key="projectGroup:alpha"]'
            );
            const emptyNode = document.querySelector(
              '[data-sidebar-group-key="projectGroup:empty"]'
            );
            return (
              emptyNode.getBoundingClientRect().y < alphaNode.getBoundingClientRect().y &&
              document
                .querySelector('[role=status]')
                ?.textContent.includes('moved over droppable area projectGroup:alpha')
            );
          });
          await settle(page);
          await shot(page, key, 'project-keyboard-drag', true);
          await handle.press('Escape');
          await page.waitForFunction(() =>
            [...document.querySelectorAll('[data-owned-session-panel] [style]')].every(
              (node) => !node.style.transform?.includes('translate3d')
            )
          );
          await shot(page, key, 'project-keyboard-cancelled', true);
          if (!viewport.device) {
            await empty.hover();
            await handle.hover();
            const from = await handle.boundingBox(),
              to = await alpha.boundingBox();
            await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
            await page.mouse.down();
            await page.mouse.move(from.x + from.width / 2, to.y + to.height / 2, { steps: 12 });
            await page.waitForFunction(() => {
              const alphaNode = document.querySelector(
                '[data-sidebar-group-key="projectGroup:alpha"]'
              );
              const emptyNode = document.querySelector(
                '[data-sidebar-group-key="projectGroup:empty"]'
              );
              return (
                emptyNode.getBoundingClientRect().y < alphaNode.getBoundingClientRect().y &&
                document
                  .querySelector('[role=status]')
                  ?.textContent.includes('moved over droppable area projectGroup:alpha')
              );
            });
            await settle(page);
            // Reconcile the real pointer with the final transformed hit-test geometry.
            await page.mouse.move(from.x + from.width / 2, to.y + to.height / 2);
            await page.waitForFunction(() =>
              document
                .querySelector('[data-sidebar-group-key="projectGroup:empty"]')
                .matches(':hover')
            );
            await shot(page, key, 'project-pointer-drag', true);
            await page.mouse.up();
            await page.getByText('Moved empty,alpha', { exact: true }).waitFor();
            await shot(page, key, 'project-pointer-reordered', true);
            await opener.click({ button: 'right' });
            await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
            const field = page.locator('[role=dialog] textarea');
            await field.waitFor();
            await field.fill('Cancelled synthetic draft');
            await shot(page, key, 'rename-dialog-draft', true);
            await field.press('Escape');
            await page.locator('[role=dialog]').waitFor({ state: 'hidden' });
            assert.equal(
              await page.getByText('Cancelled synthetic draft', { exact: true }).count(),
              0
            );
            await shot(page, key, 'rename-dialog-cancelled', true);
            await page.evaluate(() => {
              window.__ownedMentionEvents = [];
              window.addEventListener('dragstart', (event) =>
                window.__ownedMentionEvents.push({
                  trusted: event.isTrusted,
                  types: [...event.dataTransfer.types],
                  payload: event.dataTransfer.getData('application/x-lody-session-mention'),
                  plain: event.dataTransfer.getData('text/plain'),
                })
              );
            });
            const bounds = await opener.boundingBox();
            await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
            await page.mouse.down();
            await page.mouse.move(
              bounds.x + bounds.width / 2 + 70,
              bounds.y + bounds.height / 2 + 12,
              { steps: 8 }
            );
            await page.waitForFunction(() => window.__ownedMentionEvents?.length > 0);
            const mention = await page.evaluate(() => window.__ownedMentionEvents);
            assert.equal(mention.at(-1).trusted, true);
            assert.equal(mention.at(-1).payload, 'opener');
            await page.keyboard.press('Escape');
            await page.mouse.up();
            await shot(page, key, 'mention-drag-ended', true);
            entries.at(-1).mention = mention;
          } else await shot(page, key, 'touch-desktop-no-hover', true);
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
      kind: 'Production SessionList computed contracts and actual project group/opener/touch/drag/rename interactions; synthetic data, no backend',
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
