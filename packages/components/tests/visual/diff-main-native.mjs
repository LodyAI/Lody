/** Actual shadow-DOM geometry, native selection, overflow and held CSS motion. */
import { chromium, devices } from '@playwright/test';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .flatMap((s, i, all) => (s.startsWith('--') ? [[s.slice(2), all[i + 1]]] : []))
);
if (!args.phase || !args.storybook) throw Error('--phase and --storybook required');
const root = fileURLToPath(new URL('../../', import.meta.url)),
  out = path.join(root, 'artifacts/visual', args.phase),
  hash = (b) => createHash('sha256').update(b).digest('hex');
await mkdir(path.join(out, 'shots'), { recursive: true });
const iframe = await (await fetch(new URL('/iframe.html', args.storybook))).text(),
  index = await (await fetch(new URL('/index.json', args.storybook))).json();
if (iframe.includes('/@vite/client')) throw Error('Immutable static build required');
const harnessFingerprint = hash(await readFile(fileURLToPath(import.meta.url)));
let browser;
try {
  browser = await chromium.launch();
} catch {
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const revs = (await readdir(cache))
    .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
    .sort((a, b) => Number(b.split('-').at(-1)) - Number(a.split('-').at(-1)));
  if (!revs.length) throw Error('No installed Chromium');
  browser = await chromium.launch({
    executablePath: path.join(
      cache,
      revs[0],
      'chrome-headless-shell-mac-arm64/chrome-headless-shell'
    ),
  });
}
const snapshot = () => {
  const rows = [];
  const walk = (e, p) => {
    const s = getComputedStyle(e),
      r = e.getBoundingClientRect();
    rows.push({
      path: p,
      tag: e.tagName.toLowerCase(),
      rect: [r.x, r.y, r.width, r.height],
      text: e.hasAttribute('data-line') ? e.textContent : null,
      attributes: Object.fromEntries(
        [...e.attributes]
          .filter((a) => a.name.startsWith('data-') && !['data-style-src'].includes(a.name))
          .map((a) => [a.name, a.value])
      ),
      ...Object.fromEntries(
        [
          'fontFamily',
          'fontSize',
          'fontWeight',
          'lineHeight',
          'letterSpacing',
          'color',
          'backgroundColor',
          'borderColor',
          'borderWidth',
          'borderRadius',
          'boxShadow',
          'opacity',
          'display',
          'position',
          'overflowX',
          'overflowY',
          'paddingTop',
          'paddingBottom',
          'paddingLeft',
          'paddingRight',
          'transform',
          'rotate',
        ].map((k) => [k, s[k]])
      ),
    });
    [...e.children].forEach((c, i) => walk(c, p + '>' + i));
    if (e.shadowRoot) [...e.shadowRoot.children].forEach((c, i) => walk(c, p + '>#shadow>' + i));
  };
  const host = document.querySelector('[data-diff-migration]');
  if (host) walk(host, 'fixture');
  return rows;
};
const details = () => {
  const h = document.querySelector('diffs-container'),
    s = h?.shadowRoot;
  return {
    defined: !!customElements.get('diffs-container'),
    hostWidth: document.querySelector('[data-diff-width-host]')?.getBoundingClientRect().width,
    lines: s?.querySelectorAll('[data-line]').length ?? 0,
    unified: !!s?.querySelector('code[data-unified]'),
    split: !!s?.querySelector('code[data-additions]'),
    selection: String(window.getSelection()),
    codeScroll: [...(s?.querySelectorAll('pre,code') ?? [])].map((e) => ({
      tag: e.tagName,
      x: e.scrollLeft,
      width: e.clientWidth,
      scrollWidth: e.scrollWidth,
    })),
    inputs: window.__diffInputs ?? [],
    held: window.__diffHeld ?? null,
    viewport: [innerWidth, innerHeight],
    userAgent: navigator.userAgent,
  };
};
const settle = async (p) => {
  await p.evaluate(() => document.fonts.ready);
  await p.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity && a.playState === 'running')
        .map((a) => a.finished.catch(() => {}))
    )
  );
  await p.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
};
const entries = [],
  failures = [],
  actions = [];
