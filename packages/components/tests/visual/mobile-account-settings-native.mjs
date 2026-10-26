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
    .flatMap((arg, i, all) => (arg.startsWith('--') ? [[arg.slice(2), all[i + 1]]] : []))
);
if (!args.phase || !args.storybook) throw new Error('--phase and --storybook required');
const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(pkg, 'artifacts/visual', args.phase);
await mkdir(path.join(out, 'shots'), { recursive: true });
const iframe = await (await fetch(new URL('/iframe.html', args.storybook))).text();
assert.ok(!iframe.includes('/@vite/client'), 'Immutable Storybook required');
const index = await (await fetch(new URL('/index.json', args.storybook))).text();
const fingerprint = createHash('sha256').update(iframe).update(index).digest('hex');
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
  failures = [],
  externalRequests = [],
  browserErrors = [];
const prefix = 'mobile-ownedmobileaccountsettingsmigration--';
const properties = [
  'display',
  'position',
  'inset',
  'zIndex',
  'width',
  'height',
  'minWidth',
  'maxWidth',
  'flex',
  'flexDirection',
  'flexShrink',
  'alignItems',
  'justifyContent',
  'gap',
  'margin',
  'padding',
  'borderWidth',
  'borderColor',
  'borderRadius',
  'boxShadow',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'fontVariantLigatures',
  'color',
  'backgroundColor',
  'opacity',
  'pointerEvents',
  'cursor',
  'outline',
  'transform',
  'translate',
  'rotate',
  'whiteSpace',
  'overflow',
  'textOverflow',
];
const settle = async (page) => {
  await page.evaluate(async () => {
    await document.fonts.ready;
    const animations = document
      .getAnimations()
      .filter((animation) => animation.effect?.getTiming().iterations === Infinity);
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = 0;
    }
    await Promise.all(animations.map((animation) => animation.ready));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
      .every((animation) => animation.playState !== 'running')
  );
  await page.evaluate(() => {
    delete window.__mobileAccountStable;
  });
  await page.waitForFunction(() => {
    const value = JSON.stringify(
      [
        ...document.querySelectorAll(
          '#storybook-root *,[role="dialog"] *,[role="alertdialog"] *,[role="menu"] *'
        ),
      ].map((node) => {
        const rect = node.getBoundingClientRect(),
          css = getComputedStyle(node);
        return [
          rect.x,
          rect.y,
          rect.width,
          rect.height,
          css.transform,
          css.color,
          css.backgroundColor,
          css.opacity,
        ];
      })
    );
    const old = window.__mobileAccountStable ?? { value: '', count: 0 };
    old.count = old.value === value ? old.count + 1 : 0;
    old.value = value;
    window.__mobileAccountStable = old;
    return old.count >= 4;
  });
};
const complete = async (page, reject = false) => {
  // Completes only the fixture's synthetic backend Promise; product state follows
  // the same callback resolution/rejection as the real container boundary.
  await page.evaluate(
    (eventName) => window.dispatchEvent(new Event(eventName)),
    reject ? 'mobile-account-reject' : 'mobile-account-complete'
  );
  await expect(page.locator('[data-mobile-account-pending]')).toHaveCount(0);
};
let expected = 0;
try {
  for (const viewport of [
    { name: 'desktop', options: { viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 1 } },
    {
      name: 'iphone-chromium',
      options: {
        ...devices['iPhone 13'],
        viewport: { width: 390, height: 1000 },
        deviceScaleFactor: 1,
      },
    },
  ])
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        ...viewport.options,
        colorScheme: theme,
        reducedMotion: 'reduce',
        locale: 'en-US',
        timezoneId: 'UTC',
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
      const scenarios = [
        'account',
        'account-root-variables',
        'account-subtree-variables',
        'workspace',
        'workspace-subtree-variables',
        'workspace-member',
        ...(viewport.name === 'iphone-chromium' ? ['ios-branch-emulation'] : []),
      ];
      for (const scenario of scenarios) {
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        page.on('pageerror', (error) => browserErrors.push({ scenario, error: String(error) }));
        const id = prefix + (scenario === 'ios-branch-emulation' ? 'account' : scenario);
        const keyPrefix = `${scenario}__${viewport.name}__${theme}`;
        const shot = async (state, assertions = {}) => {
          await settle(page);
          const key = `${keyPrefix}__${state}`;
          const observation = await page.evaluate(
            (names) => ({
              layout: [
                ...document.querySelectorAll(
                  '#storybook-root *,[role="dialog"] *,[role="alertdialog"] *,[role="menu"] *'
                ),
              ].map((node, i) => {
                const rect = node.getBoundingClientRect(),
                  css = getComputedStyle(node);
                return {
                  path: String(i),
                  tag: node.tagName,
                  text: node.childElementCount ? '' : node.textContent,
                  label: node.getAttribute('aria-label'),
                  role: node.getAttribute('role'),
                  rect: [rect.x, rect.y, rect.width, rect.height],
                  styles: Object.fromEntries(names.map((name) => [name, css[name]])),
                  active: document.activeElement === node,
                  focusVisible: node.matches(':focus-visible'),
                  disabled: node.matches(':disabled'),
                  input:
                    node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement
                      ? node.value
                      : null,
                  pseudo: {
                    before: getComputedStyle(node, '::before').content,
                    after: getComputedStyle(node, '::after').content,
                  },
                };
              }),
              result: document.querySelector('[data-mobile-account-result]').textContent,
              pending:
                document
                  .querySelector('[data-mobile-account-pending]')
                  ?.getAttribute('data-mobile-account-pending') ?? null,
              events: window.__mobileAccountInputs,
              viewport: [innerWidth, document.documentElement.scrollWidth],
            }),
            properties
          );
          await page.screenshot({
            path: path.join(out, 'shots', `${key}.png`),
            animations: 'allow',
            caret: 'hide',
          });
          entries.push({
            key,
            id,
            state,
            scenario,
            viewport: viewport.name,
            theme,
            shot: `shots/${key}.png`,
            assertions,
            ...observation,
          });
          console.log(key);
        };
        expected += scenario.startsWith('account')
          ? 6
          : scenario.startsWith('workspace') && scenario !== 'workspace-member'
            ? 4
            : scenario === 'workspace-member'
              ? 2
              : 2;
        try {
          await page.clock.setFixedTime(new Date('2026-10-22T09:00:00Z'));
          await page.addInitScript((emulateIOS) => {
            window.__mobileAccountInputs = [];
            for (const type of ['pointerdown', 'pointerup', 'keydown', 'click'])
              document.addEventListener(
                type,
                (event) =>
                  window.__mobileAccountInputs.push({
                    type,
                    trusted: event.isTrusted,
                    pointerType: event.pointerType ?? null,
                    key: event.key ?? null,
                  }),
                true
              );
            if (emulateIOS)
              window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' };
          }, scenario === 'ios-branch-emulation');
          const url = new URL('/iframe.html', args.storybook);
          url.search = new URLSearchParams({
            id,
            viewMode: 'story',
            globals: `theme:${theme};locale:en`,
          });
          await page.goto(url.href);
          await page.locator('[data-mobile-account-fixture]').waitFor();
          const result = page.locator('[data-mobile-account-result]');
          const action = (name) => page.getByRole('button', { name, exact: true });
          if (scenario.startsWith('account')) {
            await action('Edit name').focus();
            await page.keyboard.press('Enter');
            const input = page.locator('#profile-name-mobile');
            await input.fill('Native renamed account 中文');
            await input.press('Enter');
            await expect(action('Edit name')).toBeDisabled();
            await expect(result).toHaveText('Account name Native renamed account 中文');
            await shot('name-pending', { keyboardNameCommit: true });
            await complete(page);
            await expect(action('Edit name')).toBeEnabled();
            await action('Edit name').click();
            await input.fill('Rejected account name');
            await input.press('Enter');
            await complete(page, true);
            await expect(action('Edit name')).toContainText('Native renamed account 中文');
            await shot('name-rejected', { rollbackPreserved: true });
            await action('Create token').click();
            const dialog = page.getByRole('dialog');
            await dialog.waitFor();
            await page.locator('#cli-api-key-note').fill('Native synthetic note 中文');
            await dialog.getByRole('button', { name: 'Create token', exact: true }).click();
            await expect(result).toHaveText('Create key Native synthetic note 中文');
            await expect(
              dialog.locator('button').filter({ hasText: /^Create token$/ })
            ).toBeDisabled();
            await shot('key-create-pending', { modalCallback: true });
            await complete(page);
            await dialog.getByRole('button', { name: 'Copy token', exact: true }).click();
            await expect(result).toHaveText('Copied synthetic generated key');
            await shot('key-generated', { copyCallback: true });
            await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
            await expect(dialog).toHaveCount(0);
            await action('Revoke').first().click();
            const confirm = page.getByRole('alertdialog');
            await confirm.waitFor();
            await confirm.getByRole('button', { name: 'Revoke token', exact: true }).click();
            await expect(result).toHaveText('Revoke key synthetic-key');
            await expect(
              page
                .locator('button')
                .filter({ hasText: /^Revoke$/ })
                .first()
            ).toBeDisabled();
            await shot('key-revoke-pending', {
              callback: true,
              alertDialogOpen: await confirm.count(),
            });
            await complete(page);
            await expect(action('Revoke')).toHaveCount(1);
            await shot('key-revoked', { recordRemoved: true });
          } else if (scenario !== 'workspace-member' && scenario.startsWith('workspace')) {
            await action('Rename workspace').click();
            await page.locator('#workspace-name-mobile').fill('Native renamed workspace 中文');
            await page.locator('#workspace-name-mobile').press('Enter');
            await expect(action('Rename workspace')).toBeDisabled();
            await shot('name-pending', { callback: true });
            await complete(page, true);
            await expect(action('Rename workspace')).toContainText('Synthetic Research Workspace');
            await action('Member').click();
            await page.getByRole('menuitemradio', { name: 'Admin', exact: true }).click();
            await expect(result).toHaveText('Role other-membership admin');
            await shot('role-updated', { roleCallback: true });
            await action('Cancel').click();
            await expect(result).toHaveText('Cancel invitation synthetic-invitation');
            await shot('invitation-pending', { cancelCallback: true });
            await complete(page);
            await expect(
              page.getByText('synthetic.pending.invitation.with.a.long.address@example.com', {
                exact: true,
              })
            ).toHaveCount(0);
            await shot('invitation-removed', { removed: true });
          } else if (scenario === 'workspace-member') {
            await action('Leave Workspace').click();
            const dialog = page.getByRole('alertdialog');
            await dialog.waitFor();
            await shot('leave-dialog');
            await dialog.getByRole('button', { name: 'Leave', exact: true }).click();
            await expect(result).toHaveText('Leave workspace');
            await shot('leave-pending', {
              alertDialogOpen: await dialog.count(),
              pendingCallbackObserved: true,
            });
            await complete(page);
          } else {
            await action('Delete Account').click();
            const dialog = page.getByRole('dialog');
            await dialog.waitFor();
            await expect(
              dialog.getByRole('button', { name: 'Delete account', exact: true })
            ).toBeDisabled();
            await shot('delete-invalid', {
              environment:
                'Chromium with synthetic Capacitor iOS identity; not WebKit or actual native shell',
            });
            await page
              .locator('#mobileDeleteAccountConfirmText')
              .fill('synthetic.account.with.a.long.address@example.com');
            await dialog.getByRole('button', { name: 'Delete account', exact: true }).click();
            await expect(result).toHaveText('Delete account');
            await expect(
              dialog.locator('button').filter({ hasText: /^Processing\.\.\.$/ })
            ).toBeDisabled();
            await shot('delete-pending', { syntheticCallbackOnly: true });
            await complete(page);
          }
        } catch (error) {
          console.error(keyPrefix, String(error));
          failures.push({ key: keyPrefix, error: String(error) });
          await page
            .screenshot({
              path: path.join(out, 'shots', `${keyPrefix}__error.png`),
              animations: 'disabled',
            })
            .catch(() => {});
        } finally {
          await page.close();
        }
      }
      await context.close();
    }
} finally {
  await writeFile(
    path.join(out, 'manifest.json'),
    JSON.stringify(
      {
        phase: args.phase,
        storybook: args.storybook,
        fingerprint,
        harnessSha: createHash('sha256')
          .update(await readFile(fileURLToPath(import.meta.url)))
          .digest('hex'),
        browserVersion: browser.version(),
        animationControl:
          'Only infinite animations paused at time0; ready/compositor paint and finite animation/stable geometry awaited. Product state unchanged.',
        expected,
        entries,
        failures,
        externalRequests,
        browserErrors,
      },
      null,
      2
    ) + '\n'
  );
  await browser.close();
}
console.log(
  JSON.stringify({ expected, entries: entries.length, failures, externalRequests, browserErrors })
);
assert.equal(failures.length, 0);
assert.equal(entries.length, expected);
assert.equal(externalRequests.length, 0);
assert.equal(browserErrors.length, 0);
