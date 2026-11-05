import { expect, test, type Page } from '@playwright/test';

/**
 * The native mobile shell pins `html`, `body` and `#root` to the viewport with
 * `overflow: hidden`, so a full-window page must be its own scroll container.
 * The encrypted workspace pages used `min-height: 100vh` with `overflow-y: auto`:
 * the box grew with its content, never scrolled, and the shell clipped what fell
 * below the fold. On a phone that left "Open workspace" and the lower controls
 * unreachable.
 *
 * Real geometry is the assertion: jsdom has no layout.
 */
const SHELL = `
  html, body, #storybook-root { height: 100%; overflow: hidden; margin: 0; }
`;

async function openInPhoneShell(page: Page, story: string, size = { width: 390, height: 844 }) {
  await page.setViewportSize(size);
  const cdp = await page.context().newCDPSession(page);
  // iPhone portrait insets; the pages pad by them.
  await cdp.send('Emulation.setSafeAreaInsetsOverride', {
    insets: { top: 47, bottom: 34, left: 0, right: 0 },
  });
  await page.goto(`/iframe.html?id=${story}&viewMode=story`);
  await page.addStyleTag({ content: SHELL });
}

/** The point at the element's centre is inside the viewport and lands on it. No
 * helper scrolling: Playwright would scroll the clipped shell itself, which a
 * finger cannot. */
async function expectHittable(page: Page, name: RegExp) {
  const target = page.getByRole('button', { name });
  const box = await target.boundingBox();
  if (!box) throw new Error(`missing ${name}`);
  const viewport = page.viewportSize()!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  expect(y, `${name} centre inside the viewport`).toBeGreaterThan(0);
  expect(y, `${name} centre inside the viewport`).toBeLessThan(viewport.height);
  const hit = await page.evaluate(
    ([px, py]) => document.elementFromPoint(px!, py!)?.closest('button')?.textContent ?? null,
    [x, y]
  );
  expect(hit).toMatch(name);
}

/** The page scrolls itself, and every part of it can reach the viewport. */
async function expectWholePageReachable(page: Page, root: string) {
  const metrics = await page.locator(root).evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    const last = element.lastElementChild!.getBoundingClientRect();
    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrolled: element.scrollTop,
      lastBottom: last.bottom,
      viewport: window.innerHeight,
    };
  });
  expect(metrics.clientHeight).toBeLessThanOrEqual(metrics.viewport);
  if (metrics.scrollHeight > metrics.clientHeight) expect(metrics.scrolled).toBeGreaterThan(0);
  expect(metrics.lastBottom).toBeLessThanOrEqual(metrics.viewport);
}

test('the encrypted workspace control page scrolls inside the phone shell', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'safe-area emulation is Chromium-only');
  await openInPhoneShell(page, 'pages-encryptedworkspace--team-history-ready-to-open');
  await expect(page.getByTestId('e2ee-workspace-control')).toBeVisible();
  await expectHittable(page, /Open workspace/);
  // The ledger runs past the fold on a phone; the page must still reach its end.
  const tall = await page
    .locator('main')
    .first()
    .evaluate((element) => element.scrollHeight > window.innerHeight);
  expect(tall, 'the fixture is taller than the phone').toBe(true);
  await expectWholePageReachable(page, 'main');
  // Back at the top, the primary action is still there to tap.
  await page
    .locator('main')
    .first()
    .evaluate((element) => element.scrollTo({ top: 0 }));
  await expectHittable(page, /Open workspace/);
});

test('the device approval guide scrolls inside the phone shell', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'safe-area emulation is Chromium-only');
  // A phone on its side: the guide no longer fits and must scroll to its actions.
  await openInPhoneShell(page, 'pages-encryptedworkspace-deviceapprovalguide--waiting', {
    width: 844,
    height: 390,
  });
  const guide = page.getByTestId('e2ee-device-approval-guide');
  await expect(guide).toBeVisible();
  await expectWholePageReachable(page, '[data-testid="e2ee-device-approval-guide"]');
  await expectHittable(page, /Check again/);
});
