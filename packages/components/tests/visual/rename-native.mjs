/** Real rename dialogs with native keyboard input and signal-driven synthetic saves. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from '@playwright/test';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .flatMap((a, i, all) => (a.startsWith('--') ? [[a.slice(2), all[i + 1]]] : []))
);
if (!args.phase || !args.storybook) throw new Error('--phase and --storybook are required');
const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(pkg, 'artifacts/visual', args.phase);
await mkdir(path.join(out, 'shots'), { recursive: true });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const iframe = await (await fetch(new URL('/iframe.html', args.storybook))).text();
if (iframe.includes('/@vite/client')) throw new Error('Use an immutable Storybook build');
const index = await (await fetch(new URL('/index.json', args.storybook))).json();
const viewports = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'phone', width: 390, height: 844 },
];
const themes = ['light', 'dark'];
const entries = [],
  observations = [],
  failures = [];
const browser = await chromium.launch({ channel: 'chrome' });
const snapshot = () =>
  [...document.body.querySelectorAll('*')]
    .filter((el) => !['SCRIPT', 'STYLE', 'LINK'].includes(el.tagName))
    .map((el, i) => {
      const r = el.getBoundingClientRect(),
        s = getComputedStyle(el);
      return {
        path: String(i),
        tag: el.tagName.toLowerCase(),
        rect: [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 100) / 100),
        text: (el.textContent ?? '').trim().slice(0, 60),
        ...Object.fromEntries(
          [
            'fontSize',
            'fontFamily',
            'fontWeight',
            'lineHeight',
            'color',
            'backgroundColor',
            'borderRadius',
            'boxShadow',
            'opacity',
          ].map((key) => [key, s[key]])
        ),
      };
    });
for (const viewport of viewports)
  for (const theme of themes) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    try {
      for (const scenario of [
        'interactive',
        'pending-save',
        'pending-rejection',
        'overflow-title',
      ]) {
        const page = await context.newPage();
        page.setDefaultTimeout(15_000);
        const storyId = `components-renamesessiondialog--${scenario === 'pending-rejection' ? 'pending-save' : scenario}`;
        const key = `${storyId}__${viewport.name}__${theme}__${scenario}`;
        try {
          await page.addInitScript(() => {
            window.__renameInputs = [];
            for (const type of ['keydown', 'pointerdown'])
              document.addEventListener(
                type,
                (e) =>
                  window.__renameInputs.push({ type, trusted: e.isTrusted, key: e.key ?? null }),
                true
              );
          });
          const url = new URL('/iframe.html', args.storybook);
          url.search = new URLSearchParams({
            id: storyId,
            viewMode: 'story',
            globals: `theme:${theme};locale:en`,
          });
          await page.goto(url.href);
          const field = page.locator('textarea');
          const dialog = page.getByRole('dialog', { name: 'Rename Chat', exact: true });
          await field.waitFor({ state: 'visible' });
          await page.evaluate(() => document.fonts.ready);
          await page.waitForFunction(() => document.querySelector('textarea')?.value.length > 0);
          const shot = async (state) => {
            await page.waitForFunction(() =>
              document
                .getAnimations()
                .filter((a) => a.effect?.getTiming().iterations !== Infinity)
                .every((a) => a.playState !== 'running')
            );
            const stateKey = `${key}__${state}`;
            await page.screenshot({
              path: path.join(out, 'shots', `${stateKey}.png`),
              animations: 'disabled',
              caret: 'hide',
            });
            entries.push({
              key: stateKey,
              state,
              storyId,
              title: 'Rename Chat — native input',
              viewport: viewport.name,
              theme,
              shot: `shots/${stateKey}.png`,
              layout: await page.evaluate(snapshot),
            });
            observations.push({
              key: stateKey,
              ...(await page.evaluate(() => {
                const e = document.querySelector('textarea');
                const s = e && getComputedStyle(e);
                return {
                  value: e?.value,
                  activeField: document.activeElement === e,
                  selection: e ? [e.selectionStart, e.selectionEnd] : null,
                  fieldRect: e
                    ? [e.clientWidth, e.clientHeight, e.scrollHeight, e.scrollTop]
                    : null,
                  lineHeight: s?.lineHeight,
                  result: document.querySelector('[data-rename-result]')?.textContent,
                  events: window.__renameInputs,
                };
              })),
            });
          };
          if (scenario === 'interactive') {
            const selected = await field.evaluate(
              (e) =>
                document.activeElement === e &&
                e.selectionStart === 0 &&
                e.selectionEnd === e.value.length
            );
            if (!selected) throw new Error('Initial title is not selected in the focused field');
            await shot('autofocus-selected');
            await field.fill('  Composed 中文 title  ');
            // This exercises the DOM composition flag boundary; it is not an OS IME session.
            await field.evaluate((e) =>
              e.dispatchEvent(
                new KeyboardEvent('keydown', {
                  key: 'Enter',
                  isComposing: true,
                  bubbles: true,
                  cancelable: true,
                })
              )
            );
            if (!(await dialog.isVisible())) throw new Error('Composition Enter closed the dialog');
            if ((await page.locator('[data-rename-result]').textContent()) !== 'Ready')
              throw new Error('Composition Enter saved the title');
            await shot('composition-enter-ignored');
            await field.press('Enter');
            await dialog.waitFor({ state: 'hidden' });
            await page.getByText('Saved: Composed 中文 title', { exact: true }).waitFor();
            await shot('committed-enter-saved');
            await page.getByRole('button', { name: 'Open rename dialog', exact: true }).click();
            await field.waitFor();
            await page.keyboard.press('Escape');
            await dialog.waitFor({ state: 'hidden' });
            await shot('escape-closed');
          } else if (scenario.startsWith('pending')) {
            await field.fill('Pending synthetic title 中文');
            await field.press('Enter');
            await page.waitForFunction(() => document.querySelector('textarea')?.disabled);
            if (!(await page.getByRole('button', { name: 'Cancel', exact: true }).isDisabled()))
              throw new Error('Cancel remained enabled while saving');
            await page.keyboard.press('Escape');
            if (!(await dialog.isVisible())) throw new Error('Escape dismissed a pending save');
            await shot('pending-dismiss-guard');
            const rejection = scenario === 'pending-rejection';
            await page.evaluate(
              (reject) =>
                window.dispatchEvent(
                  new CustomEvent('rename-fixture-settle', {
                    detail: reject ? 'reject' : 'resolve',
                  })
                ),
              rejection
            );
            if (rejection) {
              await page.getByText('Synthetic rename failed', { exact: true }).waitFor();
              if (await field.isDisabled()) throw new Error('Failed save kept the field disabled');
              await shot('pending-rejected');
              await page.getByRole('button', { name: 'Save', exact: true }).click();
              await page.waitForFunction(() => document.querySelector('textarea')?.disabled);
              await page.evaluate(() =>
                window.dispatchEvent(
                  new CustomEvent('rename-fixture-settle', { detail: 'resolve' })
                )
              );
            }
            await dialog.waitFor({ state: 'hidden' });
            await page.getByText('Saved: Pending synthetic title 中文', { exact: true }).waitFor();
            await shot(rejection ? 'pending-retry-saved' : 'pending-resolved');
          } else {
            await page.waitForFunction(() => {
              const e = document.querySelector('textarea'),
                s = getComputedStyle(e);
              const chrome =
                parseFloat(s.paddingTop) +
                parseFloat(s.paddingBottom) +
                parseFloat(s.borderTopWidth) +
                parseFloat(s.borderBottomWidth);
              return (
                Math.abs(
                  e.getBoundingClientRect().height - (4 * parseFloat(s.lineHeight) + chrome)
                ) < 1 && e.scrollHeight > e.clientHeight
              );
            });
            await shot('four-line-cap');
            await field.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
            await page.waitForFunction(() => document.querySelector('textarea').scrollTop > 0);
            await shot('field-bottom');
          }
        } catch (error) {
          failures.push({ key, message: String(error.stack ?? error) });
          console.error(key, String(error.message ?? error));
        } finally {
          await page.close();
        }
      }
    } finally {
      await context.close();
    }
  }
await browser.close();
await writeFile(
  path.join(out, 'manifest.json'),
  JSON.stringify(
    {
      phase: args.phase,
      baseUrl: args.storybook,
      buildFingerprint: hash(iframe + JSON.stringify(index)),
      harnessFingerprint: hash(await readFile(fileURLToPath(import.meta.url))),
      targets: { viewports, themes },
      expected: 44,
      entries,
      limits: [
        'Composition flag dispatch is synthetic DOM input, not native OS IME coverage. Synthetic save completion is an explicit fixture signal.',
      ],
    },
    null,
    2
  )
);
await writeFile(path.join(out, 'observations.json'), JSON.stringify(observations, null, 2));
await writeFile(path.join(out, 'failures.json'), JSON.stringify(failures, null, 2));
console.log(`${entries.length} native rename frames; ${failures.length} failures`);
if (failures.length) process.exitCode = 1;
