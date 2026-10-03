import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { SessionMeta } from '@lody/shared';

test('observed PR replaces creation actions without granting hosted mutations', async ({
  browser,
}, testInfo) => {
  const storyId = 'sessions-sessioninfobar--discovered-pr-association-rejected';
  const fixtureDir = process.env.B08_SCREENSHOT_FIXTURES;
  const baseURL = testInfo.project.use.baseURL ?? 'http://127.0.0.1:6006';
  const variants = fixtureDir ? ['before', 'after'] : ['after'];
  for (const variant of variants) {
    const context = await browser.newContext({
      baseURL,
      viewport: { width: 1000, height: 640 },
      colorScheme: 'light',
      locale: 'en-US',
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    // Only the isolated Storybook origin is reachable, even if a provider tries cloud access.
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === new URL(baseURL).origin
        ? route.continue()
        : route.abort()
    );
    await context.routeWebSocket('**/*', async (socket) => {
      if (new URL(socket.url()).host === new URL(baseURL).host) socket.connectToServer();
      else await socket.close();
    });
    try {
      await page.goto(`/iframe.html?id=${storyId}&viewMode=story&globals=theme:light;locale:en`);
      await expect(
        page.getByRole('button', { name: 'Open pull request', exact: true })
      ).toBeVisible();
      if (fixtureDir) {
        const ownerMeta = JSON.parse(
          await readFile(join(fixtureDir, `${variant}.json`), 'utf8')
        ) as SessionMeta;
        await page.evaluate(
          (payload) => {
            const preview = (
              window as typeof window & {
                __STORYBOOK_PREVIEW__: {
                  channel: { emit: (event: string, payload: unknown) => void };
                };
              }
            ).__STORYBOOK_PREVIEW__;
            preview.channel.emit('updateStoryArgs', {
              storyId: payload.storyId,
              updatedArgs: { ownerMeta: payload.ownerMeta },
            });
          },
          { storyId, ownerMeta }
        );
      }
      await expect(page.getByText('owner/repo', { exact: true })).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Copy branch name: feat/x', exact: true })
      ).toHaveText('feat/x');
      if (variant === 'before') {
        await expect(page.getByRole('button', { name: 'Create PR', exact: true })).toBeVisible();
        await expect(
          page.getByRole('button', { name: 'Open pull request', exact: true })
        ).toHaveCount(0);
        await page.getByRole('button', { name: 'More actions', exact: true }).click();
        await expect(
          page.getByRole('menuitem', { name: 'Create Draft PR', exact: true })
        ).toBeVisible();
      } else {
        await expect(
          page.getByRole('button', { name: 'Open pull request', exact: true })
        ).toHaveText('#55');
        await expect(
          page.getByRole('button', { name: 'Commit & Push', exact: true })
        ).toBeVisible();
        await expect(page.getByRole('button', { name: 'Create PR', exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'More actions', exact: true })).toHaveCount(
          0
        );
        await expect(page.getByText('Ready for review', { exact: true })).toHaveCount(0);
      }
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({
        path: testInfo.outputPath(`${variant}.png`),
        animations: 'disabled',
      });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }
});
