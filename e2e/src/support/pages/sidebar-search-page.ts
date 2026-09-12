import { expect, type Locator, type Page } from '@playwright/test';
import {
  NO_MATCH_SEARCH_QUERY,
  RELEASE_SEARCH_QUERY,
  SESSION_RESPONSE_TEXT,
  SIMILAR_SESSION_PROMPT,
  SIMILAR_SESSION_TITLE,
  TARGET_INITIAL_SEARCH_QUERY,
  TARGET_INITIAL_TITLE,
  TARGET_SESSION_PROMPT,
  TARGET_RENAMED_SEARCH_QUERY,
  TARGET_RENAMED_TITLE,
  UNRELATED_SESSION_PROMPT,
  UNRELATED_SESSION_TITLE,
  type SidebarSearchFixture,
} from '../fixtures/sidebar-search-fixture.js';

const AGENT_NAME = 'Deterministic Sidebar Search Agent';

export class SidebarSearchPage {
  constructor(
    private readonly page: Page,
    private readonly fixture: SidebarSearchFixture
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

  async createSessionMatrix(): Promise<void> {
    const targetSessionId = await this.createSession(TARGET_SESSION_PROMPT, 'target');
    await this.renameSession(targetSessionId, TARGET_INITIAL_TITLE);
    await this.openHome();
    const similarSessionId = await this.createSession(SIMILAR_SESSION_PROMPT, 'similar');
    await this.renameSession(similarSessionId, SIMILAR_SESSION_TITLE);
    await this.openHome();
    const unrelatedSessionId = await this.createSession(UNRELATED_SESSION_PROMPT, 'unrelated');
    await this.renameSession(unrelatedSessionId, UNRELATED_SESSION_TITLE);

    const sessionIds = this.fixture.requireSessionIds();
    expect(sessionIds).toEqual({ targetSessionId, similarSessionId, unrelatedSessionId });
    expect(new Set(Object.values(sessionIds)).size).toBe(3);
    await this.expectActiveSessionTitles(TARGET_INITIAL_TITLE);
  }

  async searchWithCasePartialAndNoMatches(): Promise<void> {
    await this.openSidebarSearch();
    const input = this.paletteInput();
    await input.fill(RELEASE_SEARCH_QUERY);
    await expect(this.paletteSessionResult(TARGET_INITIAL_TITLE)).toBeVisible();
    await expect(this.paletteSessionResult(SIMILAR_SESSION_TITLE)).toBeVisible();
    await expect(this.paletteSessionResult(UNRELATED_SESSION_TITLE)).toHaveCount(0);

    await input.fill(TARGET_INITIAL_SEARCH_QUERY);
    await expect(this.paletteSessionResult(TARGET_INITIAL_TITLE)).toBeVisible();
    await expect(this.paletteSessionResult(SIMILAR_SESSION_TITLE)).toHaveCount(0);
    await expect(this.paletteSessionResult(UNRELATED_SESSION_TITLE)).toHaveCount(0);

    await input.fill(NO_MATCH_SEARCH_QUERY);
    await this.expectNoSessionResults();

    await input.fill('');
    await this.expectNoSessionResults();
    await this.page.keyboard.press('Escape');
    await expect(this.paletteDialog()).toBeHidden();
  }

  async renameTargetAfterSearching(): Promise<void> {
    const { targetSessionId } = this.fixture.requireSessionIds();
    await this.openSidebarSearch();
    await this.paletteInput().fill(TARGET_INITIAL_SEARCH_QUERY);
    await expect(this.paletteSessionResult(TARGET_INITIAL_TITLE)).toBeVisible();
    await this.page.keyboard.press('Escape');
    await expect(this.paletteDialog()).toBeHidden();
    await this.renameSession(targetSessionId, TARGET_RENAMED_TITLE);
  }

  async expectRenamedTargetSearchIndex(): Promise<void> {
    await this.openSidebarSearch();
    const input = this.paletteInput();
    await input.fill(TARGET_INITIAL_SEARCH_QUERY);
    await expect(this.paletteSessionResult(TARGET_INITIAL_TITLE)).toHaveCount(0);
    await input.fill(TARGET_RENAMED_SEARCH_QUERY);
    await expect(this.paletteSessionResult(TARGET_RENAMED_TITLE)).toBeVisible();
    await expect(this.paletteSessionResult(SIMILAR_SESSION_TITLE)).toHaveCount(0);
    await expect(this.paletteSessionResult(UNRELATED_SESSION_TITLE)).toHaveCount(0);
    await this.page.keyboard.press('Escape');
    await expect(this.paletteDialog()).toBeHidden();
    await this.expectActiveSessionTitles(TARGET_RENAMED_TITLE);
  }

  async findAndOpenRenamedTargetSession(): Promise<void> {
    await this.openSidebarSearch();
    await this.paletteInput().fill(TARGET_RENAMED_SEARCH_QUERY);
    await this.paletteSessionResult(TARGET_RENAMED_TITLE).click();
    await expect(this.paletteDialog()).toBeHidden();
  }

  async expectTargetSessionOpen(): Promise<void> {
    const { targetSessionId } = this.fixture.requireSessionIds();
    await expect(this.page).toHaveURL(this.sessionRoutePattern(targetSessionId));
    await expect(this.page.getByText(TARGET_SESSION_PROMPT, { exact: true })).toBeVisible();
    await expect(this.page.getByText(SESSION_RESPONSE_TEXT, { exact: true })).toBeVisible();
  }

  async expectSidebarListRestoredAfterClearingSearch(): Promise<void> {
    await this.expectActiveSessionTitles(TARGET_INITIAL_TITLE);
  }

  async reopenTargetThroughSidebar(): Promise<void> {
    const { targetSessionId } = this.fixture.requireSessionIds();
    await this.openHome();
    await this.activeRow(targetSessionId).click();
    await expect(this.page).toHaveURL(this.sessionRoutePattern(targetSessionId));
  }

  async expectSessionMatrixAfterReopen(): Promise<void> {
    await this.expectTargetSessionOpen();
    await this.expectActiveSessionTitles(TARGET_RENAMED_TITLE);
    await this.openSidebarSearch();
    await this.paletteInput().fill(RELEASE_SEARCH_QUERY);
    await expect(this.paletteSessionResult(TARGET_RENAMED_TITLE)).toBeVisible();
    await expect(this.paletteSessionResult(SIMILAR_SESSION_TITLE)).toBeVisible();
    await expect(this.paletteSessionResult(UNRELATED_SESSION_TITLE)).toHaveCount(0);
    await this.page.keyboard.press('Escape');
    await expect(this.paletteDialog()).toBeHidden();
  }

  async archiveTargetSession(): Promise<void> {
    const { targetSessionId } = this.fixture.requireSessionIds();
    await this.openRowMenu(this.activeRow(targetSessionId));
    await this.page.getByRole('menuitem', { name: /^(Archive Session|归档会话)$/u }).click();
    await expect(this.activeRow(targetSessionId)).toHaveCount(0);
  }

  async expectArchivedTargetRemovedFromSearchIndex(): Promise<void> {
    await this.openSidebarSearch();
    const input = this.paletteInput();
    await input.fill(TARGET_RENAMED_SEARCH_QUERY);
    await expect(this.paletteSessionResult(TARGET_RENAMED_TITLE)).toHaveCount(0);
    await input.fill(RELEASE_SEARCH_QUERY);
    await expect(this.paletteSessionResult(TARGET_RENAMED_TITLE)).toHaveCount(0);
    await expect(this.paletteSessionResult(SIMILAR_SESSION_TITLE)).toBeVisible();
    await expect(this.paletteSessionResult(UNRELATED_SESSION_TITLE)).toHaveCount(0);
    await this.page.keyboard.press('Escape');
    await expect(this.paletteDialog()).toBeHidden();
    await this.openArchive();
    await expect(this.archivedRow(this.fixture.requireSessionIds().targetSessionId)).toBeVisible();
  }

  async deleteArchivedTargetSession(): Promise<void> {
    const { targetSessionId } = this.fixture.requireSessionIds();
    await this.deleteArchivedSession(targetSessionId);
  }

  async expectDeletedTargetRemovedFromSearchIndex(): Promise<void> {
    const { targetSessionId } = this.fixture.requireSessionIds();
    await expect(this.activeRow(targetSessionId)).toHaveCount(0);
    await expect(this.archivedRow(targetSessionId)).toHaveCount(0);
    await this.openHome();
    await this.openSidebarSearch();
    const input = this.paletteInput();
    await input.fill(TARGET_RENAMED_SEARCH_QUERY);
    await expect(this.paletteSessionResult(TARGET_RENAMED_TITLE)).toHaveCount(0);
    await input.fill(RELEASE_SEARCH_QUERY);
    await expect(this.paletteSessionResult(TARGET_RENAMED_TITLE)).toHaveCount(0);
    await expect(this.paletteSessionResult(SIMILAR_SESSION_TITLE)).toBeVisible();
    await this.page.keyboard.press('Escape');
    await expect(this.paletteDialog()).toBeHidden();
  }

  async deleteRemainingSessions(): Promise<void> {
    const { similarSessionId, unrelatedSessionId } = this.fixture.requireSessionIds();
    for (const sessionId of [similarSessionId, unrelatedSessionId]) {
      await this.openRowMenu(this.activeRow(sessionId));
      await this.page.getByRole('menuitem', { name: /^(Archive Session|归档会话)$/u }).click();
      await expect(this.activeRow(sessionId)).toHaveCount(0);
      await this.openArchive();
      await this.deleteArchivedSession(sessionId);
    }
  }

  async expectAllSessionsDeleted(): Promise<void> {
    const { targetSessionId, similarSessionId, unrelatedSessionId } =
      this.fixture.requireSessionIds();
    for (const sessionId of [targetSessionId, similarSessionId, unrelatedSessionId]) {
      await expect(this.activeRow(sessionId)).toHaveCount(0);
      await expect(this.archivedRow(sessionId)).toHaveCount(0);
    }
    await this.openHome();
    await expect(this.page.locator('#chat-prompt')).toBeEditable();
  }

  private async createSession(
    prompt: string,
    kind: 'target' | 'similar' | 'unrelated'
  ): Promise<string> {
    await expect(this.page.locator('#chat-prompt')).toBeEditable({ timeout: 60_000 });
    await this.page.locator('#chat-prompt').fill(prompt);
    await this.page.getByRole('button', { name: /^(Send|发送)$/u }).click();
    await expect(this.page).toHaveURL(/#\/local\/sessions\/[^/?#]+(?:\?.*)?$/u, {
      timeout: 60_000,
    });
    const sessionId = this.fixture.captureSessionId(this.page.url(), kind);
    await expect(this.page.getByText(SESSION_RESPONSE_TEXT, { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    return sessionId;
  }

  private async renameSession(sessionId: string, title: string): Promise<void> {
    await this.openRowMenu(this.activeRow(sessionId));
    await this.page.getByRole('menuitem', { name: /^(Rename|重命名)$/u }).click();
    const dialog = this.page.getByRole('dialog', { name: /^(Rename Chat|重命名聊天)$/u });
    await dialog.locator('textarea').fill(title);
    await dialog.getByRole('button', { name: /^(Save|保存)$/u }).click();
    await expect(dialog).toBeHidden();
    await expect(this.page.locator('body')).not.toHaveCSS('pointer-events', 'none');
    await expect(this.activeRow(sessionId)).toContainText(title);
  }

  private async expectActiveSessionTitles(targetTitle: string): Promise<void> {
    const { targetSessionId, similarSessionId, unrelatedSessionId } =
      this.fixture.requireSessionIds();
    await expect(this.activeRow(targetSessionId)).toContainText(targetTitle);
    await expect(this.activeRow(similarSessionId)).toContainText(SIMILAR_SESSION_TITLE);
    await expect(this.activeRow(unrelatedSessionId)).toContainText(UNRELATED_SESSION_TITLE);
  }

  private async expectNoSessionResults(): Promise<void> {
    await expect(this.paletteSessionResult(TARGET_INITIAL_TITLE)).toHaveCount(0);
    await expect(this.paletteSessionResult(TARGET_RENAMED_TITLE)).toHaveCount(0);
    await expect(this.paletteSessionResult(SIMILAR_SESSION_TITLE)).toHaveCount(0);
    await expect(this.paletteSessionResult(UNRELATED_SESSION_TITLE)).toHaveCount(0);
  }

  private async deleteArchivedSession(sessionId: string): Promise<void> {
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

  private async openSidebarSearch(): Promise<void> {
    await this.page.getByRole('button', { name: /^(Search|搜索)$/u, exact: true }).click();
    await expect(this.paletteDialog()).toBeVisible();
    await expect(this.paletteInput()).toBeEditable();
  }

  private paletteDialog(): Locator {
    return this.page.getByRole('dialog').filter({ has: this.paletteInput() });
  }

  private paletteInput(): Locator {
    return this.page.getByPlaceholder(/^(Search commands and chats\.\.\.|搜索命令和聊天\.\.\.)$/u);
  }

  private paletteSessionResult(title: string): Locator {
    return this.paletteDialog().getByRole('option').filter({ hasText: title });
  }

  private activeRow(sessionId: string): Locator {
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
    const home = this.page.getByRole('button', { name: /^(Home|New chat|主页|新对话)$/u });
    await expect(home).toBeEnabled();
    await home.focus();
    await home.press('Enter');
    await expect(this.page).toHaveURL(/#\/local\/chat(?:\?.*)?$/u);
  }

  private sessionRoutePattern(sessionId: string): RegExp {
    return new RegExp(`#\\/local\\/sessions\\/${sessionId}(?:\\?.*)?$`, 'u');
  }
}
