import { expect, test } from '@playwright/test';

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
