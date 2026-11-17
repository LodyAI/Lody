import { expect, type Page } from '@playwright/test';

export const syncPrompt = (token: string): string =>
  `Synthetic device conversation [SYNC:${token}]`;
export const syncReply = (token: string): string => `SYNC_REPLY_${token}`;
export const syncStarted = (token: string): string => `SYNC_STARTED_${token}`;

export class SyncSessionUi {
  constructor(readonly page: Page) {}

  async configureAgent(command: string, name = 'Synthetic sync agent'): Promise<void> {
    await this.page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = this.page
      .getByRole('dialog')
      .filter({ has: this.page.getByRole('navigation', { name: /^(Settings|设置)$/u }) });
    await expect(settings).toBeVisible();
    await settings.getByRole('button', { name: 'Agents', exact: true }).click();
    await settings
      .getByRole('button', { name: /^(Add provider|添加 Provider)$/u })
      .first()
      .click();
    await this.page.getByRole('option', { name: /^(Custom command|自定义命令)$/u }).click();
    await this.page.locator('#agent-config-name').fill(name);
    await this.page.locator('#custom-acp-command').fill(command);
    await this.page.getByRole('button', { name: /^(Test command|测试命令)$/u }).click();
    await expect(this.page.getByText(/^(Ready|就绪)$/u).first()).toBeVisible({ timeout: 60_000 });
    await this.page.getByRole('button', { name: /^(Create|创建)$/u }).click();
    await expect(this.page.getByText(name, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await this.page.keyboard.press('Escape');
    await expect(settings).toBeHidden();
  }

  async send(token: string, fresh = false): Promise<void> {
    const composer = this.page.locator(fresh ? '#chat-prompt' : '[data-keyboard-nav="composer"]');
    await expect(composer).toBeEditable({ timeout: 60_000 });
    await composer.fill(syncPrompt(token));
    await this.page.getByRole('button', { name: /^(Send|发送)$/u }).click();
    await expect(this.page).toHaveURL(/#\/[^/]+\/sessions\/[^/?#]+(?:\?.*)?$/u, {
      timeout: 60_000,
    });
  }

  sessionId(): string {
    const id = /#\/[^/]+\/sessions\/([^/?#]+)/u.exec(this.page.url())?.[1];
    if (!id) throw new Error(`Expected a Session route: ${this.page.url()}`);
    return decodeURIComponent(id);
  }

  async open(id: string): Promise<void> {
    await this.page.locator(`[data-sidebar-session-id="${id}"]`).click({ timeout: 60_000 });
    await expect.poll(() => this.sessionId(), { timeout: 60_000 }).toBe(id);
  }

  async expectStreaming(token: string): Promise<void> {
    await expect(
      this.page.locator('[data-assistant-turn-id]').getByText(syncStarted(token), { exact: true })
    ).toBeVisible({ timeout: 60_000 });
    await expect(this.page.getByRole('button', { name: /^(Stop|停止)$/u })).toBeVisible({
      timeout: 60_000,
    });
  }

  async expectMissing(token: string): Promise<void> {
    await expect(
      this.page.locator('[data-user-message-bubble]').getByText(syncPrompt(token), { exact: true })
    ).toHaveCount(0);
    await expect(
      this.page.locator('[data-assistant-turn-id]').getByText(syncReply(token), { exact: true })
    ).toHaveCount(0);
  }

  async expectHistory(tokens: string[]): Promise<void> {
    for (const token of tokens) {
      await expect(
        this.page
          .locator('[data-user-message-bubble]')
          .getByText(syncPrompt(token), { exact: true })
      ).toHaveCount(1, { timeout: 60_000 });
      await expect(
        this.page.locator('[data-assistant-turn-id]').getByText(syncReply(token), { exact: true })
      ).toHaveCount(1, { timeout: 60_000 });
    }
    await expect(this.page.getByRole('button', { name: /^(Stop|停止)$/u })).toBeHidden({
      timeout: 60_000,
    });
    await expect(this.page.getByLabel(/^(Pending messages|待发送消息)/u)).toHaveCount(0, {
      timeout: 60_000,
    });
    await expect(this.page.locator('[data-keyboard-nav="composer"]')).toBeEditable({
      timeout: 60_000,
    });
  }
}
