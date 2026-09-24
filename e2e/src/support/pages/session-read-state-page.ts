import { expect, type Locator, type Page } from '@playwright/test';
import {
  FIRST_SESSION_PROMPT,
  SECOND_SESSION_PROMPT,
  SESSION_RESPONSE_TEXT,
  type SessionReadStateFixture,
} from '../fixtures/session-read-state-fixture.js';

const AGENT_NAME = 'Deterministic Unread State Agent';

export class SessionReadStatePage {
  constructor(
    private readonly page: Page,
    private readonly fixture: SessionReadStateFixture
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

  async createTwoSessions(): Promise<void> {
    await this.createSession(FIRST_SESSION_PROMPT, 'first');
    await this.openHome();
    await this.createSession(SECOND_SESSION_PROMPT, 'second');
    const { firstSessionId, secondSessionId } = this.fixture.requireSessionIds();
    expect(firstSessionId).not.toBe(secondSessionId);
    await expect(this.row(firstSessionId)).toBeVisible();
    await expect(this.row(secondSessionId)).toHaveAttribute('aria-current', 'page');
  }

  async markFirstSessionUnread(): Promise<void> {
    const { firstSessionId, secondSessionId } = this.fixture.requireSessionIds();
    await expect(this.page).toHaveURL(this.sessionRoutePattern(secondSessionId));
    const row = this.row(firstSessionId);
    const indicator = row.locator('[data-session-row-indicator]');
    if (await indicator.isVisible()) return;
    await this.openRowMenu(row);
    await this.page
      .getByRole('menuitem', { name: /^(Mark as unread|标记为未读)$/u })
      .dispatchEvent('click');
    await expect(indicator).toBeVisible();
  }

  async expectUnreadIndicator(): Promise<void> {
    const { firstSessionId } = this.fixture.requireSessionIds();
    await expect(this.row(firstSessionId).locator('[data-session-row-indicator]')).toBeVisible();
    await this.openRowMenu(this.row(firstSessionId));
    await expect(
      this.page.getByRole('menuitem', { name: /^(Mark as unread|标记为未读)$/u })
    ).toHaveCount(0);
    await this.page.keyboard.press('Escape');
  }

  async openFirstSession(): Promise<void> {
    const { firstSessionId } = this.fixture.requireSessionIds();
    await this.row(firstSessionId).click();
    await expect(this.page).toHaveURL(this.sessionRoutePattern(firstSessionId));
    await expect(this.page.getByText(FIRST_SESSION_PROMPT, { exact: true })).toBeVisible();
    await expect(this.page.getByText(SESSION_RESPONSE_TEXT, { exact: true })).toBeVisible();
  }

  async expectUnreadCleared(): Promise<void> {
    const { firstSessionId } = this.fixture.requireSessionIds();
    await expect(this.row(firstSessionId).locator('[data-session-row-indicator]')).toHaveCount(0);
    await this.openRowMenu(this.row(firstSessionId));
    await expect(
      this.page.getByRole('menuitem', { name: /^(Mark as unread|标记为未读)$/u })
    ).toBeVisible();
    await this.page.keyboard.press('Escape');
  }

  async deleteBothSessions(): Promise<void> {
    const { firstSessionId, secondSessionId } = this.fixture.requireSessionIds();
    for (const sessionId of [secondSessionId, firstSessionId]) {
      await this.openRowMenu(this.row(sessionId));
      await this.page.getByRole('menuitem', { name: /^(Archive Session|归档会话)$/u }).click();
      await expect(this.row(sessionId)).toHaveCount(0);
      await this.openArchive();
      const archived = this.archivedRow(sessionId);
      await expect(archived).toBeVisible();
      await archived.hover();
      await this.page.getByRole('button', { name: /^(Delete permanently|永久删除)$/u }).click();
      const dialog = this.page.getByRole('dialog', {
        name: /^(Delete permanently\?|确认永久删除？)$/u,
      });
      await dialog.getByRole('button', { name: /^(Delete|删除)$/u }).click();
      await expect(archived).toHaveCount(0);
    }
  }

  async expectBothSessionsDeleted(): Promise<void> {
    const { firstSessionId, secondSessionId } = this.fixture.requireSessionIds();
    await expect(this.row(firstSessionId)).toHaveCount(0);
    await expect(this.row(secondSessionId)).toHaveCount(0);
    await expect(this.archivedRow(firstSessionId)).toHaveCount(0);
    await expect(this.archivedRow(secondSessionId)).toHaveCount(0);
    await this.openHome();
    await expect(this.page.locator('#chat-prompt')).toBeEditable();
  }

  private async createSession(prompt: string, position: 'first' | 'second'): Promise<void> {
    await expect(this.page.locator('#chat-prompt')).toBeEditable({ timeout: 60_000 });
    await this.page.locator('#chat-prompt').fill(prompt);
    await this.page.getByRole('button', { name: /^(Send|发送)$/u }).click();
    await expect(this.page).toHaveURL(/#\/local\/sessions\/[^/?#]+(?:\?.*)?$/u, {
      timeout: 60_000,
    });
    this.fixture.captureSessionId(this.page.url(), position);
    await expect(this.page.getByText(SESSION_RESPONSE_TEXT, { exact: true })).toBeVisible({
      timeout: 60_000,
    });
  }

  private row(sessionId: string): Locator {
    return this.page.locator(`[data-sidebar-session-id="${sessionId}"]`);
  }

  private archivedRow(sessionId: string): Locator {
    return this.page.locator(`[data-id="archive-session:${sessionId}"]`);
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

  private sessionRoutePattern(sessionId: string): RegExp {
    return new RegExp(`#\\/local\\/sessions\\/${sessionId}(?:\\?.*)?$`, 'u');
  }
}
