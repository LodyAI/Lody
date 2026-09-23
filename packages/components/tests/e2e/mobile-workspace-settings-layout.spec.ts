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
