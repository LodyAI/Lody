import { expect, test, type Locator } from '@playwright/test';

const STORY_URL =
  '/iframe.html?id=mobile-mobilesettingspages--workspace-join-requests&viewMode=story&globals=locale:zh_CN;theme:dark';

test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 393, height: 852 },
});

type ElementBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

async function getVisibleBox(locator: Locator): Promise<ElementBox> {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error('Expected a visible element to have a bounding box');
  }
  return box;
}

test('keeps join requests in the mobile section rhythm and centers the edit icon', async ({
  page,
}) => {
  const response = await page.goto(STORY_URL);
  expect(response?.ok()).toBeTruthy();

  const workspaceSection = page
    .getByRole('heading', { level: 2, name: '工作空间' })
    .locator('xpath=ancestor::section[1]');
  const membersSection = page
    .getByRole('heading', { level: 2, name: '成员' })
    .locator('xpath=ancestor::section[1]');
  const joinCard = page
    .getByRole('heading', { level: 3, name: '开放式加入链接' })
    .locator('xpath=ancestor::section[1]');

  const [workspaceCardBox, membersCardBox, joinCardBox] = await Promise.all([
    getVisibleBox(workspaceSection.locator(':scope > div')),
    getVisibleBox(membersSection.locator(':scope > div')),
    getVisibleBox(joinCard),
  ]);

  expect(Math.abs(joinCardBox.x - workspaceCardBox.x)).toBeLessThan(0.5);
  expect(Math.abs(joinCardBox.width - workspaceCardBox.width)).toBeLessThan(0.5);
  expect(joinCardBox.y - (membersCardBox.y + membersCardBox.height)).toBeCloseTo(20, 5);

  const editButton = page.getByRole('button', { name: '修改工作空间名称' });
  const [editTextBox, editIconBox] = await Promise.all([
    getVisibleBox(editButton.locator('span')),
    getVisibleBox(editButton.locator('svg')),
  ]);
  const textCenter = editTextBox.y + editTextBox.height / 2;
  const iconCenter = editIconBox.y + editIconBox.height / 2;

  expect(editIconBox.width).toBeCloseTo(14, 5);
  expect(editIconBox.height).toBeCloseTo(14, 5);
  expect(Math.abs(iconCenter - textCenter)).toBeLessThan(0.5);
});

test('keeps settings panels independently scrollable across a horizontal fold', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto('/iframe.html?id=mobile-mobilesettingspages--home&viewMode=story');
  await expect(page.locator('[data-scroll-area-viewport]')).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => {
    window.__LODY_HORIZONTAL_DIVISION__ = { top: 426, height: 36, viewportHeight: 852 };
    window.dispatchEvent(new Event('lody:division-change'));
  });

  const upper = page.locator('[data-settings-fold-upper]');
  const lower = page.locator('[data-settings-fold-lower]');
  await expect(upper).toBeVisible();
  await expect(lower).toBeVisible();
  const upperBox = await upper.boundingBox();
  const lowerMetrics = await lower.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    bottom: element.getBoundingClientRect().bottom,
  }));
  expect(lowerMetrics.bottom).toBeLessThanOrEqual(852);
  expect(lowerMetrics.scrollHeight).toBeGreaterThan(lowerMetrics.clientHeight);
  await lower.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(() => lower.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect((await upper.boundingBox())?.y).toBe(upperBox?.y);

  await page.evaluate(() => {
    window.__LODY_HORIZONTAL_DIVISION__ = null;
    window.dispatchEvent(new Event('lody:division-change'));
  });
  await expect(lower).toHaveCount(0);
  const viewport = page.locator('[data-scroll-area-viewport]');
  await expect(viewport).toBeVisible();
  await viewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
});
