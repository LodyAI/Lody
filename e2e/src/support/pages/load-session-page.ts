import { expect, type Page } from '@playwright/test';
import type { LoadSessionFixture } from '../fixtures/load-session-fixture.js';

export class LoadSessionPage {
  constructor(
    private readonly page: Page,
    private readonly fixture: LoadSessionFixture
  ) {}

  async configureAgentFromSettings(): Promise<void> {
    await this.page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = this.page.getByRole('dialog').filter({
      has: this.page.getByRole('navigation', { name: /^(Settings|设置)$/u }),
    });
    await expect(settings).toBeVisible();
    await settings.getByRole('button', { name: 'Agents', exact: true }).click();
    const addProvider = settings.getByRole('button', {
      name: /^(Add provider|添加 Provider)$/u,
    });
    await expect(addProvider.first()).toBeEnabled({ timeout: 60_000 });
    await addProvider.first().click();
    await this.page.getByRole('option', { name: /^(Custom command|自定义命令)$/u }).click();
    await this.page.locator('#agent-config-name').fill(this.fixture.agentName);
    await this.page.locator('#custom-acp-command').fill(this.fixture.agentCommandLine);
    await this.page.getByRole('button', { name: /^(Test command|测试命令)$/u }).click();
    await expect(this.page.getByText(/^(Ready|就绪)$/u).first()).toBeVisible({ timeout: 60_000 });
    await this.page.getByRole('button', { name: /^(Create|创建)$/u }).click();
    await expect(this.page.getByText(this.fixture.agentName, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await this.page.keyboard.press('Escape');
    await expect(this.page.locator('#chat-prompt')).toBeEditable({ timeout: 60_000 });
  }

  async createSession(index: number, bodyBytes: number): Promise<string> {
    const marker = `LOAD_BODY_${bodyBytes}_1`;
    await expect(this.page.locator('#chat-prompt')).toBeEditable({ timeout: 60_000 });
    await this.page.locator('#chat-prompt').fill(`Heavy load session ${index} [LOAD:${bodyBytes}]`);
    await this.page.getByRole('button', { name: /^(Send|发送)$/u }).click();
    await expect(this.page).toHaveURL(/#\/local\/sessions\/[^/?#]+(?:\?.*)?$/u, {
      timeout: 60_000,
    });
    await expect(this.page.getByText(/Synthetic response started\./u).first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(this.page.getByText(marker, { exact: false })).toBeVisible({ timeout: 60_000 });
    return this.page.url();
  }

  async returnHome(): Promise<void> {
    await this.page.getByRole('button', { name: /^(Home|New chat|主页|新对话)$/u }).click();
    await expect(this.page).toHaveURL(/#\/local\/chat(?:\?.*)?$/u, { timeout: 30_000 });
    await expect(this.page.locator('#chat-prompt')).toBeEditable({ timeout: 60_000 });
  }

  async openFirstSession(): Promise<void> {
    const row = this.page.locator('[data-sidebar-session-id]').first();
    await expect(row).toBeVisible({ timeout: 60_000 });
    await row.click();
    await expect(this.page).toHaveURL(/#\/local\/sessions\/[^/?#]+(?:\?.*)?$/u, {
      timeout: 30_000,
    });
    await expect(this.page.getByText(/Synthetic response started\./u).first()).toBeVisible({
      timeout: 60_000,
    });
  }

  async openSessionUrl(url: string, bodyBytes: number): Promise<void> {
    await this.page.goto(url);
    await expect(this.page).toHaveURL(/#\/local\/sessions\/[^/?#]+(?:\?.*)?$/u, {
      timeout: 30_000,
    });
    await expect(this.page.getByText(/Synthetic response started\./u).first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(this.page.getByText(`LOAD_BODY_${bodyBytes}_1`, { exact: false })).toBeVisible({
      timeout: 60_000,
    });
  }
}
