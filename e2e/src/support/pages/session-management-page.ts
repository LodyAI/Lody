import { expect, type Locator, type Page } from '@playwright/test';
import {
  RENAMED_SESSION_TITLE,
  SEEDED_HISTORY_TEXT,
  SEEDED_SESSION_TITLE,
  type SeededLocalSessionFixture,
} from '../fixtures/seeded-local-session.js';

export class SessionManagementPage {
  constructor(
    private readonly page: Page,
    private readonly fixture: SeededLocalSessionFixture
  ) {}

  async enterLocalProduct(): Promise<void> {
    await expect(this.page.locator('#chat-prompt')).toBeEditable({ timeout: 60_000 });
  }

  async seedSession(): Promise<void> {
    await this.fixture.seed(this.page);
    await this.openSessionRoute();
    await expect(this.page.getByText(SEEDED_HISTORY_TEXT, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await this.openHome();
    await expect(this.activeRow(SEEDED_SESSION_TITLE)).toBeVisible({ timeout: 30_000 });
  }

  async renameSession(): Promise<void> {
    await this.openRowMenu(this.activeRow(SEEDED_SESSION_TITLE));
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
    await this.openSessionRoute();
    await expect(this.page.getByText(SEEDED_HISTORY_TEXT, { exact: true })).toBeVisible();
    await this.openHome();
    await expect(this.activeRow(RENAMED_SESSION_TITLE)).toBeVisible();
    await this.openRowMenu(this.activeRow(RENAMED_SESSION_TITLE));
    await expect(
      this.page.getByRole('menuitem', { name: /^(Unpin Session|取消置顶会话)$/u })
    ).toBeVisible();
    await this.page.keyboard.press('Escape');
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
    await this.openRowMenu(this.activeRow(RENAMED_SESSION_TITLE));
    await expect(
      this.page.getByRole('menuitem', { name: /^(Unpin Session|取消置顶会话)$/u })
    ).toBeVisible();
    await this.page.keyboard.press('Escape');
    await this.activeRow(RENAMED_SESSION_TITLE).click();
    await expect(this.page).toHaveURL(this.sessionRoutePattern());
    await expect(this.page.getByText(SEEDED_HISTORY_TEXT, { exact: true })).toBeVisible();
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

  async expectDeletedFromListAndRoute(): Promise<void> {
    await expect(
      this.page.locator(`[data-sidebar-session-id="${this.fixture.sessionId}"]`)
    ).toHaveCount(0);
    await this.openSessionRoute();
    await expect(
      this.page.getByRole('heading', { name: /^(Session Not Found|未找到会话)$/u })
    ).toBeVisible({ timeout: 30_000 });
  }

  private activeRow(title: string): Locator {
    return this.page
      .locator(`[data-sidebar-session-id="${this.fixture.sessionId}"]`)
      .filter({ hasText: title });
  }

  private archivedRow(): Locator {
    return this.page.locator(`[data-id="archive-session:${this.fixture.sessionId}"]`);
  }

  private async openRowMenu(row: Locator): Promise<void> {
    await expect(row).toBeVisible();
    await row.click({ button: 'right' });
  }

  private async openArchive(): Promise<void> {
    await this.page.getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(this.page).toHaveURL(/#\/local\/archive(?:\?.*)?$/u);
  }

  private async openSessionRoute(): Promise<void> {
    await this.page.evaluate((sessionId) => {
      window.location.hash = `/local/sessions/${encodeURIComponent(sessionId)}`;
    }, this.fixture.sessionId);
    await expect(this.page).toHaveURL(this.sessionRoutePattern());
  }

  private async openHome(): Promise<void> {
    await this.page.evaluate(() => {
      window.location.hash = '/local/chat';
    });
    await expect(this.page).toHaveURL(/#\/local\/chat(?:\?.*)?$/u);
  }

  private sessionRoutePattern(): RegExp {
    return new RegExp(`#\\/local\\/sessions\\/${this.fixture.sessionId}(?:\\?.*)?$`, 'u');
  }
}
