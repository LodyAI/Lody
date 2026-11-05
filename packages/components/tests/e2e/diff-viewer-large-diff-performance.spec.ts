import { expect, test } from '@playwright/test';

test('Changes opens a previously unmounted diff and can close and reopen it', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(
    '/iframe.html?id=sessions-conversationdiffpanel--open-from-changes&viewMode=story'
  );
  await expect(page.getByRole('button', { name: 'Changes', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator('[data-diff-path]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  const first = page.locator('[data-diff-path="src/file-000.ts"]');
  await expect(first.locator('pre')).toBeVisible();
  await expect(page.locator('[data-diff-path]')).toHaveCount(200);
  await expect.poll(() => page.locator('diffs-container').count()).toBeLessThan(10);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('[data-diff-path]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  await expect(first.locator('pre')).toBeVisible();
});

test('multi-file diffs bound mounted code and retain collapse state while scrolling', async ({
  page,
}) => {
  await page.goto('/iframe.html?id=sessions-conversationdiffpanel--many-files&viewMode=story');
  const first = page.locator('[data-diff-path="src/file-000.ts"]');
  const last = page.locator('[data-diff-path="src/file-199.ts"]');
  await expect(first.locator('pre')).toBeVisible();
  await expect(page.locator('[data-diff-path]')).toHaveCount(200);
  await expect.poll(() => page.locator('diffs-container').count()).toBeLessThan(10);
  await first.getByRole('button', { name: 'Toggle section', exact: true }).click();
  await expect(first.locator('pre')).not.toBeVisible();
  await first.evaluate(async (node) =>
    Promise.all(
      node.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {}))
    )
  );
  await last.scrollIntoViewIfNeeded();
  await expect(last.locator('pre')).toBeVisible();
  await expect(last.locator('pre')).toContainText('after199');
  await expect.poll(() => page.locator('diffs-container').count()).toBeLessThan(10);
  await first.scrollIntoViewIfNeeded();
  await expect(first.locator('pre')).not.toBeVisible();
  await first.getByRole('button', { name: 'Toggle section', exact: true }).click();
  await expect(first.locator('pre')).toBeVisible();
});

test('a focused file near the end is reachable without mounting unrelated code', async ({
  page,
}) => {
  await page.goto('/iframe.html?id=sessions-conversationdiffpanel--focus-last-file&viewMode=story');
  const last = page.locator('[data-diff-path="src/file-199.ts"]');
  await expect(last.locator('pre')).toBeInViewport();
  await expect(page.locator('diffs-container')).toHaveCount(1);
});

for (const story of ['all-changes', 'all-changes-stale-index']) {
  test(`${story} starts collapsed and opens deferred code on demand`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto(`/iframe.html?id=sessions-conversationdiffpanel--${story}&viewMode=story`);
    const first = page.locator('[data-diff-path="src/file-000.ts"]');
    // Await the cold Storybook import before the timed interaction assertions.
    await first.waitFor({ state: 'attached', timeout: 60_000 });
    await expect(first.getByRole('button', { name: 'Toggle section', exact: true })).toBeVisible();
    await expect(page.locator('diffs-container')).toHaveCount(0);
    await first.getByRole('button', { name: 'Toggle section', exact: true }).click();
    await expect(first.locator('pre')).toBeVisible();
    await expect(page.locator('diffs-container')).toHaveCount(1);
  });
}

test('remote hunks render without bodies and hydrate full context only when expanded', async ({
  page,
}) => {
  await page.goto('/iframe.html?id=sessions-conversationdiffpanel--remote-hunks&viewMode=story');
  const file = page.locator('[data-diff-path="src/remote-large.ts"]');
  await expect(file.locator('pre')).toContainText('changed1000', { timeout: 30_000 });
  const bytes = page.getByLabel('Transferred blob bytes');
  await expect(bytes).toHaveText('0');
  await file.locator('[data-expand-button]').first().click();
  await expect(bytes).not.toHaveText('0');
  await expect(file.locator('pre')).toContainText('value996');
  await expect(file.locator('[data-error-wrapper]')).toHaveCount(0);
});

test('failed context expansion displays a retry action and recovers after reconnection', async ({
  page,
}) => {
  await page.goto('/iframe.html?id=sessions-conversationdiffpanel--remote-hunks&viewMode=story');
  const file = page.locator('[data-diff-path="src/remote-large.ts"]');
  await expect(file.locator('pre')).toContainText('changed1000', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Simulate read failure', exact: true }).click();
  await file.locator('[data-expand-button]').first().click();
  await expect(file.getByRole('alert')).toContainText('Synthetic connection unavailable.');
  await page.getByRole('button', { name: 'Restore reads', exact: true }).click();
  await file.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(file.getByRole('alert')).toHaveCount(0);
  await expect(file.locator('pre')).toContainText('changed1000');
  await file.locator('[data-expand-button]').first().click();
  await expect(file.locator('pre')).toContainText('value996');
});

test('changed comparison during expansion refreshes the complete batch and its base header', async ({
  page,
}) => {
  await page.goto(
    '/iframe.html?id=sessions-conversationdiffpanel--remote-hunks-changing-base&viewMode=story'
  );
  const file = page.locator('[data-diff-path="src/remote-large.ts"]');
  await expect(file.locator('pre')).toContainText('changed1000', { timeout: 30_000 });
  await expect(page.getByText('Branch base · 1111111', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Advance comparison', exact: true }).click();
  await file.locator('[data-expand-button]').first().click();
  await expect(page.getByText('Branch base · 2222222', { exact: true })).toBeVisible();
  await expect(page.locator('[data-diff-path]')).toHaveCount(0);
  await expect(page.getByText('No changes.', { exact: true })).toBeVisible();
});

test('provider-side preparsed large diff remains responsive while scrolling', async ({ page }) => {
  test.setTimeout(60_000);

  const response = await page.goto(
    '/iframe.html?id=ui-diffviewer--provider-side-preparsed-large-diff&viewMode=story'
  );
  expect(response?.ok()).toBeTruthy();

  const diff = page.locator('diffs-container');
  await expect(diff).toBeVisible({ timeout: 30_000 });

  const lag = await page.evaluate(async () => {
    const scrollParent = document.querySelector<HTMLElement>('.scrollbar-pro');
    if (!scrollParent) {
      throw new Error('diff scroll parent not found');
    }

    const samples: number[] = [];
    let lastTick = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      samples.push(now - lastTick);
      lastTick = now;
    }, 16);

    for (let index = 0; index < 24; index += 1) {
      scrollParent.scrollTop = index * 240;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 200));
    window.clearInterval(timer);

    return {
      maxMs: Math.max(...samples),
      sampleCount: samples.length,
    };
  });

  expect(lag.sampleCount).toBeGreaterThan(5);
  expect(lag.maxMs).toBeLessThan(250);
});
