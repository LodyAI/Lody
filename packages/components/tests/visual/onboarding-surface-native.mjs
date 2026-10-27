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
  await page.evaluate(async () => {
    await document.fonts.ready;
    for (const animation of document.getAnimations()) {
      if (animation.effect?.getTiming().iterations === Infinity) {
        const target = animation.effect.target;
        window.__onboardingAnimationPolicy ??= [];
        if (
          !window.__onboardingAnimationPolicy.some(
            (record) => record.name === animation.animationName && record.tag === target?.tagName
          )
        )
          window.__onboardingAnimationPolicy.push({
            name: animation.animationName ?? null,
            tag: target?.tagName ?? null,
            className: target?.getAttribute('class') ?? null,
            policy: 'infinite WAAPI paused at currentTime 0',
          });
        animation.pause();
        animation.currentTime = 0;
      }
    }
  });
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .filter((a) => a.effect?.getTiming().iterations !== Infinity)
      .every((a) => a.playState !== 'running')
  );
  await page.evaluate(() => delete window.__onboardingStable);
  await page.waitForFunction((inspected) => {
    const value = JSON.stringify(
      [
        ...document.querySelectorAll(
          '[data-onboarding-surface-fixture], [data-onboarding-surface-fixture] *'
        ),
      ].map((e) => {
        const c = getComputedStyle(e);
        return [
          e.getBoundingClientRect().toJSON(),
          inspected.map((k) => c[k]),
          e.scrollLeft,
          e.scrollTop,
        ];
      })
    );
    const previous = window.__onboardingStable ?? { value: '', count: 0 };
    previous.count = previous.value === value ? previous.count + 1 : 0;
    previous.value = value;
    window.__onboardingStable = previous;
    return previous.count >= 5;
  }, inspectedProperties);
}
async function waitPhase(page, phase) {
  await page.waitForFunction((p) => {
    const result = document.querySelector('[data-onboarding-surface-result]'),
      form = document.querySelector('[data-onboarding-form="' + p + '"]');
    return (
      result?.dataset.phase === p &&
      result.dataset.resolvedTheme === 'light' &&
      form &&
      getComputedStyle(form).opacity === '1' &&
      getComputedStyle(form).transform === 'none'
    );
  }, phase);
  await settle(page);
}
try {
  for (const viewport of [
    { name: 'desktop', width: 1280, height: 900, motion: 'no-preference' },
    { name: 'iphone', width: 390, height: 844, motion: 'reduce', device: 'iPhone 13' },
    { name: 'compact', width: 320, height: 720, motion: 'no-preference', device: 'iPhone 13' },
  ])
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        ...(viewport.device ? devices[viewport.device] : {}),
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
        colorScheme: theme,
        reducedMotion: viewport.motion,
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
          externalRequests.push(u.origin + u.pathname);
          return route.abort();
        }
        return route.continue();
      });
      for (const scenario of viewport.name === 'compact'
        ? ['overlay-summary', 'caller-backdrop']
        : ['overlay-summary', 'long-overlay-summary', 'backdrop', 'caller-backdrop']) {
        if (args.only && !new RegExp(args.only).test(`${scenario}__${viewport.name}__${theme}`))
          continue;
        const page = await context.newPage();
        page.setDefaultTimeout(20000);
        page.on('pageerror', (e) => browserErrors.push(String(e)));
        const id = 'onboarding-ownedonboardingsurfacemigration--' + scenario;
        const shot = async (state, assertions = {}) => {
          await settle(page);
          const key = `${id}__${viewport.name}__${theme}__${state}`;
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
                    text: e.textContent?.trim().slice(0, 100),
                    label: e.getAttribute('aria-label'),
                    role: e.getAttribute('role'),
                    rect: [r.x, r.y, r.width, r.height],
                    styles: Object.fromEntries(inspected.map((k) => [k, c[k]])),
                    active: document.activeElement === e,
                    focusVisible: e.matches(':focus-visible'),
                    inert: e.inert,
                    scroll: [e.scrollLeft, e.scrollTop, e.scrollWidth, e.clientWidth],
                    image:
                      e instanceof HTMLImageElement
                        ? { complete: e.complete, natural: [e.naturalWidth, e.naturalHeight] }
                        : null,
                  };
                }),
              events: window.__onboardingEvents,
              animationPolicy: window.__onboardingAnimationPolicy ?? [],
              phase:
                document.querySelector('[data-onboarding-surface-result]')?.dataset.phase ?? null,
              intent:
                document.querySelector('[data-onboarding-surface-result]')?.dataset.intent ?? null,
              resolvedTheme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
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
            window.__onboardingEvents = [];
            for (const type of [
              'pointerdown',
              'pointerup',
              'touchstart',
              'touchend',
              'click',
              'keydown',
            ])
              document.addEventListener(
                type,
                (e) => {
                  const target = e.target instanceof Element ? e.target : null;
                  if (target?.closest('[data-onboarding-surface-fixture]'))
                    window.__onboardingEvents.push({
                      type,
                      trusted: e.isTrusted,
                      pointerType: e.pointerType ?? null,
                      touches: e.touches?.length ?? null,
                      key: e.key ?? null,
                      target: target.tagName,
                      label: target.getAttribute('aria-label'),
                      text: target.textContent?.trim().slice(0, 50),
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
          await page.locator('[data-onboarding-surface-result]').waitFor();
          if (scenario.includes('summary')) await waitPhase(page, 'summary');
          await shot('rest');
          if (viewport.name === 'compact') continue;
          if (scenario === 'overlay-summary') {
            if (theme === 'light')
              for (const scope of ['root', 'subtree']) {
                const before = await page
                  .locator('[data-onboarding-surface-fixture] > div')
                  .first()
                  .evaluate((e) => getComputedStyle(e).color);
                await page.evaluate((which) => {
                  const e =
                    which === 'root'
                      ? document.documentElement
                      : document.querySelector('[data-onboarding-surface-fixture]');
                  e.style.setProperty('--color-slate-950', 'oklch(0.3 0.05 20)');
                }, scope);
                await page.waitForFunction(
                  (old) =>
                    getComputedStyle(
                      document.querySelector('[data-onboarding-surface-fixture] > div')
                    ).color !== old,
                  before
                );
                await shot(scope + '-palette', { localSlateVariable: 'oklch(0.3 0.05 20)' });
                await page.evaluate((which) => {
                  const e =
                    which === 'root'
                      ? document.documentElement
                      : document.querySelector('[data-onboarding-surface-fixture]');
                  e.style.removeProperty('--color-slate-950');
                }, scope);
                await settle(page);
              }
            const enter = page.getByRole('button', { name: 'Enter Lody', exact: true });
            if (viewport.device) {
              await enter.tap();
              await page.locator('[data-intent="Completion requested: summary"]').waitFor();
              await shot('touch-completion', {
                expectedIntent: 'Completion requested: summary',
                trustedTouch: true,
              });
            } else {
              await enter.focus();
              await shot('completion-focus');
              await page
                .locator('[data-onboarding-form="summary"]')
                .getByRole('button', { name: 'Back', exact: true })
                .click();
              await waitPhase(page, 'providers');
              await shot('back-providers');
              await page
                .locator('[data-onboarding-form="providers"]')
                .getByRole('button', { name: 'Skip for now', exact: true })
                .click();
              await waitPhase(page, 'summary');
              await shot('skip-summary');
              await page.getByRole('button', { name: 'Enter Lody', exact: true }).click();
              await page.locator('[data-intent="Completion requested: summary"]').waitFor();
              await shot('completion', { expectedIntent: 'Completion requested: summary' });
            }
          } else if (scenario === 'backdrop') {
            await page.locator('[data-onboarding-backdrop-action]').focus();
            await shot('keyboard-focus');
            for (const scope of ['root', 'subtree']) {
              await page.evaluate((which) => {
                const e =
                  which === 'root'
                    ? document.documentElement
                    : document.querySelector('[data-onboarding-backdrop-host]');
                e.style.setProperty('--muted', '210 30% 20%');
              }, scope);
              await page.waitForFunction(
                () =>
                  getComputedStyle(document.querySelector('[data-onboarding-backdrop-host] > div'))
                    .getPropertyValue('--muted')
                    .trim() === '210 30% 20%'
              );
              await shot(scope + '-palette', { localMutedVariable: '210 30% 20%' });
              await page.evaluate((which) => {
                const e =
                  which === 'root'
                    ? document.documentElement
                    : document.querySelector('[data-onboarding-backdrop-host]');
                e.style.removeProperty('--muted');
              }, scope);
              await settle(page);
            }
          }
        } catch (error) {
          failures.push({ id, viewport: viewport.name, theme, scenario, message: String(error) });
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
        animationControl: {
          date: '2026-10-22T09:00:00Z',
          clock: 'setFixedTime; timers and RAF remain live',
          infiniteWaapi: 'pause at currentTime0; exact affected targets recorded perframe',
          screenshotAnimations: 'disabled',
          motion: { desktop: 'no-preference', iphone: 'reduce', compact: 'no-preference' },
        },
        harnessSha256,
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
