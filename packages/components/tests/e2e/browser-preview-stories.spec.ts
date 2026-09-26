import { expect, test } from '@playwright/test';

test('Browser Preview stories render, complete their interactions and expose recovery states', async ({
  browser,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const response = await request.get('/index.json');
  expect(response.ok()).toBe(true);
  const index = (await response.json()) as {
    entries: Record<string, { id: string; type: string }>;
  };
  const stories = Object.values(index.entries).filter(
    (entry) => entry.type === 'story' && entry.id.startsWith('sessions-browser-preview-')
  );
  expect(stories.length).toBeGreaterThan(0);
  for (const { id } of stories) {
    await test.step(id, async () => {
      // A fresh context also isolates next-themes, locale and resume-state caches.
      const context = await browser.newContext({
        viewport: {
          width:
            id.endsWith('--mobile-expired') || id.endsWith('--status-popover-narrow') ? 390 : 1000,
          height: 640,
        },
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        // Storybook's dev iframe probes this optional mocking entry even when
        // no module mocks are configured. Do not hide other missing resources.
        if (
          message.location().url.endsWith('/vite-inject-mocker-entry.js') &&
          message.text().includes('404')
        )
          return;
        if (message.type() === 'error') errors.push(message.text());
      });
      try {
        await page.goto(`http://127.0.0.1:6006/iframe.html?id=${id}&viewMode=story`);
        await page.waitForFunction(() => {
          const preview = (
            window as typeof window & {
              __STORYBOOK_PREVIEW__?: { currentRender?: { phase?: string } };
            }
          ).__STORYBOOK_PREVIEW__;
          return preview?.currentRender?.phase === 'finished';
        });
        await expect(page.locator('#storybook-root input')).toBeVisible();
        if (/--(machine-offline|owner-required|archived-session)$/.test(id)) {
          await expect(page.getByRole('button', { name: 'Restore preview' })).toBeDisabled();
        }
        if (id.endsWith('--local-share-expired')) {
          const localPage = page
            .frameLocator('iframe')
            .getByRole('heading', { name: 'Your local app' });
          await expect(localPage).toBeVisible();
          await page.getByRole('button', { name: /Preview status/ }).click();
          await expect(page.getByRole('button', { name: 'Restore preview' })).toBeEnabled();
        }
        if (id.endsWith('--remote-expired')) {
          await expect(page.locator('iframe')).toHaveCount(0);
          await expect(page.getByRole('button', { name: 'Restore preview' })).toBeEnabled();
        }
        if (id.includes('--status-popover-')) {
          await expect(page.getByRole('dialog')).toBeVisible();
        }
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: testInfo.outputPath(`${id}.png`), animations: 'disabled' });
        if (id === 'sessions-browser-preview-controller--empty') {
          const address = page.getByRole('textbox', { name: 'Address' });
          await address.fill('localhost:5173/dashboard?mode=dev');
          await address.press('Enter');
          await expect(page.getByText('Establishing a secure preview connection…')).toBeVisible();
          await expect(page.getByRole('dialog')).toHaveCount(0);
        }
        expect.soft(errors, `${id} browser errors`).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
});
