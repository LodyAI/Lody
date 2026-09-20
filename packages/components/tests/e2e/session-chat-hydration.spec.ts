import { expect, test } from '@playwright/test';

test('mobile leading content clears the header before and after history hydration', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    '/iframe.html?id=sessions-sessionchathydration--mobile-leading-content&viewMode=story',
    { waitUntil: 'domcontentloaded' }
  );
  const loadHistory = page.getByRole('button', { name: 'Load history', exact: true });
  await loadHistory.waitFor({ state: 'visible' });
  const viewport = page.getByTestId('chat-hydration-viewport');
  const leading = page.getByText('Conversation provenance', { exact: true });
  const activity = page.getByText('Waiting for permission', { exact: true });
  await expect(leading).toBeVisible();
  const viewportBox = (await viewport.boundingBox())!;
  const leadingBox = (await leading.boundingBox())!;
  // The 64px floating header plus the same 24px gutter as populated history.
  expect(leadingBox.y).toBeCloseTo(viewportBox.y + 64 + 24, 0);
  const activityBox = (await activity.boundingBox())!;
  expect(activityBox.y).toBeGreaterThanOrEqual(leadingBox.y + leadingBox.height);
  // Activity follows the leading row; it must not apply the header inset again.
  expect(activityBox.y - leadingBox.y - leadingBox.height).toBeLessThan(24);
  await loadHistory.click();
  await expect(leading).toBeInViewport();
  await expect(
    page.getByText('The first user message must remain visible.', { exact: true })
  ).toBeInViewport();
  expect((await leading.boundingBox())!.y).toBeCloseTo(leadingBox.y, 0);
});

for (const leading of ['empty', 'visible']) {
  test(`first user message survives history hydration with ${leading} leading content`, async ({
    page,
  }) => {
    // Record the real measurement boundary before loading history. On the
    // regressed implementation the empty placeholder must have reached Virtua's
    // zero-height cache; merely waiting for React to mount would race that step.
    await page.addInitScript(() => {
      const measured = new WeakSet<Element>();
      const NativeResizeObserver = window.ResizeObserver;
      window.ResizeObserver = class extends NativeResizeObserver {
        constructor(callback: ResizeObserverCallback) {
          super((entries, observer) => {
            callback(entries, observer);
            for (const entry of entries) measured.add(entry.target);
          });
        }
      };
      Object.assign(window, {
        chatEmptyRowsMeasured: () => {
          const viewport = document.querySelector('[data-message-selection-scroll]');
          if (!viewport) return true; // Fixed path: no virtualizer for empty history.
          const rows = viewport.firstElementChild?.children;
          return !!rows?.length && Array.from(rows).every((row) => measured.has(row));
        },
      });
    });
    await page.goto(
      `/iframe.html?id=sessions-sessionchathydration--${leading}-leading-content&viewMode=story`,
      { waitUntil: 'domcontentloaded' }
    );
    const loadHistory = page.getByRole('button', { name: 'Load history', exact: true });
    // Storybook compiles the component graph asynchronously; wait for its
    // ready control before beginning the history/measurement transition.
    await loadHistory.waitFor({ state: 'visible' });
    if (leading === 'visible') {
      await expect(page.getByText('Conversation provenance', { exact: true })).toBeVisible();
    }
    await page.waitForFunction(() =>
      (window as Window & { chatEmptyRowsMeasured: () => boolean }).chatEmptyRowsMeasured()
    );
    await loadHistory.click();

    const user = page.getByText('The first user message must remain visible.', { exact: true });
    const agent = page.getByText('The agent reply must follow the user message.', { exact: true });
    await expect(agent).toBeVisible();
    const viewport = page.locator('[data-message-selection-scroll]');
    await viewport.dispatchEvent('wheel', { deltaY: -100 });
    await viewport.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(user).toBeVisible();
    await expect(user).toBeInViewport();
    const userBox = await user.boundingBox();
    const agentBox = await agent.boundingBox();
    expect(userBox).not.toBeNull();
    expect(agentBox).not.toBeNull();
    expect(userBox!.y + userBox!.height).toBeLessThanOrEqual(agentBox!.y);
    if (leading === 'visible') {
      await expect(page.getByText('Conversation provenance', { exact: true })).toBeVisible();
    }
  });
}

