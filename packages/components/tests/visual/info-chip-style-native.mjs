import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .flatMap((a, i, all) => (a.startsWith('--') ? [[a.slice(2), all[i + 1]]] : []))
);
if (!args.phase || !args.storybook) throw new Error('--phase and --storybook required');
const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(pkg, 'artifacts/visual', args.phase);
await mkdir(path.join(out, 'shots'), { recursive: true });
const iframe = await (await fetch(new URL('/iframe.html', args.storybook))).text();
if (iframe.includes('/@vite/client')) throw new Error('Immutable build required');
const index = await (await fetch(new URL('/index.json', args.storybook))).text();
const fingerprint = createHash('sha256').update(iframe).update(index).digest('hex');
const browser = await chromium.launch({ channel: 'chrome' });
const entries = [],
  failures = [];
const scopeOnly = args['scope-only'] === 'true';
const expected = scopeOnly ? 14 : 94;
const viewports = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'below-container', width: 419, height: 900 },
  { name: 'at-container', width: 420, height: 900 },
  { name: 'above-container', width: 421, height: 900 },
  { name: 'desktop', width: 1280, height: 900 },
];
const inspect = () => {
  const props = [
    'color',
    'backgroundColor',
    'borderColor',
    'boxShadow',
    'opacity',
    'outlineColor',
    'outlineWidth',
    'outlineStyle',
    'display',
    'flexShrink',
  ];
  return [...document.body.querySelectorAll('*')]
    .filter((e) => !['SCRIPT', 'STYLE', 'LINK'].includes(e.tagName))
    .map((e, i) => {
      const r = e.getBoundingClientRect(),
        s = getComputedStyle(e),
        before = getComputedStyle(e, '::before');
      return {
        path: String(i),
        tag: e.tagName,
        text: (e.textContent ?? '').trim().slice(0, 140),
        label: e.getAttribute('aria-label'),
        rect: [r.x, r.y, r.width, r.height],
        styles: Object.fromEntries(props.map((p) => [p, s[p]])),
        before: { content: before.content, color: before.backgroundColor },
        active: document.activeElement === e,
        focusVisible: e.matches(':focus-visible'),
        disabled: e.matches(':disabled'),
      };
    });
};
try {
  for (const viewport of viewports.filter((v) => !scopeOnly || v.name === 'desktop'))
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport,
        reducedMotion: 'reduce',
        colorScheme: theme,
      });
      const seed = await context.newPage();
      await seed.clock.setFixedTime(new Date('2026-10-22T09:00:00Z'));
      await seed.close();
      for (const scenario of scopeOnly
        ? [
            'context-actions',
            'status-and-source',
            'anchored-popover',
            'stage-popover',
            'ci-details',
          ]
        : [
            'primitives',
            ...([390, 420, 1280].includes(viewport.width)
              ? ['context-actions', 'context-disabled']
              : []),
          ]) {
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        const key = `${scenario}__${viewport.name}__${theme}`;
        try {
          await page.addInitScript(() => {
            window.__infoInputs = [];
            for (const type of ['pointerdown', 'pointerup', 'keydown'])
              document.addEventListener(
                type,
                (e) => window.__infoInputs.push({ type, trusted: e.isTrusted, key: e.key ?? null }),
                true
              );
          });
          const url = new URL('/iframe.html', args.storybook);
          url.search = new URLSearchParams({
            id: `sessions-infochipstylemigration--${scenario}`,
            viewMode: 'story',
            globals: `theme:${theme};locale:en`,
          });
          await page.goto(url.href);
          await page.locator('#storybook-root button').first().waitFor({ state: 'visible' });
          await page.evaluate(() => document.fonts.ready);
          const shot = async (state) => {
            await page.waitForFunction(() =>
              document
                .getAnimations()
                .filter((a) => a.effect?.getTiming().iterations !== Infinity)
                .every((a) => a.playState !== 'running')
            );
            await page.waitForFunction(() => {
              const next = JSON.stringify(
                [...document.querySelectorAll('button,[role="dialog"],[role="menu"]')].map((e) =>
                  e.getBoundingClientRect().toJSON()
                )
              );
              const s = window.__infoStable ?? { value: '', count: 0 };
              s.count = s.value === next ? s.count + 1 : 0;
              s.value = next;
              window.__infoStable = s;
              return s.count >= 3;
            });
            const name = `${key}__${state}`,
              target = path.join(out, 'shots', `${name}.png`);
            await page.screenshot({ path: target, animations: 'disabled', caret: 'hide' });
            entries.push({
              key: name,
              state,
              scenario,
              viewport: viewport.name,
              theme,
              shot: `shots/${name}.png`,
              layout: await page.evaluate(inspect),
              events: await page.evaluate(() => window.__infoInputs),
            });
          };
          if (scopeOnly) {
            await page.locator('[data-info-chip-fixture]').evaluate((e) => {
              e.style.setProperty('--muted-foreground', '280 70% 35%');
              e.style.setProperty('--foreground', '170 65% 35%');
              e.style.setProperty('--status-warning', '310 75% 40%');
            });
            if (scenario.endsWith('popover') || scenario === 'ci-details') {
              const label =
                scenario === 'anchored-popover'
                  ? 'Related sessions'
                  : scenario === 'stage-popover'
                    ? 'Open goal details'
                    : 'CI checks · CI failed';
              await page.getByRole('button', { name: label, exact: true }).click();
              const panel = page.getByRole('dialog');
              await panel.waitFor({ state: 'visible' });
              await panel.evaluate((e) => {
                e.style.setProperty('--spacing', '0.0625rem');
                e.style.setProperty('--border', '200 80% 40%');
                if (e.textContent?.includes('Close related sessions'))
                  e.style.setProperty('--anchor-width', '260px');
              });
            }
            await shot('scoped-vars');
            if (scenario === 'context-actions') {
              const primary = page.getByRole('button', { name: 'Commit & Push', exact: true });
              await primary.hover();
              await shot('scoped-hover');
              await primary.focus();
              await page.keyboard.press('Tab');
              await page.keyboard.press('Shift+Tab');
              await page.mouse.move(0, 0);
              await shot('scoped-focus');
            }
          } else if (scenario === 'primitives') {
            const container = await page
              .locator('[data-info-chip-fixture]')
              .evaluate((e) => e.getBoundingClientRect().width);
            if (container !== viewport.width) throw new Error(`Wrong container ${container}`);
            for (const label of ['12m', '#12345']) {
              const display = await page
                .getByText(label, { exact: true })
                .evaluate((e) => getComputedStyle(e).display);
              if ((display === 'none') !== viewport.width < 420)
                throw new Error(`Query ${label} ${container} ${display}`);
            }
            await shot('query-verified');
          } else {
            const primary = page.getByRole('button', { name: 'Commit & Push', exact: true }),
              diff = page.getByRole('button', { name: 'All Changes', exact: true }),
              more = page.getByRole('button', { name: 'More actions', exact: true });
            await shot('rest');
            await primary.hover();
            await shot('primary-hover');
            if (scenario === 'context-actions') {
              const box = await primary.boundingBox();
              if (!box) throw new Error('Primary has no box');
              await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
              await page.mouse.down();
              await shot('primary-held');
              await page.mouse.up();
              await page
                .getByText('Commit requested', { exact: true })
                .waitFor({ state: 'visible' });
              await primary.press('Tab');
              await page.keyboard.press('Shift+Tab');
              if (
                !(await primary.evaluate(
                  (e) => document.activeElement === e && e.matches(':focus-visible')
                ))
              )
                throw new Error('Primary keyboard focus absent');
              await page.mouse.move(0, 0);
              await shot('primary-keyboard-focus');
              await primary.press('Tab');
              await shot('overflow-keyboard-focus');
              await page.keyboard.press('Enter');
              await page
                .getByRole('menuitem', { name: 'Fix CI Errors', exact: true })
                .waitFor({ state: 'visible' });
              await shot('menu-keyboard-open');
              await page.keyboard.press('Escape');
              await page
                .getByRole('menuitem', { name: 'Fix CI Errors', exact: true })
                .waitFor({ state: 'hidden' });
              await diff.hover();
              await shot('diff-hover');
              await diff.focus();
              await page.keyboard.press('Tab');
              await page.keyboard.press('Shift+Tab');
              await page.mouse.move(0, 0);
              await shot('diff-keyboard-focus');
              // Real class scopes exercise the project's selector exclusion inside a dark document.
              const fixture = page.locator('[data-info-chip-fixture]');
              await fixture.evaluate((e) => e.classList.add('light-scope'));
              await primary.hover();
              await shot('nested-light-scope-hover');
              await fixture.evaluate((e) => {
                e.classList.remove('light-scope');
                e.classList.add('dark-scope');
              });
              await shot('nested-dark-scope-hover');
            } else {
              if (!(await primary.isDisabled()) || !(await diff.isDisabled()))
                throw new Error('Request controls should be disabled');
              const diffBox = await diff.boundingBox();
              if (!diffBox) throw new Error('Disabled diff has no box');
              await page.mouse.move(diffBox.x + diffBox.width / 2, diffBox.y + diffBox.height / 2);
              await shot('disabled-diff-hover');
              await more.click();
              await page
                .getByRole('menuitem', { name: 'Fix CI Errors', exact: true })
                .waitFor({ state: 'visible' });
              await shot('disabled-menu-open');
            }
          }
        } catch (error) {
          failures.push({ key, message: String(error) });
          await page
            .screenshot({ path: path.join(out, 'shots', `${key}__ERROR.png`) })
            .catch(() => {});
        } finally {
          await page.close();
        }
      }
      await context.close();
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
      buildFingerprint: fingerprint,
      runnerFingerprint: createHash('sha256')
        .update(await readFile(fileURLToPath(import.meta.url)))
        .digest('hex'),
      expected,
      scopeOnly,
      entries,
      failures,
      limits: [
        'Real native input in Chrome. Synthetic class scope changes test CSS matching only; no theme-provider persistence claim. No backend requests.',
      ],
    },
    null,
    2
  ) + '\n'
);
console.log(JSON.stringify({ frames: entries.length, failures }));
if (failures.length || entries.length !== expected) process.exitCode = 1;
