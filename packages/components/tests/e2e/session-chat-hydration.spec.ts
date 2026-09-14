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

for (const { story, label, colorVariable } of [
  { story: 'starting-activity', label: 'Starting…', colorVariable: '--primary' },
  {
    story: 'permission-activity',
    label: 'Waiting for permission',
    colorVariable: '--status-warning',
  },
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
    const activityColor = () =>
      page
        .locator('.agent-activity-dot')
        .evaluate((element) =>
          (element as HTMLElement).style.getPropertyValue('--agent-activity-color')
        );
    expect(await activityColor()).toBe(`hsl(var(${colorVariable}, 199 89% 72%))`);

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
    expect(await activityColor()).toBe(`hsl(var(${colorVariable}, 199 89% 72%))`);
    await toggleActivity.click();
    await expect(activity).toHaveCount(0);
  });
}