const cases = ['responsive', 'horizontal', 'comments', 'selection', 'motion', 'iphone', 'android'];
for (const theme of ['light', 'dark'])
  for (const kind of cases) {
    const context = await browser.newContext({
        viewport: { width: 1360, height: 1000 },
        deviceScaleFactor: 1,
        ...(kind === 'iphone'
          ? devices['iPhone 13']
          : kind === 'android'
            ? devices['Pixel 5']
            : {}),
        reducedMotion: kind === 'motion' ? 'no-preference' : 'reduce',
      }),
      page = await context.newPage();
    let current = 'initial';
    const suffix = {
        responsive: 'responsive-context',
        horizontal: 'long-lines',
        comments: 'comments',
        selection: 'unified',
        motion: 'unified',
        iphone: 'comments',
        android: 'comments',
      }[kind],
      storyId = 'ui-diffviewermigration--' + suffix;
    try {
      await page.clock.setFixedTime(new Date('2026-10-22T09:00:00Z'));
      await page.addInitScript(() => {
        window.__diffInputs = [];
        for (const type of ['pointerdown', 'keydown', 'wheel'])
          document.addEventListener(
            type,
            (e) =>
              window.__diffInputs.push({
                type,
                trusted: e.isTrusted,
                key: e.key ?? null,
                pointerType: e.pointerType ?? null,
              }),
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
      await page.locator('diffs-container [data-line]').first().waitFor({ state: 'visible' });
      await settle(page);
      const shot = async (name) => {
        current = name;
        // Visible code can precede the syntax Worker's colored DOM commit.
        // Accept the current theme's real tokenized rows, not its plain-text pass.
        await page.waitForFunction((expectedTheme) => {
          const shadow = document.querySelector('diffs-container')?.shadowRoot;
          if (!shadow?.querySelector('pre')) return true;
          return (
            shadow.querySelector('pre').getAttribute('data-theme-type') === expectedTheme &&
            !!shadow.querySelector('[data-column-content] > span[style*="color"]')
          );
        }, theme);
        await settle(page);
        await page.waitForFunction(
          () => {
            const shadow = document.querySelector('diffs-container')?.shadowRoot;
            const html = shadow?.innerHTML ?? '';
            const previous = window.__diffShadowStable ?? { html: '', equal: 0 };
            window.__diffShadowStable = {
              html,
              equal: previous.html === html ? previous.equal + 1 : 0,
            };
            return window.__diffShadowStable.equal >= 3;
          },
          undefined,
          { polling: 'raf' }
        );
        const key = `${storyId}__native-${kind}__${theme}__${name}`,
          file = `shots/${key}.png`;
        await page.screenshot({ path: path.join(out, file), caret: 'hide', animations: 'allow' });
        entries.push({
          key,
          state: name,
          storyId,
          title: 'UI/DiffViewerMigration — real shadow DOM',
          viewport: 'native-' + kind,
          theme,
          shot: file,
          layout: await page.evaluate(snapshot),
        });
        actions.push({ key, ...(await page.evaluate(details)) });
      };
      if (kind === 'responsive') {
        await page.getByRole('button', { name: 'Container 1023', exact: true }).click();
        await page.waitForFunction(
          () =>
            document.querySelector('[data-diff-width-host]').getBoundingClientRect().width ===
              1023 &&
            !!document
              .querySelector('diffs-container')
              ?.shadowRoot?.querySelector('code[data-unified]')
        );
        await shot('width-1023-unified');
        await page.getByRole('button', { name: 'Container 1024', exact: true }).click();
        await page.waitForFunction(
          () =>
            document.querySelector('[data-diff-width-host]').getBoundingClientRect().width ===
              1024 &&
            !!document
              .querySelector('diffs-container')
              ?.shadowRoot?.querySelector('code[data-additions]')
        );
        await shot('width-1024-split');
        const count = await page.locator('diffs-container [data-line]').count();
        await page
          .locator('diffs-container [data-expand-index="1"] [data-expand-up]')
          .first()
          .click();
        await page.waitForFunction(
          (n) =>
            (document.querySelector('diffs-container')?.shadowRoot?.querySelectorAll('[data-line]')
              .length ?? 0) > n,
          count
        );
        await shot('context-expanded');
        await page.getByRole('button', { name: 'Container 1023', exact: true }).click();
        await page.waitForFunction(
          () =>
            !!document
              .querySelector('diffs-container')
              ?.shadowRoot?.querySelector('code[data-unified]')
        );
        await shot('return-unified');
      } else if (kind === 'horizontal') {
        await shot('long-line-rest');
        const scroll = page.locator('diffs-container pre').first();
        await scroll.hover();
        await page.mouse.wheel(420, 0);
        await page.waitForFunction(() =>
          [
            ...document.querySelector('diffs-container').shadowRoot.querySelectorAll('pre,code'),
          ].some((e) => e.scrollLeft > 0)
        );
        await shot('long-line-scrolled');
      } else if (kind === 'comments') {
        await page
          .locator('diffs-container [data-column-content] > span[style*="color"]')
          .first()
          .waitFor({ state: 'visible' });
        const line = page
          .locator('diffs-container [data-line-type="change-addition"][data-line="2"]')
          .first();
        const add = page.getByRole('button', { name: 'Add comment', exact: true });
        // Tokenization can replace the hovered row; enter its committed DOM.
        for (let attempt = 0; attempt < 4; attempt += 1) {
          await page.mouse.move(0, 0);
          await line.hover();
          try {
            await add.waitFor({ state: 'visible', timeout: 1500 });
            break;
          } catch (error) {
            if (attempt === 3) throw error;
          }
        }
        await shot('actual-hover-utility');
        await add.click();
        const field = page.locator('textarea');
        await field.waitFor({ state: 'visible' });
        await field.fill('Synthetic local draft');
        await shot('draft-typed');
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
        await field.waitFor({ state: 'hidden' });
        await shot('draft-cancelled');
      } else if (kind === 'iphone' || kind === 'android') {
        await page
          .locator('diffs-container [data-column-content] > span[style*="color"]')
          .first()
          .waitFor({ state: 'visible' });
        await page
          .locator('diffs-container [data-line-type="change-addition"][data-line="2"]')
          .first()
          .tap();
        const field = page.locator('textarea');
        await field.waitFor({ state: 'visible' });
        await field.fill('Synthetic touch draft');
        await shot('line-tapped-draft');
        await page.getByRole('button', { name: 'Cancel', exact: true }).tap();
        await field.waitFor({ state: 'hidden' });
        await shot('touch-draft-cancelled');
        if (
          !(await page.evaluate(() =>
            window.__diffInputs.some((e) => e.trusted && e.pointerType === 'touch')
          ))
        )
          throw Error('Missing real trusted touch input');
      } else if (kind === 'selection') {
        await shot('before-selection');
        const content = page
            .locator(
              'diffs-container [data-line-type="change-addition"][data-line="2"] [data-column-content]'
            )
            .first(),
          b = await content.boundingBox();
        if (!b) throw Error('Missing actual code content');
        await page.mouse.move(b.x + 2, b.y + b.height / 2);
        await page.mouse.down();
        await page.mouse.move(b.x + 160, b.y + b.height / 2, { steps: 10 });
        await page.mouse.up();
        await page.waitForFunction(() => String(window.getSelection()).length > 0);
        await shot('native-selected-text');
      } else {
        await shot('motion-open');
        const hold = async (direction) =>
          page.evaluate((dir) => {
            window.__diffHeld = null;
            window.__diffMotionObserver?.disconnect();
            window.__diffMotionObserver = new MutationObserver(() => {
              for (const a of document.getAnimations()) {
                if (!(a instanceof CSSAnimation) || !a.animationName.includes('collapsible-' + dir))
                  continue;
                const d = a.effect?.getTiming().duration;
                if (typeof d !== 'number' || !d) continue;
                a.pause();
                a.currentTime = d / 2;
                window.__diffHeld = {
                  name: a.animationName,
                  duration: d,
                  currentTime: a.currentTime,
                };
                window.__diffMotionObserver.disconnect();
                break;
              }
            });
            window.__diffMotionObserver.observe(document.body, {
              subtree: true,
              attributes: true,
              attributeFilter: ['data-state', 'style'],
            });
          }, direction);
        await hold('up');
        await page.getByRole('button', { name: 'Toggle section', exact: true }).click();
        await page.waitForFunction(() => window.__diffHeld?.name.includes('collapsible-up'));
        await shot('collapse-half');
        await page.evaluate(() => {
          for (const a of document.getAnimations())
            if (a instanceof CSSAnimation && a.animationName.includes('collapsible-up')) {
              a.finish();
            }
        });
        await page.locator('diffs-container').waitFor({ state: 'hidden' });
        await shot('motion-closed');
        await hold('down');
        await page.getByRole('button', { name: 'Toggle section', exact: true }).click();
        await page.waitForFunction(() => window.__diffHeld?.name.includes('collapsible-down'));
        await shot('expand-half');
        await page.evaluate(() => {
          for (const a of document.getAnimations())
            if (a instanceof CSSAnimation && a.animationName.includes('collapsible-down'))
              a.finish();
        });
        await page.locator('diffs-container [data-line]').first().waitFor({ state: 'visible' });
        await shot('motion-reopened');
      }
    } catch (error) {
      const key = `${storyId}__native-${kind}__${theme}__${current}`;
      const file = `shots/${key}__error.png`;
      await page.screenshot({ path: path.join(out, file), caret: 'hide' }).catch(() => {});
      failures.push({ key, message: String(error.stack ?? error), shot: file });
      console.error(kind, theme, error.message);
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
      harnessFingerprint,
      targets: {
        themes: ['light', 'dark'],
        cases,
        viewport: { width: 1360, height: 1000 },
        clock: '2026-10-22T09:00:00Z',
        actualShadowRootTraversal: true,
      },
      expected: 40,
      capturedAt: new Date().toISOString(),
      entries,
    },
    null,
    2
  )
);
await writeFile(path.join(out, 'actions.json'), JSON.stringify(actions, null, 2));
await writeFile(path.join(out, 'failures.json'), JSON.stringify(failures, null, 2));
console.log(`${entries.length}/40 frames; ${failures.length} failures`);
if (failures.length) process.exitCode = 1;
