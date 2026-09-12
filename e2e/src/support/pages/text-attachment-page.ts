import { expect, type Locator, type Page } from '@playwright/test';
import {
  ATTACHMENT_PROMPT,
  FOLLOW_UP_PROMPT,
  PRIMARY_SESSION_PROMPT,
  SECONDARY_SESSION_PROMPT,
  SESSION_RESPONSE_TEXT,
  TEXT_ATTACHMENT_NAME,
  TEXT_ATTACHMENT_PATH,
  type TextAttachmentFixture,
} from '../fixtures/text-attachment-fixture.js';

const AGENT_NAME = 'Deterministic Text Attachment Agent';
const HISTORY_ATTACHMENT_NAME = /(?:\d+-)?synthetic-text-attachment\.txt$/u;

export class TextAttachmentPage {
  constructor(
    private readonly page: Page,
    private readonly fixture: TextAttachmentFixture
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

  async createPrimarySession(): Promise<void> {
    await this.createSession(PRIMARY_SESSION_PROMPT, 'primary');
  }

  async cancelAttachmentPicker(): Promise<void> {
    const chooserPromise = this.page.waitForEvent('filechooser');
    await this.openAttachmentPicker();
    const chooser = await chooserPromise;
    await chooser.setFiles([]);
  }

  async expectCancelledPickerLeavesEmptyComposer(): Promise<void> {
    await expect(this.composerRemoveAttachment()).toHaveCount(0);
    await expect(this.composerPrompt()).toHaveValue('');
    await expect(this.sendButton()).toBeDisabled();
  }

  async addAndSendLocalTextAttachment(): Promise<void> {
    const chooserPromise = this.page.waitForEvent('filechooser');
    await this.openAttachmentPicker();
    const chooser = await chooserPromise;
    await chooser.setFiles(TEXT_ATTACHMENT_PATH);

    await expect(this.composerAttachmentPreview()).toBeVisible({ timeout: 30_000 });
    await expect(this.composerAttachmentPreview()).toContainText(TEXT_ATTACHMENT_NAME);
    await this.composerPrompt().fill(ATTACHMENT_PROMPT);
    await expect(this.sendButton()).toBeEnabled({ timeout: 30_000 });
    await this.sendButton().click();
    await expect(this.page.getByText(SESSION_RESPONSE_TEXT, { exact: true }).last()).toBeVisible({
      timeout: 60_000,
    });
  }

  async expectSentAttachmentAndClearedComposer(): Promise<void> {
    await expect(this.composerRemoveAttachment()).toHaveCount(0);
    await expect(this.historyAttachment()).toHaveCount(1);
    await expect(this.historyAttachment()).toBeVisible();
    await expect(this.page.getByText(ATTACHMENT_PROMPT, { exact: true })).toBeVisible();
    await expect(this.composerPrompt()).toHaveValue('');
  }

  async sendPlainTextFollowUp(): Promise<void> {
    await expect(this.composerPrompt()).toBeEditable({ timeout: 30_000 });
    await this.composerPrompt().fill(FOLLOW_UP_PROMPT);
    await this.sendButton().click();
    await expect(this.page.getByText(SESSION_RESPONSE_TEXT, { exact: true }).last()).toBeVisible({
      timeout: 60_000,
    });
  }

  async expectPlainTextFollowUpWithoutAttachment(): Promise<void> {
    await expect(this.page.getByText(FOLLOW_UP_PROMPT, { exact: true })).toBeVisible();
    await expect(this.historyAttachment()).toHaveCount(1);
    await expect(this.composerRemoveAttachment()).toHaveCount(0);
  }

  async reloadPrimarySession(): Promise<void> {
    await this.page.reload({ waitUntil: 'domcontentloaded' });
    await expect(this.page).toHaveURL(
      this.sessionRoutePattern(this.fixture.requirePrimarySessionId())
    );
    await expect(this.composerPrompt()).toBeEditable({ timeout: 60_000 });
  }

  async expectPrimarySessionAfterReload(): Promise<void> {
    await this.expectPrimaryHistory();
  }

  async archiveAndRestorePrimarySession(): Promise<void> {
    const primarySessionId = this.fixture.requirePrimarySessionId();
    await this.openRowMenu(this.activeRow(primarySessionId));
    await this.page.getByRole('menuitem', { name: /^(Archive Session|归档会话)$/u }).click();
    await expect(this.activeRow(primarySessionId)).toHaveCount(0);
    await this.openArchive();
    const archived = this.archivedRow(primarySessionId);
    await expect(archived).toBeVisible({ timeout: 30_000 });
    await archived.hover();
    await this.page.getByRole('button', { name: /^(Restore session|恢复会话)$/u }).click();
    await expect(archived).toHaveCount(0);
    await expect(this.activeRow(primarySessionId)).toBeVisible({ timeout: 30_000 });
    await this.activeRow(primarySessionId).click();
    await expect(this.page).toHaveURL(this.sessionRoutePattern(primarySessionId));
  }

  async expectRestoredPrimarySession(): Promise<void> {
    await this.expectPrimaryHistory();
  }

  async createAttachmentFreeSession(): Promise<void> {
    await this.openHome();
    await this.createSession(SECONDARY_SESSION_PROMPT, 'secondary');
  }

  async expectAttachmentIsolationInSecondarySession(): Promise<void> {
    await expect(this.page).toHaveURL(
      this.sessionRoutePattern(this.fixture.requireSecondarySessionId())
    );
    await expect(this.page.getByText(SECONDARY_SESSION_PROMPT, { exact: true })).toBeVisible();
    await expect(this.historyAttachment()).toHaveCount(0);
    await expect(this.composerRemoveAttachment()).toHaveCount(0);
  }

  async permanentlyDeletePrimarySession(): Promise<void> {
    await this.archiveAndPermanentlyDelete(this.fixture.requirePrimarySessionId());
  }

  async expectPrimaryDeletionKeepsSecondarySession(): Promise<void> {
    const { primarySessionId, secondarySessionId } = this.fixture.requireSessionIds();
    await expect(this.activeRow(primarySessionId)).toHaveCount(0);
    await expect(this.archivedRow(primarySessionId)).toHaveCount(0);
    await expect(this.activeRow(secondarySessionId)).toBeVisible();
    await this.activeRow(secondarySessionId).click();
    await expect(this.page).toHaveURL(this.sessionRoutePattern(secondarySessionId));
    await expect(this.page.getByText(SECONDARY_SESSION_PROMPT, { exact: true })).toBeVisible();
    await expect(this.historyAttachment()).toHaveCount(0);
  }

  async permanentlyDeleteSecondarySession(): Promise<void> {
    await this.archiveAndPermanentlyDelete(this.fixture.requireSecondarySessionId());
  }

  async expectAllSessionsDeleted(): Promise<void> {
    const { primarySessionId, secondarySessionId } = this.fixture.requireSessionIds();
    await expect(this.activeRow(primarySessionId)).toHaveCount(0);
    await expect(this.activeRow(secondarySessionId)).toHaveCount(0);
    await expect(this.archivedRow(primarySessionId)).toHaveCount(0);
    await expect(this.archivedRow(secondarySessionId)).toHaveCount(0);
    await this.openHome();
    await expect(this.page.locator('#chat-prompt')).toBeEditable();
    await expect(this.historyAttachment()).toHaveCount(0);
  }

  private async createSession(prompt: string, kind: 'primary' | 'secondary'): Promise<string> {
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

  private async archiveAndPermanentlyDelete(sessionId: string): Promise<void> {
    await this.openRowMenu(this.activeRow(sessionId));
    await this.page.getByRole('menuitem', { name: /^(Archive Session|归档会话)$/u }).click();
    await expect(this.activeRow(sessionId)).toHaveCount(0);
    await this.openArchive();
    const archived = this.archivedRow(sessionId);
    await expect(archived).toBeVisible({ timeout: 30_000 });
    await archived.hover();
    await this.page.getByRole('button', { name: /^(Delete permanently|永久删除)$/u }).click();
    const dialog = this.page.getByRole('dialog', {
      name: /^(Delete permanently\?|确认永久删除？)$/u,
    });
    await dialog.getByRole('button', { name: /^(Delete|删除)$/u }).click();
    await expect(archived).toHaveCount(0);
  }

  private async expectPrimaryHistory(): Promise<void> {
    await expect(this.historyAttachment()).toHaveCount(1);
    await expect(this.historyAttachment()).toBeVisible();
    await expect(this.page.getByText(ATTACHMENT_PROMPT, { exact: true })).toBeVisible();
    await expect(this.page.getByText(FOLLOW_UP_PROMPT, { exact: true })).toBeVisible();
  }

  private composerPrompt(): Locator {
    return this.page.locator('[data-keyboard-nav="composer"]');
  }

  private sendButton(): Locator {
    return this.page.getByRole('button', { name: /^(Send|发送)$/u });
  }

  private composerRemoveAttachment(): Locator {
    return this.page.getByRole('button', { name: /^(Remove attachment|移除附件)$/u });
  }

  private composerAttachmentPreview(): Locator {
    return this.composerRemoveAttachment().locator('xpath=../..');
  }

  private historyAttachment(): Locator {
    return this.page.getByText(HISTORY_ATTACHMENT_NAME, { exact: true });
  }

  private activeRow(sessionId: string): Locator {
    return this.page.locator(`[data-sidebar-session-id="${sessionId}"]`);
  }

  private archivedRow(sessionId: string): Locator {
    return this.page.locator(`[data-id="archive-session:${sessionId}"]`);
  }

  private async openAttachmentPicker(): Promise<void> {
    await this.page.getByRole('button', { name: /^(Add attachment|添加附件)$/u }).click();
    await this.page.getByRole('menuitem', { name: /^(Add attachment|添加附件)$/u }).click();
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
