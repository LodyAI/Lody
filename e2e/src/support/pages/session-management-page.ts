import { expect, type Locator, type Page } from '@playwright/test';
import {
  CREATED_SESSION_TITLE,
  RENAMED_SESSION_TITLE,
  SESSION_HISTORY_TEXT,
  SESSION_MANAGEMENT_PROMPT,
  type SessionManagementFixture,
} from '../fixtures/session-management-fixture.js';

const AGENT_NAME = 'Deterministic Session Management Agent';

export class SessionManagementPage {
  constructor(
    private readonly page: Page,
    private readonly fixture: SessionManagementFixture
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
    await this.page.locator('#agent-config-name').fill(AGENT_NAME);
    await this.page.locator('#custom-acp-command').fill(this.fixture.agentCommandLine);
    await this.page.getByRole('button', { name: /^(Test command|测试命令)$/u }).click();
    await expect(this.page.getByText(/^(Ready|就绪)$/u).first()).toBeVisible({ timeout: 60_000 });
    await this.page.getByRole('button', { name: /^(Create|创建)$/u }).click();
    await expect(this.page.getByText(AGENT_NAME, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await this.page.keyboard.press('Escape');
    await expect(settings).toBeHidden();
  }

  async createSession(): Promise<void> {
    await expect(this.page.locator('#chat-prompt')).toBeEditable({ timeout: 60_000 });
    await this.page.locator('#chat-prompt').fill(SESSION_MANAGEMENT_PROMPT);
    await this.page.getByRole('button', { name: /^(Send|发送)$/u }).click();
    await expect(this.page).toHaveURL(/#\/local\/sessions\/[^/?#]+(?:\?.*)?$/u, {
      timeout: 60_000,
    });
    this.fixture.captureSessionId(this.page.url());
    await expect(this.page.getByText(SESSION_HISTORY_TEXT, { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(this.activeRow(CREATED_SESSION_TITLE)).toBeVisible({ timeout: 30_000 });
  }

  async renameSession(): Promise<void> {
    await this.openRowMenu(this.activeRow(CREATED_SESSION_TITLE));
    await this.page.getByRole('menuitem', { name: /^(Rename|重命名)$/u }).click();
    const dialog = this.page.getByRole('dialog', { name: /^(Rename Chat|重命名聊天)$/u });
    await dialog.locator('textarea').fill(RENAMED_SESSION_TITLE);
    await dialog.getByRole('button', { name: /^(Save|保存)$/u }).click();
    await expect(this.activeRow(RENAMED_SESSION_TITLE)).toBeVisible();
  }

  async pinSession(): Promise<void> {
    await this.openRowMenu(this.activeRow(RENAMED_SESSION_TITLE));
    await this.page.getByRole('menuitem', { name: /^(Pin Session|置顶会话)$/u }).click();
    await expect(this.page.getByText(/^(Pinned|已置顶)$/u, { exact: true }).first()).toBeVisible();
    await this.openRowMenu(this.activeRow(RENAMED_SESSION_TITLE));
    await expect(
      this.page.getByRole('menuitem', { name: /^(Unpin Session|取消置顶会话)$/u })
    ).toBeVisible();
    await this.page.keyboard.press('Escape');
  }

  async expectMetadataAfterNavigation(): Promise<void> {
    await this.openHome();
    await expect(this.activeRow(RENAMED_SESSION_TITLE)).toBeVisible();
    await this.activeRow(RENAMED_SESSION_TITLE).click();
    await expect(this.page).toHaveURL(this.sessionRoutePattern());
    await expect(this.page.getByText(SESSION_HISTORY_TEXT, { exact: true })).toBeVisible();
    await this.expectUnpinAction();
  }

  async archiveAndRestore(): Promise<void> {
    await this.openRowMenu(this.activeRow(RENAMED_SESSION_TITLE));
    await this.page.getByRole('menuitem', { name: /^(Archive Session|归档会话)$/u }).click();
    await expect(this.activeRow(RENAMED_SESSION_TITLE)).toBeHidden();
    await this.openArchive();
    const archived = this.archivedRow();
    await expect(archived).toContainText(RENAMED_SESSION_TITLE);
    await archived.hover();
    await this.page.getByRole('button', { name: /^(Restore session|恢复会话)$/u }).click();
    await expect(archived).toBeHidden();
  }

  async expectRestoredState(): Promise<void> {
    await expect(this.activeRow(RENAMED_SESSION_TITLE)).toBeVisible();
    await this.activeRow(RENAMED_SESSION_TITLE).click();
    await expect(this.page).toHaveURL(this.sessionRoutePattern());
    await expect(this.page.getByText(SESSION_HISTORY_TEXT, { exact: true })).toBeVisible();
    await this.expectUnpinAction();
  }

  async permanentlyDelete(): Promise<void> {
    await this.openRowMenu(this.activeRow(RENAMED_SESSION_TITLE));
    await this.page.getByRole('menuitem', { name: /^(Archive Session|归档会话)$/u }).click();
    await this.openArchive();
    const archived = this.archivedRow();
    await expect(archived).toBeVisible();
    await archived.hover();
    await this.page.getByRole('button', { name: /^(Delete permanently|永久删除)$/u }).click();
    const dialog = this.page.getByRole('dialog', {
      name: /^(Delete permanently\?|确认永久删除？)$/u,
    });
    await dialog.getByRole('button', { name: /^(Delete|删除)$/u }).click();
    await expect(archived).toBeHidden({ timeout: 30_000 });
  }

  async expectDeletedFromLists(): Promise<void> {
    await expect(this.page.locator(this.activeRowSelector())).toHaveCount(0);
    await expect(this.archivedRow()).toHaveCount(0);
    await this.openHome();
    await expect(this.page.locator('#chat-prompt')).toBeEditable();
    await expect(this.page.locator(this.activeRowSelector())).toHaveCount(0);
  }

  private activeRow(title: string): Locator {
    return this.page.locator(this.activeRowSelector()).filter({ hasText: title });
  }

  private activeRowSelector(): string {
    return `[data-sidebar-session-id="${this.fixture.requireSessionId()}"]`;
  }

  private archivedRow(): Locator {
    return this.page.locator(`[data-id="archive-session:${this.fixture.requireSessionId()}"]`);
  }

  private async expectUnpinAction(): Promise<void> {
    await this.openRowMenu(this.activeRow(RENAMED_SESSION_TITLE));
    await expect(
      this.page.getByRole('menuitem', { name: /^(Unpin Session|取消置顶会话)$/u })
    ).toBeVisible();
    await this.page.keyboard.press('Escape');
  }

  private async openRowMenu(row: Locator): Promise<void> {
    await expect(row).toBeVisible();
    await row.click({ button: 'right' });
  }

  private async openArchive(): Promise<void> {
    if (!/#\/local\/archive(?:\?.*)?$/u.test(this.page.url())) {
      await this.page.getByRole('button', { name: /^(Archive|归档)$/u, exact: true }).click();
    }
    await expect(this.page).toHaveURL(/#\/local\/archive(?:\?.*)?$/u);
  }

  private async openHome(): Promise<void> {
    await this.page.getByRole('button', { name: /^(Home|New chat|主页|新对话)$/u }).click();
    await expect(this.page).toHaveURL(/#\/local\/chat(?:\?.*)?$/u);
  }

  private sessionRoutePattern(): RegExp {
    return new RegExp(`#\\/local\\/sessions\\/${this.fixture.requireSessionId()}(?:\\?.*)?$`, 'u');
  }
}
