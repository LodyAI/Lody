import { expect, test } from '@playwright/test';

/**
 * Every status mark shares the mobile row's one 16px leading node. The opened-by
 * tree widens the slot (16px → 32px) to indent an opened Session, so a mark
 * narrower than the node box used to be left-aligned in the widened slot: the
 * 8px unread dot sat 4px left of the spinner, the hand and every top-level row.
 *
 * Real geometry is the assertion: jsdom has no layout, and class strings cannot
 * tell whether a dot is centred on the trunk.
 */
test('child status marks stay on the tree node centre', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    '/iframe.html?id=mobile-mobilechatlist--opened-by-sessions&viewMode=story&globals=theme:dark'
  );

  const row = (title: string) =>
    page.locator('.mobile-project-conversation-row', { hasText: title });

  const working = row('子会话:核对 token-mint 响应');
  const unreadChild = row('子会话:补 presence 分片回归测试');
  const unreadTopLevel = row('同步进度提示');
  const waiting = row('权限审批弹窗');

  await expect(working).toBeVisible();
  await expect(unreadChild).toBeVisible();
  await expect(unreadTopLevel).toBeVisible();
  await expect(waiting).toBeVisible();

  const centre = async (locator: ReturnType<typeof row>) => {
    const box = await locator.boundingBox();
    if (!box) throw new Error('missing box');
    return { x: box.x, centre: box.x + box.width / 2 };
  };

  const marks = {
    working: await centre(working.locator('[aria-label="running"]')),
    unreadChild: await centre(unreadChild.locator('[aria-label="unread"]')),
    unreadTopLevel: await centre(unreadTopLevel.locator('[aria-label="unread"]')),
    waiting: await centre(waiting.locator('[aria-label="waiting permission"]')),
  };

  /* `ps-4` (16px) + half of the node box (8px). The opened Session's row
     starts at the same x, so this is also the tree trunk. */
  const rowLeft = (await unreadChild.boundingBox())!.x;
  const nodeCentre = rowLeft + 24;

  for (const [name, mark] of Object.entries(marks)) {
    expect(mark.centre, `${name} mark centre`).toBeCloseTo(nodeCentre, 0);
  }

  /* A child and a top-level unread row must not disagree because one slot
     happens to be widened. */
  expect(marks.unreadChild.centre).toBeCloseTo(marks.unreadTopLevel.centre, 0);
});
