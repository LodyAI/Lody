import { expect, test } from '@playwright/test';

const frame = '[data-testid="side-panel-story-frame"]';

test('compresses side panel tabs before scrolling and keeps the selected tab closeable', async ({
  page,
}) => {
  await page.goto('/iframe.html?id=sessions-sessionsidepaneltabbar--unified-tabs&viewMode=story');
  const tabs = page.getByRole('tab');
  const list = page.getByRole('tablist');
  await expect(tabs).toHaveCount(6);
  const layout = () =>
    list.evaluate((element) => {
      const viewport = element.parentElement!.parentElement!;
      const labels = [...element.querySelectorAll<HTMLElement>('[role="tab"] > span')];
      return {
        overflow: viewport.scrollWidth - viewport.clientWidth,
        truncated: labels.some((label) => label.scrollWidth > label.clientWidth),
      };
    });

  const compressed = await layout();
  expect(compressed.overflow).toBeLessThanOrEqual(1);
  expect(compressed.truncated).toBe(true);
  const active = page.getByRole('tab', { selected: true });
  expect((await active.boundingBox())!.width).toBeGreaterThanOrEqual(100);
  await expect(active.getByRole('button', { name: 'Close app.tsx' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '(fork) Fix login race' })).toHaveAttribute(
    'title',
    '(fork) Fix login race'
  );

  await page.locator(frame).evaluate((element) => {
    (element as HTMLElement).style.width = '320px';
  });
  expect((await layout()).overflow).toBeGreaterThan(0);
  const first = page.getByRole('tab', { name: 'Files', exact: true });
  await first.click();
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await first.getByRole('button', { name: 'Close Files' }).click();
  await expect(tabs).toHaveCount(5);
  await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(
    '(fork) Fix login race'
  );
});

test('keeps both members of a compressed device split selectable', async ({ page }) => {
  await page.goto('/iframe.html?id=sessions-sessionsidepaneltabbar--device-split&viewMode=story');
  await page.locator(frame).evaluate((element) => {
    (element as HTMLElement).style.width = '450px';
  });
  const group = page.getByRole('group');
  const ios = group.getByRole('tab', { name: 'iOS Simulator' });
  const android = group.getByRole('tab', { name: 'Android Emulator' });
  await expect(ios).toHaveAttribute('aria-selected', 'true');
  await android.click();
  await expect(android).toHaveAttribute('aria-selected', 'true');
  await expect(android.getByRole('button', { name: 'Close Android Emulator' })).toBeVisible();
  await expect(ios).toBeVisible();
});
