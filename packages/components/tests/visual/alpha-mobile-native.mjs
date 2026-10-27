/** Real mobile sheets; restored reference changes only the locked Tailwind declarations. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from '@playwright/test';
const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, x) => (a.startsWith('--') ? [[a.slice(2), x[i + 1]]] : []))
);
if (!args.phase || !args.storybook) throw new Error('--phase and --storybook required');
const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hash = (data) => createHash('sha256').update(data).digest('hex');
const restored = args['restore-original'] === 'true';
const iframe = await (await fetch(new URL('/iframe.html', args.storybook))).text();
if (iframe.includes('/@vite/client') && args.calibrate !== 'true')
  throw new Error('Immutable build required');
const index = await (await fetch(new URL('/index.json', args.storybook))).json();
const profile = JSON.parse(
  await readFile(path.join(pkg, 'tests/visual/alpha-mobile-targets.json'), 'utf8')
);
const out = path.join(pkg, 'artifacts/visual', args.phase);
await mkdir(path.join(out, 'shots'), { recursive: true });
let browser;
try {
  browser = await chromium.launch();
} catch {
  const revisions = (await readdir(path.join(os.homedir(), 'Library/Caches/ms-playwright')))
    .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
    .sort((a, b) => +b.split('-').at(-1) - +a.split('-').at(-1));
  browser = await chromium.launch({
    executablePath: path.join(
      os.homedir(),
      'Library/Caches/ms-playwright',
      revisions[0],
      'chrome-headless-shell-mac-arm64/chrome-headless-shell'
    ),
  });
}
const entries = [],
  failures = [],
  observations = [];
// Exact compiler output is recorded independently in alpha-five-file-audit.json.
const contract = (apply) => {
  const root = document.querySelector('[role="dialog"]');
  if (!root) return [];
  const rows = [];
  const set = (key, el, property, value) => {
    if (!el) throw new Error(`Missing reference node ${key}`);
    if (apply) el.style[property] = value;
    const s = getComputedStyle(el),
      r = el.getBoundingClientRect();
    rows.push({
      key,
      text: el.textContent.trim().slice(0, 100),
      property,
      expected: value,
      actual: s[property],
      hover: el.matches(':hover'),
      rect: [r.x, r.y, r.width, r.height],
    });
  };
  const mix = (token, n) => `color-mix(in oklab, hsl(var(--${token}) / 1) ${n}%, transparent)`;
  if (root.querySelector('button[aria-current]')) {
    for (const [i, b] of [...root.querySelectorAll('button[aria-current]')].entries()) {
      const active = b.getAttribute('aria-current') === 'true';
      set(
        `tab.${i}.${active ? 'active' : 'actionable'}`,
        b,
        'backgroundColor',
        active
          ? mix('muted-foreground', 10)
          : matchMedia('(hover: hover)').matches && b.matches(':hover')
            ? mix('muted-foreground', 5)
            : 'rgba(0, 0, 0, 0)'
      );
      if (!active) {
        const second = b.children[1];
        set(
          `tab.${i}.titleIdle`,
          second.children.length ? second.firstElementChild : second,
          'color',
          mix('foreground', 90)
        );
      }
    }
    const newChat = [...root.querySelectorAll('button')].find(
      (e) => e.textContent.trim() === 'New Chat'
    );
    if (newChat)
      set(
        'newChat.hoverInk',
        newChat,
        'color',
        matchMedia('(hover: hover)').matches && newChat.matches(':hover')
          ? 'hsl(var(--foreground) / 1)'
          : 'hsl(var(--muted-foreground) / 1)'
      );
    for (const [i, e] of [...root.querySelectorAll('div')]
      .filter(
        (groupNode) =>
          groupNode.children.length === 0 &&
          ['Conversations', 'Viewers'].includes(groupNode.textContent.trim())
      )
      .entries())
      set(`group.${i}`, e, 'color', mix('muted-foreground', 70));
    for (const [i, b] of [
      ...root.querySelectorAll(
        'button[aria-label="Reopen conversation"],button[aria-label="Restore session"]'
      ),
    ].entries()) {
      set(
        `closed.${i}.actionable`,
        b,
        'backgroundColor',
        matchMedia('(hover: hover)').matches && b.matches(':hover')
          ? mix('muted-foreground', 5)
          : 'rgba(0, 0, 0, 0)'
      );
      set(`closed.${i}.elapsedClosed`, b.children[2], 'color', mix('muted-foreground', 70));
      set(`closed.${i}.restoreGlyph`, b.lastElementChild, 'color', mix('muted-foreground', 70));
    }
  }
  return rows;
};
const layout = () =>
  [...document.body.querySelectorAll('*')]
    .filter(
      (e) => !['SCRIPT', 'STYLE', 'LINK'].includes(e.tagName) && !e.closest('[data-sb-builder]')
    )
    .map((e, i) => {
      const s = getComputedStyle(e),
        r = e.getBoundingClientRect();
      return {
        path: String(i),
        tag: e.tagName.toLowerCase(),
        text: e.textContent.trim().slice(0, 70),
        rect: [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 100) / 100),
        ...Object.fromEntries(
          [
            'fontFamily',
            'fontSize',
            'fontWeight',
            'lineHeight',
            'color',
            'backgroundColor',
            'borderTopColor',
            'borderRadius',
            'opacity',
            'boxShadow',
          ].map((k) => [k, s[k]])
        ),
      };
    });
for (const viewport of profile.viewports.filter((v) => !args.onlyview || v.name === args.onlyview))
  for (const theme of args.probe ? ['light'] : profile.themes)
    for (const suffix of ['tabs-all-states'].filter((x) => !args.only || x.includes(args.only))) {
      const context = await browser.newContext({
        ...(viewport.device ? devices[viewport.device] : {}),
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();
      await page.clock.setFixedTime(new Date('2026-10-22T09:00:00Z'));
      await page.addInitScript(() => {
        window.__alphaInput = [];
        for (const type of ['pointerdown', 'pointerup', 'click', 'keydown'])
          document.addEventListener(
            type,
            (e) =>
              window.__alphaInput.push({
                type,
                trusted: e.isTrusted,
                pointerType: e.pointerType ?? null,
                key: e.key ?? null,
              }),
            true
          );
      });
      const id = `mobile-alphamobilemigration--${suffix}`;
      let state = 'rest';
      try {
        const url = new URL('/iframe.html', args.storybook);
        url.search = new URLSearchParams({
          id,
          viewMode: 'story',
          globals: `theme:${theme};locale:en`,
        });
        await page.goto(url.href);
        await page.locator('[role=dialog]').waitFor();
        await page.evaluate(() => document.fonts.ready);
        const settle = async () => {
          await page.waitForFunction(
            () =>
              document
                .getAnimations()
                .filter((a) => a.effect?.getTiming().iterations !== Infinity)
                .every((a) => a.playState !== 'running'),
            undefined,
            { timeout: 15000 }
          );
          await page.evaluate(() => {
            window.__alphaStable = { current: '', stable: 0 };
          });
          await page.waitForFunction(
            () => {
              const current = JSON.stringify(
                [...document.body.querySelectorAll('*')]
                  .filter((e) => !['SCRIPT', 'STYLE', 'LINK'].includes(e.tagName))
                  .map((e) => {
                    const r = e.getBoundingClientRect(),
                      s = getComputedStyle(e);
                    return [
                      r.x,
                      r.y,
                      r.width,
                      r.height,
                      s.opacity,
                      s.filter,
                      s.backdropFilter,
                      e.matches('[role=dialog],[data-vaul-overlay]') ? s.transform : null,
                    ];
                  })
              );
              const stability = window.__alphaStable;
              stability.stable = stability.current === current ? stability.stable + 1 : 0;
              stability.current = current;
              return (
                stability.stable >= 3 &&
                document
                  .getAnimations()
                  .filter((a) => a.effect?.getTiming().iterations !== Infinity)
                  .every((a) => a.playState !== 'running')
              );
            },
            undefined,
            { timeout: 15000, polling: 100 }
          );
        };
        const shot = async (name) => {
          state = name;
          await settle();
          const controls = await page.evaluate(contract, restored);
          await settle();
          const key = `${id}__${viewport.name}__${theme}__${name}`;
          const filename = `shots/${key}.png`;
          await page.screenshot({
            path: path.join(out, filename),
            animations: 'disabled',
            caret: 'hide',
          });
          entries.push({
            key,
            state: name,
            storyId: id,
            title: index.entries[id]?.title,
            viewport: viewport.name,
            theme,
            shot: filename,
            layout: await page.evaluate(layout),
          });
          observations.push({
            key,
            controls,
            ...(await page.evaluate(() => ({
              hoverMedia: matchMedia('(hover:hover)').matches,
              pointerFine: matchMedia('(pointer:fine)').matches,
              inputs: window.__alphaInput,
              overflow: document.documentElement.scrollWidth > innerWidth,
            }))),
          });
        };
        const activate = async (locator) =>
          viewport.device ? await locator.tap() : await locator.click();
        await page.mouse.move(-10, -10);
        await shot('rest');
        if (suffix === 'tabs-all-states') {
          const idle = page.locator('button[aria-current="false"]').first();
          if (viewport.device) {
            const b = await idle.boundingBox();
            const cdp = await context.newCDPSession(page);
            await cdp.send('Input.dispatchTouchEvent', {
              type: 'touchStart',
              touchPoints: [{ x: b.x + b.width / 2, y: b.y + b.height / 2 }],
            });
            await shot('touch-held-idle');
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
            await cdp.detach();
            await idle.hover();
            await shot('mouse-hover-under-mobile-media');
            await page.mouse.move(-10, -10);
          } else {
            await idle.hover();
            await shot('idle-hover');
            await page.mouse.move(-10, -10);
            await idle.focus();
            await idle.press('ArrowLeft');
            await shot('idle-keyboard-focus');
          }
          await page.getByRole('button', { name: 'New Chat', exact: true }).hover();
          await shot(
            viewport.device ? 'new-chat-mouse-hover-under-mobile-media' : 'new-chat-hover'
          );
          await page.mouse.move(-10, -10);
          await activate(page.locator('button[aria-expanded]'));
          await page.getByText('Closed synthetic conversation', { exact: false }).waitFor();
          await page.mouse.move(-10, -10);
          await shot('closed-list');
          await activate(page.getByRole('button', { name: 'Reopen conversation', exact: true }));
          await page.locator('[role=dialog]').waitFor({ state: 'hidden' });
          if ((await page.locator('[data-alpha-tabs-output]').textContent()) !== 'Restored: closed')
            throw new Error('Restore callback result missing');
          await activate(page.getByRole('button', { name: 'Open session tabs' }));
          await page.locator('[role=dialog]').waitFor();
          await shot('reopened-after-restore');
          await activate(page.locator('button[aria-current="false"]').first());
          await page.locator('[role=dialog]').waitFor({ state: 'hidden' });
          if ((await page.locator('[data-alpha-tabs-output]').textContent()) !== 'Selected: idle')
            throw new Error('Selection callback result missing');
          await activate(page.getByRole('button', { name: 'Open session tabs' }));
          await page.locator('[role=dialog]').waitFor();
          await shot('selected-idle-reopened');
        }
      } catch (e) {
        const key = `${id}__${viewport.name}__${theme}__${state}`;
        await page
          .screenshot({ path: path.join(out, 'shots', `${key}__error.png`) })
          .catch(() => null);
        failures.push({ key, message: String(e.stack ?? e) });
      } finally {
        await context.close();
      }
      console.log(
        `${args.phase}: ${viewport.name}/${theme}/${suffix}: ${entries.length} frames, ${failures.length} failures`
      );
    }
await browser.close();
const metadata = {
  phase: args.phase,
  baseUrl: args.storybook,
  restoredOriginalTailwindContract: restored,
  referenceScope:
    'Exact Tailwind-origin session-tab alpha declarations and the New Chat hover media condition; actual current production DOM, not historical UI.',
  buildFingerprint: hash(iframe + JSON.stringify(index)),
  harnessFingerprint: hash(await readFile(fileURLToPath(import.meta.url))),
  targetsFingerprint: hash(JSON.stringify(profile)),
  capturedAt: new Date().toISOString(),
  entries,
};
await writeFile(path.join(out, 'manifest.json'), JSON.stringify(metadata, null, 2));
await writeFile(path.join(out, 'failures.json'), JSON.stringify(failures, null, 2));
await writeFile(path.join(out, 'observations.json'), JSON.stringify(observations, null, 2));
if (failures.length) process.exitCode = 1;
