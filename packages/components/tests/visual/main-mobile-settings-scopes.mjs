import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from '@playwright/test';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .flatMap((value, index, all) =>
      value.startsWith('--') ? [[value.slice(2), all[index + 1]]] : []
    )
);
if (!args.phase || !args.storybook) throw Error('--phase and --storybook required');
const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(pkg, 'artifacts/visual', args.phase);
await mkdir(path.join(out, 'shots'), { recursive: true });
const iframe = await (await fetch(new URL('/iframe.html', args.storybook))).text();
assert.ok(!iframe.includes('/@vite/client'), 'Immutable Storybook required');
const index = await (await fetch(new URL('/index.json', args.storybook))).text();
const buildFingerprint = createHash('sha256').update(iframe).update(index).digest('hex');
const browser = await (async () => {
  try {
    return await chromium.launch();
  } catch (error) {
    const dir = path.join(os.homedir(), 'Library/Caches/ms-playwright');
    const candidates = existsSync(dir)
      ? (await readdir(dir))
          .flatMap((entry) => {
            const match = /^chromium_headless_shell-(\d+)$/.exec(entry),
              shell = path.join(
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
  externalRequests = [],
  browserErrors = [];
const inspectedProperties = [
  'display',
  'position',
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
  'padding',
  'borderWidth',
  'borderStyle',
  'borderColor',
  'borderRadius',
  'boxSizing',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'color',
  'backgroundColor',
  'backgroundImage',
  'objectFit',
  'objectPosition',
  'overflow',
  'overflowX',
  'overflowY',
  'whiteSpace',
  'opacity',
  'outline',
  'boxShadow',
  'transform',
  'transformOrigin',
  'translate',
  'scale',
  'transitionProperty',
  'transitionDuration',
  'transitionTimingFunction',
  'cursor',
  'pointerEvents',
  'touchAction',
  'willChange',
  'contain',
  'filter',
  'backdropFilter',
];

async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .filter((a) => a.effect?.getTiming().iterations !== Infinity)
      .every((a) => a.playState !== 'running')
  );
  await page.evaluate(() => delete window.__mainMobileStable);
  await page.waitForFunction((inspected) => {
    const value = JSON.stringify(
      [...document.body.querySelectorAll('*')]
        .filter((e) => !['SCRIPT', 'STYLE', 'LINK'].includes(e.tagName))
        .map((e) => {
          const c = getComputedStyle(e),
            r = e.getBoundingClientRect();
          return [
            r.x,
            r.y,
            r.width,
            r.height,
            inspected.map((k) => c[k]),
            e.scrollLeft,
            e.scrollTop,
          ];
        })
    );
    const previous = window.__mainMobileStable ?? { value: '', count: 0 };
    previous.count = previous.value === value ? previous.count + 1 : 0;
    previous.value = value;
    window.__mainMobileStable = previous;
    return previous.count >= 5;
  }, inspectedProperties);
}
const modes = ['direct-delete'];
try {
  for (const viewport of [{ name: 'tablet', width: 768, height: 1024 }])
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        ...(viewport.device ? devices[viewport.device] : {}),
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
        colorScheme: theme,
        reducedMotion: 'reduce',
      });
      const clockPage = await context.newPage();
      await clockPage.clock.setFixedTime(new Date('2026-10-22T09:00:00Z'));
      await clockPage.close();
      await context.route('**/*', (route) => {
        const u = new URL(route.request().url());
        if (
          ['http:', 'https:'].includes(u.protocol) &&
          !['localhost', '127.0.0.1'].includes(u.hostname)
        ) {
          externalRequests.push({
            url: u.origin + u.pathname,
            type: route.request().resourceType(),
          });
          return route.abort();
        }
        return route.continue();
      });
      for (const scope of ['root', 'subtree']) {
        const mode = modes[0];
        if (args.only && !new RegExp(args.only).test(`${mode}__${viewport.name}__${theme}`))
          continue;
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        page.on('pageerror', (error) => browserErrors.push(String(error)));
        const id = 'mobile-mainmobilesettingsintegration--' + mode;
        const shot = async (state, assertions = {}) => {
          await settle(page);
          const key = `${id}__${viewport.name}__${theme}__${scope}-${state}`;
          const observation = await page.evaluate(
            (inspected) => ({
              layout: [...document.body.querySelectorAll('*')]
                .filter((e) => !['SCRIPT', 'STYLE', 'LINK'].includes(e.tagName))
                .map((e, i) => {
                  const c = getComputedStyle(e),
                    r = e.getBoundingClientRect();
                  return {
                    path: String(i),
                    tag: e.tagName,
                    text: e.textContent?.trim().slice(0, 110),
                    label: e.getAttribute('aria-label'),
                    role: e.getAttribute('role'),
                    rect: [r.x, r.y, r.width, r.height],
                    styles: Object.fromEntries(inspected.map((k) => [k, c[k]])),
                    variables: Object.fromEntries(
                      [
                        '--spacing',
                        '--font-weight-medium',
                        '--radius-xl',
                        '--destructive',
                        '--ui-font-size',
                      ].map((k) => [k, c.getPropertyValue(k)])
                    ),
                    active: e.matches(':active'),
                    focusVisible: e.matches(':focus-visible'),
                    focused: e === document.activeElement,
                    inert: e.inert,
                    scroll: [
                      e.scrollLeft,
                      e.scrollTop,
                      e.scrollWidth,
                      e.scrollHeight,
                      e.clientWidth,
                      e.clientHeight,
                    ],
                  };
                }),
              events: window.__mainMobileEvents,
              dialogs: document.querySelectorAll('[role=dialog],[role=alertdialog]').length,
              result: document.querySelector('[data-main-mobile-settings-result]')?.textContent,
              removed: document.querySelector('[data-main-mobile-settings-result]')?.dataset
                .removed,
              command: document.querySelector('[data-main-mobile-settings-command]')?.textContent,
              media: {
                hover: matchMedia('(hover:hover)').matches,
                pointerFine: matchMedia('(pointer:fine)').matches,
                reducedMotion: matchMedia('(prefers-reduced-motion:reduce)').matches,
              },
              viewportGeometry: {
                width: innerWidth,
                documentWidth: document.documentElement.scrollWidth,
                visualScale: visualViewport.scale,
              },
            }),
            inspectedProperties
          );
          await page.screenshot({
            path: path.join(out, 'shots', key + '.png'),
            animations: 'disabled',
            caret: 'hide',
          });
          entries.push({
            id,
            key,
            state,
            viewport: viewport.name,
            theme,
            shot: `shots/${key}.png`,
            assertions,
            ...observation,
          });
          console.log(key);
        };
        try {
          await page.addInitScript(() => {
            window.__mainMobileEvents = [];
            for (const type of [
              'pointerdown',
              'pointerup',
              'touchstart',
              'touchmove',
              'touchend',
              'touchcancel',
              'click',
              'keydown',
            ])
              document.addEventListener(
                type,
                (e) => {
                  const t = e.target instanceof Element ? e.target : null;
                  const b = t?.closest('button');
                  window.__mainMobileEvents.push({
                    type,
                    trusted: e.isTrusted,
                    pointerType: e.pointerType ?? null,
                    touches: e.touches?.length ?? null,
                    key: e.key ?? null,
                    target: t?.tagName,
                    label: t?.getAttribute('aria-label'),
                    buttonText: b?.textContent?.trim() ?? null,
                  });
                },
                { capture: true, passive: true }
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
          await page.locator('[data-main-mobile-settings-result]').waitFor();
          await page.waitForFunction(() => {
            const r = document.querySelector('[data-main-mobile-settings]');
            const buttons = [...r.querySelectorAll('button')];
            return r.dataset.mainMobileSettings === 'non-owner'
              ? !!r.querySelector('p') && buttons.length === 0
              : buttons.some((b) => b.textContent.includes('Worktree setup')) &&
                  buttons.some((b) => b.textContent.includes('Project skills'));
          });
          await page.evaluate((which) => {
            const host =
              which === 'root'
                ? document.documentElement
                : document.querySelector('[data-main-mobile-settings]');
            for (const [key, value] of Object.entries({
              '--primary': '275 65% 45%',
              '--muted-foreground': '35 72% 38%',
              '--destructive': '155 65% 36%',
              '--tw-duration': '210ms',
              '--tw-ease': 'linear',
            }))
              host.style.setProperty(key, value);
          }, scope);
          await page.waitForFunction(
            () =>
              getComputedStyle(document.querySelector('[data-main-mobile-settings]'))
                .getPropertyValue('--primary')
                .trim() === '275 65% 45%'
          );
          const action = page.getByRole('button', { name: 'Delete project', exact: true });
          if (mode === 'unsupported-protocol' || mode === 'non-owner') {
            assert.equal(await action.count(), 0, 'Unavailable removal must not expose action');
            assert.equal(
              await page.locator('[data-main-mobile-settings-command]').textContent(),
              'none'
            );
            await shot('action-absent', { expectedDeleteActionCount: 0, expectedCommand: 'none' });
            continue;
          }
          await action.waitFor();
          assert.equal(await action.isEnabled(), true);
          await shot('rest', {
            scope,
            primary: '275 65% 45%',
            mutedForeground: '35 72% 38%',
            destructive: '155 65% 36%',
            duration: '210ms',
            ease: 'linear',
          });
          if (viewport.name === 'tablet' && mode === 'direct-delete') {
            await action.scrollIntoViewIfNeeded();
            const box = await action.boundingBox();
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.down();
            await page.waitForFunction(() =>
              [...document.querySelectorAll('button')].some(
                (b) => b.textContent.trim() === 'Delete project' && b.matches(':active')
              )
            );
            await shot('mouse-held', { expectedActive: true });
            await page.mouse.move(1, 1);
            await page.mouse.up();
            await page.waitForFunction(
              () => ![...document.querySelectorAll('button')].some((b) => b.matches(':active'))
            );
            assert.equal(
              await page.locator('[data-main-mobile-settings-command]').textContent(),
              'none'
            );

            continue;
          }
          if (!viewport.device) continue;
          await action.scrollIntoViewIfNeeded();
          const box = await action.boundingBox();
          const cdp = await context.newCDPSession(page);
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
          });
          await page.waitForFunction(() =>
            window.__mainMobileEvents.some(
              (e) => e.type === 'touchstart' && e.trusted && e.buttonText === 'Delete project'
            )
          );
          const active = await action.evaluate((e) => e.matches(':active'));
          await shot('touch-held', {
            trustedContact: true,
            activePseudoObserved: active,
            limitation: active
              ? null
              : 'Browser held touch did not expose :active; desktop real mouse-held separately covers pressed CSS.',
          });
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
          await page.waitForFunction(
            () => ![...document.querySelectorAll('button')].some((b) => b.matches(':active'))
          );
          assert.equal(
            await page.locator('[data-main-mobile-settings-command]').textContent(),
            'none'
          );
          await shot('touch-cancelled-release', { expectedCommand: 'none' });
          await cdp.detach();
          await action.tap();
          if (mode === 'direct-delete') {
            await page.locator('[data-main-mobile-settings-result][data-removed="true"]').waitFor();
            assert.equal(await action.count(), 0);
            assert.equal(await page.locator('[role=dialog],[role=alertdialog]').count(), 0);
            const result = await page.locator('[data-main-mobile-settings-result]').textContent();
            assert.ok(result.includes('Navigated after admitted deletion'));
            const command = JSON.parse(
              await page.locator('[data-main-mobile-settings-command]').textContent()
            );
            assert.deepEqual(command.key, [
              'cmd',
              'deleteLocalProject',
              'synthetic-mobile-settings-project',
            ]);
            assert.ok(!('cleanupWorktrees' in command.value));
            await shot('direct-delete-completed', {
              directNoConfirmation: true,
              onRemovedObserved: true,
              cleanupOptInAbsent: true,
            });
          } else {
            await page
              .getByText('Synthetic local-project command rejected', { exact: true })
              .first()
              .waitFor();
            assert.equal(await action.isEnabled(), true);
            assert.equal(
              await page.locator('[data-main-mobile-settings-result]').getAttribute('data-removed'),
              'false'
            );
            assert.equal(await page.locator('[role=alertdialog]').count(), 0);
            const dialogTexts = await page.locator('[role=dialog]').allTextContents();
            assert.ok(
              dialogTexts.length > 0 &&
                dialogTexts.every(
                  (text) => text.trim() === 'Synthetic local-project command rejected'
                ),
              'Only the actual error toast dialog may remain, no confirmation'
            );
            await shot('rejected-action-retained', {
              toastObserved: true,
              onRemovedObserved: false,
              deleteStillEnabled: true,
            });
            await action.tap();
            await page
              .getByText('Synthetic local-project command rejected', { exact: true })
              .first()
              .waitFor();
            assert.equal(await action.isEnabled(), true);
            assert.equal(
              await page.locator('[data-main-mobile-settings-result]').getAttribute('data-removed'),
              'false'
            );
            const trusted = await page.evaluate(
              () =>
                window.__mainMobileEvents.filter(
                  (e) => e.type === 'click' && e.trusted && e.buttonText === 'Delete project'
                ).length
            );
            assert.equal(trusted, 2);
            await shot('retry-after-rejection', {
              trustedActivations: 2,
              deleteStillEnabled: true,
              onRemovedObserved: false,
            });
          }
        } catch (error) {
          failures.push({ id, viewport: viewport.name, theme, message: String(error) });
          await page
            .screenshot({ path: path.join(out, `failure-${mode}-${viewport.name}-${theme}.png`) })
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
  const harnessSha256 = createHash('sha256')
    .update(await readFile(fileURLToPath(import.meta.url)))
    .digest('hex');
  await writeFile(
    path.join(out, 'manifest.json'),
    JSON.stringify(
      {
        phase: args.phase,
        storybook: args.storybook,
        buildFingerprint,
        browserVersion,
        harnessSha256,
        animationControl: {
          date: '2026-10-22T09:00:00Z',
          clock: 'setFixedTime; live timers/RAF',
          reducedMotion: 'reduce',
          screenshotAnimations: 'disabled',
        },
        entries,
        failures,
        externalRequests,
        browserErrors,
      },
      null,
      2
    )
  );
}
assert.equal(failures.length, 0, JSON.stringify(failures));
assert.equal(externalRequests.length, 0);
assert.equal(browserErrors.length, 0);
