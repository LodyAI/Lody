import { expect, type Locator, type Page } from '@playwright/test';
import {
  FIRST_PROMPT,
  FIRST_PROMPT_MARKER,
  FIRST_RESPONSE,
  FIRST_RESPONSE_MARKER,
  INCOMPLETE_RESPONSE_MARKER,
  ISOLATED_STREAM_PREFIX,
  ISOLATED_STREAM_PROMPT,
  PRIMARY_STREAM_PREFIX,
  PRIMARY_STREAM_PROMPT,
  PRIMARY_STREAM_TAIL,
  RICH_ASSISTANT_CODE,
  RICH_USER_CODE,
  SECOND_PROMPT,
  SECOND_RESPONSE,
  type ContextCopyFixture,
} from '../fixtures/context-copy-fixture.js';

const AGENT_NAME = 'Deterministic Context Copy Agent';

export class ContextCopyPage {
  constructor(
    private readonly page: Page,
    private readonly fixture: ContextCopyFixture
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

  async createRichPrimarySession(): Promise<void> {
    await this.sendAndAwaitResponse(FIRST_PROMPT, FIRST_RESPONSE, 'primary');
    await this.sendAndAwaitResponse(SECOND_PROMPT, SECOND_RESPONSE);
  }

  async copyContextThroughFirstUserMessage(): Promise<void> {
    const firstPrompt = this.page.getByText(FIRST_PROMPT_MARKER);
    await expect(firstPrompt).toBeVisible({ timeout: 30_000 });
    // User turns expose the same real fork popover but lack a turn-id test hook.
    // The first visible action belongs to the first rendered user turn.
    await firstPrompt.hover();
    await this.page
      .getByRole('button', { name: /^(Fork session|分叉会话)$/u })
      .first()
      .click();
    await this.copyFromForkMenu();
  }

  async expectClipboardThroughFirstUserMessage(): Promise<void> {
    const clipboard = await this.waitForClipboardText(FIRST_PROMPT_MARKER);
    expect(clipboard).toContain(RICH_USER_CODE);
    expect(clipboard).toContain('```ts');
    for (const excluded of [FIRST_RESPONSE_MARKER, SECOND_PROMPT, SECOND_RESPONSE]) {
      expect(clipboard).not.toContain(excluded);
    }
  }

  async copyContextThroughFirstAssistantResponse(): Promise<void> {
    await this.openForkMenuForAssistantResponse(FIRST_RESPONSE_MARKER);
    await this.copyFromForkMenu();
  }

  async expectClipboardThroughFirstAssistantResponse(): Promise<void> {
    const clipboard = await this.waitForClipboardText(FIRST_RESPONSE_MARKER);
    expect(clipboard).toContain(FIRST_PROMPT_MARKER);
    expect(clipboard).toContain(RICH_USER_CODE);
    expect(clipboard).toContain(RICH_ASSISTANT_CODE);
    expect(clipboard).toContain('```ts');
    for (const excluded of [SECOND_PROMPT, SECOND_RESPONSE]) {
      expect(clipboard).not.toContain(excluded);
    }
  }

  async reloadPrimarySession(): Promise<void> {
    await this.page.reload({ waitUntil: 'domcontentloaded' });
    await expect(this.page).toHaveURL(
      this.sessionRoutePattern(this.fixture.requireSessionId('primary'))
    );
  }

  async expectPrimaryHistoryAndCopyPersistAfterReload(): Promise<void> {
    for (const text of [
      FIRST_PROMPT_MARKER,
      FIRST_RESPONSE_MARKER,
      SECOND_PROMPT,
      SECOND_RESPONSE,
    ]) {
      await expect(this.page.getByText(text)).toBeVisible({ timeout: 30_000 });
    }
    await this.copyContextThroughFirstAssistantResponse();
    await this.expectClipboardThroughFirstAssistantResponse();
  }

  async startPrimaryStreamingAndCopyCompleteSession(): Promise<void> {
    await this.send(PRIMARY_STREAM_PROMPT);
    await this.fixture.waitForEvent('stream-ready', 'primary-stream');
    await expect(this.page.getByText(PRIMARY_STREAM_PREFIX)).toBeVisible({
      timeout: 30_000,
    });
    await expect(this.page.getByRole('button', { name: /^(Stop|停止)$/u })).toBeVisible();
    await this.copyCompleteSessionAsMarkdown();
  }

  async expectIncompletePrimarySessionClipboard(): Promise<void> {
    const clipboard = await this.waitForClipboardText(PRIMARY_STREAM_PREFIX);
    expect(clipboard).toContain(INCOMPLETE_RESPONSE_MARKER);
    expect(clipboard).not.toContain(PRIMARY_STREAM_TAIL);
  }

  async releasePrimaryStreamingResponse(): Promise<void> {
    this.fixture.releasePrimaryStream();
    await this.fixture.expectPrimaryStreamReleased();
    await expect(this.page.getByRole('button', { name: /^(Stop|停止)$/u })).toBeHidden({
      timeout: 30_000,
    });
  }

  async expectCompletedPrimarySessionClipboard(): Promise<void> {
    await this.copyCompleteSessionAsMarkdown();
    const clipboard = await this.waitForClipboardText(PRIMARY_STREAM_TAIL);
    expect(clipboard).not.toContain(INCOMPLETE_RESPONSE_MARKER);
    for (const expected of [
      FIRST_PROMPT_MARKER,
      FIRST_RESPONSE_MARKER,
      SECOND_PROMPT,
      SECOND_RESPONSE,
    ]) {
      expect(clipboard).toContain(expected);
    }
  }

  async createAndCancelIsolatedStreamingSession(): Promise<void> {
    await this.openHome();
    await this.send(ISOLATED_STREAM_PROMPT, 'isolated');
    await this.fixture.waitForEvent('stream-ready', 'isolated-stream');
    await expect(this.page.getByText(ISOLATED_STREAM_PREFIX)).toBeVisible({
      timeout: 30_000,
    });
    await this.page.getByRole('button', { name: /^(Stop|停止)$/u }).click();
    const cancel = await this.fixture.waitForEvent('session-cancel', 'isolated-stream');
    expect(cancel.sessionId).toEqual(expect.any(String));
    const completed = await this.fixture.waitForEvent('prompt-end', 'isolated-stream');
    expect(completed.stopReason).toBe('cancelled');
    await expect(this.page.getByRole('button', { name: /^(Stop|停止)$/u })).toBeHidden({
      timeout: 30_000,
    });
    await this.copyCompleteSessionAsMarkdown();
  }

  async expectIsolatedCancelledSessionClipboard(): Promise<void> {
    const clipboard = await this.waitForClipboardText(ISOLATED_STREAM_PREFIX);
    expect(clipboard).toContain(ISOLATED_STREAM_PROMPT);
    for (const excluded of [
      FIRST_PROMPT_MARKER,
      FIRST_RESPONSE_MARKER,
      SECOND_PROMPT,
      SECOND_RESPONSE,
      PRIMARY_STREAM_PREFIX,
      PRIMARY_STREAM_TAIL,
    ]) {
      expect(clipboard).not.toContain(excluded);
    }
  }

  async permanentlyDeleteSessions(): Promise<void> {
    await this.archiveAndDeleteCurrentSession('isolated');
    await this.openSession('primary');
    await this.archiveAndDeleteCurrentSession('primary');
  }

  async expectSessionsDeleted(): Promise<void> {
    for (const kind of ['primary', 'isolated'] as const) {
      const sessionId = this.fixture.requireSessionId(kind);
      await expect(this.activeRow(sessionId)).toHaveCount(0);
      await expect(this.archivedRow(sessionId)).toHaveCount(0);
    }
    await this.openHome();
    await expect(this.page.locator('#chat-prompt')).toBeEditable();
  }

  private async copyFromForkMenu(): Promise<void> {
    const forkMenu = this.page.locator(
      '[role="menu"][aria-label="Fork conversation"][data-state="open"]'
    );
    await expect(forkMenu).toBeVisible();
    await expect(
      forkMenu.getByRole('menuitem', { name: /^(Current workspace|当前工作区)$/u })
    ).toHaveCount(0);
    await forkMenu
      .getByRole('menuitem', { name: /(Copy context as Markdown|复制 Markdown 上下文)/u })
      .click();
  }

  private async openForkMenuForAssistantResponse(responseMarker: string): Promise<void> {
    const assistantResponseRow = this.assistantTurn(responseMarker);
    await expect(assistantResponseRow).toBeVisible({ timeout: 30_000 });
    const turnId = await assistantResponseRow.getAttribute('data-assistant-turn-id');
    if (!turnId) throw new Error('The selected assistant response has no stable turn id');
    await assistantResponseRow.hover();
    const forkButton = this.page
      .locator(`[data-assistant-turn-id="${turnId}"]`)
      .getByRole('button', { name: /^(Fork session|分叉会话)$/u });
    await expect(forkButton).toBeVisible();
    await forkButton.click();
  }

  private async copyCompleteSessionAsMarkdown(): Promise<void> {
    await this.page
      .getByRole('button', { name: /^(More actions|更多操作)$/u })
      .last()
      .click();
    const copyMenu = this.page.getByRole('menuitem', { name: /^(Copy|复制)$/u, exact: true });
    await expect(copyMenu).toBeVisible();
    await copyMenu.focus();
    await copyMenu.press('ArrowRight');
    const copyAsMarkdown = this.page.getByRole('menuitem', {
      name: /^(Copy as Markdown|复制为 Markdown)$/u,
    });
    await expect(copyAsMarkdown).toBeVisible();
    await copyAsMarkdown.press('Enter');
  }

  private async archiveAndDeleteCurrentSession(kind: 'primary' | 'isolated'): Promise<void> {
    const sessionId = this.fixture.requireSessionId(kind);
    await this.page
      .getByRole('button', { name: /^(More actions|更多操作)$/u })
      .last()
      .click();
    await this.page.getByRole('menuitem', { name: /^(Archive session|归档会话)$/u }).click();
    await expect(this.page).toHaveURL(/#\/local\/chat(?:\?.*)?$/u, { timeout: 30_000 });
    await this.page.getByRole('button', { name: /^(Archive|归档)$/u, exact: true }).click();
    await expect(this.page).toHaveURL(/#\/local\/archive(?:\?.*)?$/u);
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

  private async openSession(kind: 'primary' | 'isolated'): Promise<void> {
    await this.openHome();
    const sessionId = this.fixture.requireSessionId(kind);
    await this.activeRow(sessionId).click();
    await expect(this.page).toHaveURL(this.sessionRoutePattern(sessionId));
  }

  private async openHome(): Promise<void> {
    await this.page.getByRole('button', { name: /^(Home|New chat|主页|新对话)$/u }).click();
    await expect(this.page).toHaveURL(/#\/local\/chat(?:\?.*)?$/u, { timeout: 30_000 });
    await expect(this.page.locator('#chat-prompt')).toBeEditable({ timeout: 30_000 });
  }

  private async send(prompt: string, sessionKind?: 'primary' | 'isolated'): Promise<void> {
    const composer = this.composerPrompt();
    await expect(composer).toBeEditable({ timeout: 60_000 });
    await composer.fill(prompt);
    await this.page.getByRole('button', { name: /^(Send|发送)$/u }).click();
    await expect(this.page).toHaveURL(/#\/local\/sessions\/[^/?#]+(?:\?.*)?$/u, {
      timeout: 60_000,
    });
    if (sessionKind) this.fixture.captureSessionId(this.page.url(), sessionKind);
  }

  private async sendAndAwaitResponse(
    prompt: string,
    response: string,
    sessionKind?: 'primary' | 'isolated'
  ): Promise<void> {
    await this.send(prompt, sessionKind);
    await expect(
      this.page.getByText(response.includes('\n') ? FIRST_RESPONSE_MARKER : response, {
        exact: true,
      })
    ).toBeVisible({
      timeout: 60_000,
    });
  }

  private assistantTurn(responseMarker: string): Locator {
    return this.page.locator('[data-assistant-turn-id]').filter({
      has: this.page.getByText(responseMarker),
    });
  }

  private composerPrompt(): Locator {
    return /#\/local\/chat(?:\?.*)?$/u.test(this.page.url())
      ? this.page.locator('#chat-prompt')
      : this.page.locator('[data-keyboard-nav="composer"]');
  }

  private activeRow(sessionId: string): Locator {
    return this.page.locator(`[data-sidebar-session-id="${sessionId}"]`);
  }

  private archivedRow(sessionId: string): Locator {
    return this.page.locator(`[data-id="archive-session:${sessionId}"]`);
  }

  private sessionRoutePattern(sessionId: string): RegExp {
    return new RegExp(`#\\/local\\/sessions\\/${sessionId}(?:\\?.*)?$`, 'u');
  }

  private async waitForClipboardText(expectedText: string): Promise<string> {
    await expect
      .poll(() => this.page.evaluate(() => navigator.clipboard.readText()), {
        timeout: 30_000,
        intervals: [50, 100, 250, 500],
      })
      .toContain(expectedText);
    return await this.page.evaluate(() => navigator.clipboard.readText());
  }
}
