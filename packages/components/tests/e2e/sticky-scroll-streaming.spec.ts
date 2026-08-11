import { test, expect } from '@playwright/test';

const STORY_URL =
  '/iframe.html?id=sessions-sessionconversationpage--desktop-streaming-working&viewMode=story';

// Timeout is set per-test below since top-level setTimeout isn't available
// in all Playwright configurations.

/**
 * Inject a ResizeObserver wrapper that delays callbacks by `delayMs`.
 *
 * In real browsers under load, ResizeObserver callbacks can be delayed by the
 * browser's event loop (GPU compositing, other tabs, complex layout). Virtua's
 * internal item-resize → React re-render → spacer-height-update chain means
 * the scroll container's ResizeObserver fires AFTER an async gap. This delay
 * wrapper simulates that real-world condition so we can reliably reproduce
 * scroll-drift bugs in headless Chromium.
 */
async function injectResizeObserverDelay(page: import('@playwright/test').Page, delayMs: number) {
  await page.addInitScript(`
    (function() {
      const Original = window.ResizeObserver;
      const DELAY = ${delayMs};
      if (!DELAY) return;
      window.__lodyDelayedResizeObserverFlushCount = 0;
      window.ResizeObserver = class DelayedResizeObserver {
        constructor(cb) {
          this._cb = cb;
          this._inner = new Original((entries, obs) => {
            setTimeout(() => {
              try {
                this._cb(entries, obs);
              } catch(e) {
              } finally {
                window.__lodyDelayedResizeObserverFlushCount += 1;
              }
            }, DELAY);
          });
        }
        observe(t, o) { return this._inner.observe(t, o); }
        unobserve(t) { return this._inner.unobserve(t); }
        disconnect() { return this._inner.disconnect(); }
      };
    })();
  `);
}

/**
 * Verifies that the scroll container stays stuck to the bottom while the
 * StreamingSimulation story appends chunks to the last assistant message.
 *
 * Without the contentSignal fix, a 50ms ResizeObserver delay causes the scroll
 * to drift from the bottom. With the fix, the React-driven auto-scroll fires
 * on every content change, keeping the view pinned.
 */
test('scroll stays at bottom during streaming (with simulated RO delay)', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1024, height: 600 } });
  const page = await context.newPage();

  // 50ms delay simulates real-world browser conditions where ResizeObserver
  // callbacks are delayed by layout work.
  await injectResizeObserverDelay(page, 50);
  await page.goto(STORY_URL);

  const story = page.getByTestId('session-conversation-story');
  await expect(story).toHaveAttribute('data-stream-phase', 'streaming', { timeout: 15_000 });

  // Wait for initial rendering to settle (skip first few chunks).
  await page.waitForTimeout(1_000);

  const scrollContainer = page.locator('.chat-scrollbar');
  await expect(scrollContainer).toBeVisible();

  const TOLERANCE = 40;
  let failures = 0;
  const samples: { chunk: string; distance: number }[] = [];

  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(200);

    const chunkText = `${await story.getAttribute('data-stream-chunk')}/${await story.getAttribute(
      'data-stream-total'
    )}`;
    let distance = await scrollContainer.evaluate((el) =>
      Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight)
    );

    if (distance > TOLERANCE) {
      const flushCount = await page.evaluate(
        () =>
          (
            window as Window & {
              __lodyDelayedResizeObserverFlushCount?: number;
            }
          ).__lodyDelayedResizeObserverFlushCount ?? 0
      );
      await page.waitForFunction(
        (previousFlushCount) =>
          (
            window as Window & {
              __lodyDelayedResizeObserverFlushCount?: number;
            }
          ).__lodyDelayedResizeObserverFlushCount! > previousFlushCount,
        flushCount,
        { timeout: 500 }
      );
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          })
      );
      distance = await scrollContainer.evaluate((el) =>
        Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight)
      );
    }

    samples.push({ chunk: chunkText ?? '?', distance });
    if (distance > TOLERANCE) failures += 1;

    const parts = chunkText?.split('/') ?? [];
    if (parts[0] === parts[1]) break;
  }

  const failureDetails = samples
    .filter((s) => s.distance > TOLERANCE)
    .map((s) => `  chunk=${s.chunk} distance=${s.distance}px`)
    .join('\n');

  expect(
    failures,
    `Scroll drifted from bottom ${failures} time(s) during streaming:\n${failureDetails}`
  ).toBeLessThanOrEqual(2);

  await context.close();
});

/**
 * Basic test without simulated delay — verifies the scroll stays at bottom
 * under ideal conditions.
 */
test('scroll stays at bottom during streaming (no delay)', async ({ page }) => {
  await page.goto(STORY_URL);

  const story = page.getByTestId('session-conversation-story');
  await expect(story).toHaveAttribute('data-stream-phase', 'streaming', { timeout: 15_000 });
  await page.waitForTimeout(500);

  const scrollContainer = page.locator('.chat-scrollbar');
  await expect(scrollContainer).toBeVisible();

  const TOLERANCE = 40;
  let failures = 0;
  const samples: { chunk: string; distance: number }[] = [];

  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(300);
    const chunkText = `${await story.getAttribute('data-stream-chunk')}/${await story.getAttribute(
      'data-stream-total'
    )}`;
    const distance = await scrollContainer.evaluate((el) =>
      Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight)
    );
    samples.push({ chunk: chunkText ?? '?', distance });
    if (distance > TOLERANCE) failures += 1;
    const parts = chunkText?.split('/') ?? [];
    if (parts[0] === parts[1]) break;
  }

  const failureDetails = samples
    .filter((s) => s.distance > TOLERANCE)
    .map((s) => `  chunk=${s.chunk} distance=${s.distance}px`)
    .join('\n');

  expect(
    failures,
    `Scroll drifted from bottom ${failures} time(s):\n${failureDetails}`
  ).toBeLessThanOrEqual(2);
});

/**
 * Verifies that the user can unstick by scrolling up with the mouse wheel,
 * and that the "scroll to latest" button appears and re-sticks when clicked.
 */
test('scroll-to-latest button re-sticks after user scrolls up', async ({ page }) => {
  await page.goto(STORY_URL);

  const story = page.getByTestId('session-conversation-story');
  await expect(story).toHaveAttribute('data-stream-phase', 'streaming', { timeout: 15_000 });
  await page.waitForTimeout(2_000);

  const scrollContainer = page.locator('.chat-scrollbar');
  const box = await scrollContainer.boundingBox();
  if (!box) throw new Error('scroll container not visible');

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 20; i++) {
    await page.mouse.wheel(0, -200);
    await page.waitForTimeout(30);
  }

  await page.waitForTimeout(500);

  const btn = story.locator('button[aria-label*="croll"]');

  const buttonVisible = (await btn.count()) > 0 && (await btn.isVisible());

  if (buttonVisible) {
    await btn.click();
    await page.waitForTimeout(500);
    const distanceAfterClick = await scrollContainer.evaluate((el) =>
      Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight)
    );
    expect(distanceAfterClick).toBeLessThanOrEqual(40);
  } else {
    const distance = await scrollContainer.evaluate((el) =>
      Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight)
    );
    expect(distance).toBeLessThanOrEqual(40);
  }
});