for (const { story, label, working } of [
  // Live work shimmers; waiting on the user keeps a still, warning-toned label.
  { story: 'starting-activity', label: 'Starting…', working: true },
  { story: 'permission-activity', label: 'Waiting for permission', working: false },
]) {
  test(`agent activity stays visible across empty history hydration: ${story}`, async ({
    page,
  }) => {
    await page.goto(`/iframe.html?id=sessions-sessionchathydration--${story}&viewMode=story`, {
      waitUntil: 'domcontentloaded',
    });
    const loadHistory = page.getByRole('button', { name: 'Load history', exact: true });
    await loadHistory.waitFor({ state: 'visible' });
    const activity = page.getByText(label, { exact: true });
    await expect(activity).toBeVisible();
    await expect(activity).toBeInViewport();
    await expect(page.locator('[data-message-selection-scroll]')).toHaveCount(0);
    const activityPresentation = () =>
      activity.evaluate((element) => ({
        shimmer:
          window.getComputedStyle(element, '::after').animationName === 'agent-shimmer-sweep',
        warning: element.classList.contains('text-status-warning'),
      }));
    expect(await activityPresentation()).toEqual({ shimmer: working, warning: !working });

    const toggleActivity = page.getByRole('button', { name: 'Toggle activity', exact: true });
    await toggleActivity.click();
    await expect(activity).toHaveCount(0);
    await toggleActivity.click();
    await expect(activity).toBeVisible();
    await loadHistory.click();

    await expect(
      page.getByText('The first user message must remain visible.', { exact: true })
    ).toBeInViewport();
    await expect(activity).toHaveCount(1);
    await expect(activity).toBeInViewport();
    expect(await activityPresentation()).toEqual({ shimmer: working, warning: !working });
    await toggleActivity.click();
    await expect(activity).toHaveCount(0);
  });
}

test('opening and reopening never reveals an unmeasured tail', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeResizeObserver = window.ResizeObserver;
    let held: (() => void)[] = [];
    let paused = true;
    Object.assign(window, {
      pauseTailMeasurement: () => {
        paused = true;
      },
      releaseTailMeasurement: () => {
        paused = false;
        const callbacks = held;
        held = [];
        for (const callback of callbacks) callback();
      },
      hasHeldTailMeasurement: () => held.length > 0,
    });
    window.ResizeObserver = class extends NativeResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        super((entries, observer) => {
          // Gate the real browser measurement of the destination row. Parent
          // viewport/spacer observations keep running. No timing assumptions.
          if (
            paused &&
            entries.some(
              ({ target }) =>
                target.parentElement?.parentElement?.hasAttribute(
                  'data-message-selection-scroll'
                ) && target.querySelector('[data-cold-tail]')
            )
          ) {
            held.push(() => callback(entries, observer));
          } else callback(entries, observer);
        });
      }
    };
  });
  await page.goto('/iframe.html?id=sessions-sessionchathydration--cold-tail&viewMode=story');
  const open = page.getByRole('button', { name: 'Open conversation', exact: true });
  await open.waitFor({ state: 'visible' });
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() =>
      (window as typeof window & { pauseTailMeasurement: () => void }).pauseTailMeasurement()
    );
    await open.click();
    await page.waitForFunction(() =>
      (window as typeof window & { hasHeldTailMeasurement: () => boolean }).hasHeldTailMeasurement()
    );
    const viewport = page.locator('[data-message-selection-scroll]');
    await expect(viewport).toHaveCSS('visibility', 'hidden');
    await page.evaluate(() =>
      (window as typeof window & { releaseTailMeasurement: () => void }).releaseTailMeasurement()
    );
    await expect(viewport).toHaveCSS('visibility', 'visible');
    await expect(page.locator('[data-cold-tail]')).toBeInViewport();
    await expect
      .poll(() => viewport.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
      .toBeLessThanOrEqual(1);
  }
});
