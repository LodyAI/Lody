import { expect, type Locator, type Page } from '@playwright/test';

/** Real controls in the open Session; no runtime, store or IPC shortcuts. */
export class ScheduledMessagePage {
  constructor(private readonly page: Page) {}

  private row(text: string): Locator {
    return this.page
      .locator('[data-scheduled-row]:visible')
      .and(this.page.getByTitle(text, { exact: true }));
  }

  async create(text: string): Promise<void> {
    const composer = this.page.locator('[data-keyboard-nav="composer"]:visible');
    await expect(composer).toBeEditable({ timeout: 60_000 });
    await composer.fill(text);
    await this.page.getByRole('button', { name: /^(Add attachment|添加附件)$/u }).click();
    const schedule = this.page.getByRole('menuitem', {
      name: /^(Schedule send…|定时发送…)$/u,
    });
    await expect(schedule).toBeEnabled({ timeout: 60_000 });
    await schedule.click();
    const time = this.page.getByRole('dialog', { name: /^(Schedule send|定时发送)$/u });
    await expect(time).toBeVisible();
    // A product preset avoids machine-local date input formats and wall-clock races.
    await time.getByRole('button', { name: /^(In 1 hour|1 小时后)$/u }).click();
    await time.getByRole('button', { name: /^(Apply|应用)$/u }).click();
    await expect(time).toBeHidden();
    await expect(
      this.page.getByRole('button', { name: /^(Scheduled · |发送定时消息 · )/u })
    ).toBeVisible();
    const send = this.page.getByTestId('composer-send');
    await expect(send).toBeEnabled();
    await send.click();
    await this.expectPending(text);
    await expect(composer).toHaveText('');
  }

  async expectPending(text: string): Promise<void> {
    const toggle = this.page.locator('[data-message-queue-toggle]:visible');
    await expect(toggle).toBeVisible({ timeout: 60_000 });
    if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
    const row = this.row(text);
    await expect(row).toHaveCount(1, { timeout: 60_000 });
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('title', text);
    // The scheduled row has an actual send-time editor, not an ordinary queued prompt.
    await expect(
      row.getByRole('button', { name: /(?:Edit scheduled time|编辑发送时间)$/u })
    ).toBeEnabled();
  }

  async edit(before: string, after: string): Promise<void> {
    await this.expectPending(before);
    const row = this.row(before);
    await row.hover();
    const edit = row.getByRole('button', { name: /^(Edit|编辑)$/u });
    if ((await edit.count()) > 0) {
      await edit.click();
    } else {
      // Compact rows place the same Edit command in the product's More menu.
      await row.getByRole('button', { name: /^(More|更多)$/u }).click();
      await this.page.getByRole('menuitem', { name: /^(Edit|编辑)$/u }).click();
    }
    const dialog = this.page.getByRole('dialog', {
      name: /^(Edit scheduled message|编辑定时消息)$/u,
    });
    await expect(dialog).toBeVisible();
    const message = dialog.locator('[data-keyboard-nav="composer"]');
    await expect(message).toBeEditable();
    await message.fill(after);
    await dialog.getByRole('button', { name: /^(Save changes|保存修改)$/u }).click();
    await expect(dialog).toBeHidden({ timeout: 60_000 });
    await this.expectPending(after);
    if (before !== after) await expect(this.row(before)).toHaveCount(0);
  }
}
