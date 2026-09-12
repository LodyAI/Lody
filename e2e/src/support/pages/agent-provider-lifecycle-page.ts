import { expect, type Locator, type Page } from '@playwright/test';
import { AgentProviderLifecycleFixture } from '../fixtures/agent-provider-lifecycle-fixture.js';

type ProviderInput = { name: string; command: string; prompt: string };

export class AgentProviderLifecyclePage {
  private firstSessionId: string | null = null;
  private secondSessionId: string | null = null;

  constructor(
    private readonly page: Page,
    private readonly fixture: AgentProviderLifecycleFixture
  ) {}

  async rejectInvalidProviderAndCancel(): Promise<void> {
    const settings = await this.openAgentSettings();
    await this.openNewCustomProvider(settings);
    await this.page.locator('#agent-config-name').fill(this.fixture.rejectedProviderName);
    await this.page.locator('#custom-acp-command').fill(this.fixture.invalidAgentCommandLine);
    await this.testCurrentCommand(false);
    await expect(this.page.getByRole('button', { name: /^(Create|创建)$/u })).toBeDisabled();
    await this.closeProviderEditor();
    await this.closeSettings(settings);
  }

  async expectRejectedProviderAbsent(): Promise<void> {
    const settings = await this.openAgentSettings();
    await expect(
      settings.getByText(this.fixture.rejectedProviderName, { exact: true })
    ).toHaveCount(0);
    await this.closeSettings(settings);
  }

  async createProvider(): Promise<void> {
    const settings = await this.openAgentSettings();
    await this.openNewCustomProvider(settings);
    await this.fillCustomProvider({
      name: this.fixture.initialProviderName,
      command: this.fixture.initialAgentCommandLine,
      prompt: this.fixture.initialCustomPrompt,
    });
    await this.testCurrentCommand(true);
    await this.page.getByRole('button', { name: /^(Create|创建)$/u }).click();
    await expect(settings.getByText(this.fixture.initialProviderName, { exact: true })).toBeVisible(
      {
        timeout: 30_000,
      }
    );
    await this.closeSettings(settings);
  }

  async expectInitialProviderPersisted(): Promise<void> {
    const settings = await this.openAgentSettings();
    await this.expectProviderValues(settings, {
      name: this.fixture.initialProviderName,
      command: this.fixture.initialAgentCommandLine,
      prompt: this.fixture.initialCustomPrompt,
    });
    await this.closeSettings(settings);
  }

  async cancelDraftEdits(): Promise<void> {
    const settings = await this.openAgentSettings();
    await this.openProviderEditor(settings, this.fixture.initialProviderName);
    await this.fillCustomProvider({
      name: this.fixture.cancelledProviderName,
      command: this.fixture.alternateAgentCommandLine,
      prompt: this.fixture.cancelledCustomPrompt,
    });
    await this.closeProviderEditor();
    await this.closeSettings(settings);
  }

  async expectCancelledEditsDidNotPersist(): Promise<void> {
    const settings = await this.openAgentSettings();
    await expect(
      settings.getByText(this.fixture.cancelledProviderName, { exact: true })
    ).toHaveCount(0);
    await this.expectProviderValues(settings, {
      name: this.fixture.initialProviderName,
      command: this.fixture.initialAgentCommandLine,
      prompt: this.fixture.initialCustomPrompt,
    });
    await this.closeSettings(settings);
  }

  async saveEditedProviderAndCreateAlternate(): Promise<void> {
    const settings = await this.openAgentSettings();
    await this.openProviderEditor(settings, this.fixture.initialProviderName);
    await this.fillCustomProvider({
      name: this.fixture.editedProviderName,
      command: this.fixture.editedAgentCommandLine,
      prompt: this.fixture.editedCustomPrompt,
    });
    await this.testCurrentCommand(true);
    await this.page.getByRole('button', { name: /^(Save|保存)$/u }).click();
    await expect(this.page.locator('#agent-config-name')).toBeHidden({ timeout: 30_000 });
    await expect(settings.getByText(this.fixture.initialProviderName, { exact: true })).toHaveCount(
      0
    );
    await expect(
      settings.getByText(this.fixture.editedProviderName, { exact: true })
    ).toBeVisible();
    await this.openNewCustomProvider(settings);
    await this.fillCustomProvider({
      name: this.fixture.alternateProviderName,
      command: this.fixture.alternateAgentCommandLine,
      prompt: this.fixture.alternateCustomPrompt,
    });
    await this.testCurrentCommand(true);
    await this.page.getByRole('button', { name: /^(Create|创建)$/u }).click();
    await expect(
      settings.getByText(this.fixture.alternateProviderName, { exact: true })
    ).toBeVisible({
      timeout: 30_000,
    });
    await this.closeSettings(settings);
  }

  async reloadDesktop(): Promise<void> {
    await this.page.reload({ waitUntil: 'domcontentloaded' });
    await expect(this.page.locator('#chat-prompt')).toBeEditable({ timeout: 60_000 });
  }

  async expectReloadedProviderMatrix(): Promise<void> {
    const settings = await this.openAgentSettings();
    await expect(settings.getByText(this.fixture.initialProviderName, { exact: true })).toHaveCount(
      0
    );
    await this.expectProviderValues(settings, {
      name: this.fixture.editedProviderName,
      command: this.fixture.editedAgentCommandLine,
      prompt: this.fixture.editedCustomPrompt,
    });
    await this.expectProviderValues(settings, {
      name: this.fixture.alternateProviderName,
      command: this.fixture.alternateAgentCommandLine,
      prompt: this.fixture.alternateCustomPrompt,
    });
    await this.closeSettings(settings);
    await this.openAgentMenu();
    await expect(this.providerOption(this.fixture.initialProviderName)).toHaveCount(0);
    await expect(this.providerOption(this.fixture.editedProviderName)).toBeEnabled();
    await expect(this.providerOption(this.fixture.alternateProviderName)).toBeEnabled();
    await this.page.keyboard.press('Escape');
  }

  async createIsolatedSessions(): Promise<void> {
    await this.selectProvider(this.fixture.editedProviderName);
    await this.createSession(
      this.fixture.firstSessionPrompt,
      this.fixture.editedResponseText,
      'first'
    );
    await this.openHome();
    await this.selectProvider(this.fixture.alternateProviderName);
    await this.createSession(
      this.fixture.secondSessionPrompt,
      this.fixture.alternateResponseText,
      'second'
    );
  }

  async expectIsolatedSessionMatrix(): Promise<void> {
    const firstSessionId = this.requireFirstSessionId();
    const secondSessionId = this.requireSecondSessionId();
    expect(firstSessionId).not.toBe(secondSessionId);
    await expect(this.sessionRow(firstSessionId)).toBeVisible();
    await expect(this.sessionRow(secondSessionId)).toHaveAttribute('aria-current', 'page');
    await expect(
      this.page.getByText(this.fixture.secondSessionPrompt, { exact: true })
    ).toBeVisible();
    await expect(this.page.getByText(this.fixture.firstSessionPrompt, { exact: true })).toHaveCount(
      0
    );
    await this.sessionRow(firstSessionId).click();
    await expect(this.page).toHaveURL(this.sessionRoutePattern(firstSessionId));
    await expect(
      this.page.getByText(this.fixture.firstSessionPrompt, { exact: true })
    ).toBeVisible();
    await expect(this.assistantResponse(this.fixture.editedResponseText)).toBeVisible();
    await expect(
      this.page.getByText(this.fixture.secondSessionPrompt, { exact: true })
    ).toHaveCount(0);
  }

  async deleteEditedProvider(): Promise<void> {
    const settings = await this.openAgentSettings();
    await this.deleteProvider(settings, this.fixture.editedProviderName);
    await this.closeSettings(settings);
  }

  async expectDeletedProviderSessionBehavior(): Promise<void> {
    const firstSessionId = this.requireFirstSessionId();
    await expect(this.page).toHaveURL(this.sessionRoutePattern(firstSessionId));
    await expect(
      this.page.getByText(this.fixture.firstSessionPrompt, { exact: true })
    ).toBeVisible();
    await expect(this.assistantResponse(this.fixture.editedResponseText)).toBeVisible();
    await this.openHome();
    await this.openAgentMenu();
    await expect(this.providerOption(this.fixture.editedProviderName)).toHaveCount(0);
    await expect(this.providerOption(this.fixture.alternateProviderName)).toBeEnabled();
    await this.page.keyboard.press('Escape');
    await this.sessionRow(firstSessionId).click();
    await expect(this.assistantResponse(this.fixture.editedResponseText)).toBeVisible();
  }

  async deleteSessionsAndAlternateProvider(): Promise<void> {
    await this.archiveAndPermanentlyDelete(this.requireFirstSessionId());
    await this.archiveAndPermanentlyDelete(this.requireSecondSessionId());
    const settings = await this.openAgentSettings();
    await this.deleteProvider(settings, this.fixture.alternateProviderName);
    await this.closeSettings(settings);
  }

  async expectCatalogAndSessionCleanup(): Promise<void> {
    for (const sessionId of [this.requireFirstSessionId(), this.requireSecondSessionId()]) {
      await expect(this.sessionRow(sessionId)).toHaveCount(0);
      await expect(this.archivedRow(sessionId)).toHaveCount(0);
    }
    const settings = await this.openAgentSettings();
    for (const providerName of [
      this.fixture.rejectedProviderName,
      this.fixture.initialProviderName,
      this.fixture.editedProviderName,
      this.fixture.alternateProviderName,
    ]) {
      await expect(settings.getByText(providerName, { exact: true })).toHaveCount(0);
    }
    await expect(
      settings.getByText(/^(No providers on this machine yet\.|此机器还没有 Provider。)$/u)
    ).toBeVisible();
    await this.closeSettings(settings);
    await this.openHome();
    await expect(this.page.locator('#chat-prompt')).toBeEditable();
  }

  private async openNewCustomProvider(settings: Locator): Promise<void> {
    const addProvider = settings.getByRole('button', { name: /^(Add provider|添加 Provider)$/u });
    await expect(addProvider.first()).toBeEnabled({ timeout: 60_000 });
    await addProvider.first().click();
    await this.page.getByRole('option', { name: /^(Custom command|自定义命令)$/u }).click();
  }

  private async fillCustomProvider(input: ProviderInput): Promise<void> {
    await this.page.locator('#agent-config-name').fill(input.name);
    await this.page.locator('#custom-acp-command').fill(input.command);
    await (await this.openCustomPrompt()).fill(input.prompt);
  }

  private async expectProviderValues(settings: Locator, input: ProviderInput): Promise<void> {
    await this.openProviderEditor(settings, input.name);
    await expect(this.page.locator('#agent-config-name')).toHaveValue(input.name);
    await expect(this.page.locator('#custom-acp-command')).toHaveValue(input.command);
    await expect(await this.openCustomPrompt()).toHaveValue(input.prompt);
    await this.closeProviderEditor();
  }

  private async openAgentSettings(): Promise<Locator> {
    await this.page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = this.settingsDialog();
    await expect(settings).toBeVisible();
    await settings.locator('[data-settings-tab-id="agents"]').click();
    await expect(settings.getByText('Agent Provider', { exact: true })).toBeVisible();
    return settings;
  }

  private settingsDialog(): Locator {
    return this.page.getByRole('dialog').filter({
      has: this.page.getByRole('navigation', { name: /^(Settings|设置)$/u }),
    });
  }

  private async closeSettings(settings: Locator): Promise<void> {
    await settings.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(settings).toBeHidden();
  }

  private async openProviderEditor(settings: Locator, name: string): Promise<void> {
    await settings.getByText(name, { exact: true }).click();
    await expect(this.page.locator('#agent-config-name')).toBeVisible();
  }

  private async closeProviderEditor(): Promise<void> {
    await this.page.getByRole('button', { name: /^(Cancel|取消)$/u }).click();
    await expect(this.page.locator('#agent-config-name')).toBeHidden();
  }

  private async deleteProvider(settings: Locator, name: string): Promise<void> {
    const row = settings.getByText(name, { exact: true }).locator('xpath=../../../..');
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: /^(Delete|删除)$/u }).click();
    const confirmation = this.page.getByRole('alertdialog');
    await expect(confirmation).toContainText(name);
    await confirmation.getByRole('button', { name: /^(Delete|删除)$/u }).click();
    await expect(settings.getByText(name, { exact: true })).toHaveCount(0);
  }

  private customPrompt(): Locator {
    return this.page.getByPlaceholder(
      /^(Optional instructions to include before task details|在任务详情前加入可选指令)$/u
    );
  }

  private async openCustomPrompt(): Promise<Locator> {
    const prompt = this.customPrompt();
    if (!(await prompt.isVisible())) {
      await this.page
        .getByRole('button', { name: /^(Custom prompt|自定义提示词)$/u, exact: true })
        .click();
    }
    await expect(prompt).toBeVisible();
    return prompt;
  }

  private async testCurrentCommand(expectReady: boolean): Promise<void> {
    const test = this.page.getByRole('button', { name: /^(Test command|测试命令)$/u });
    if (!expectReady) {
      await expect(test).toBeDisabled();
      await expect(this.page.getByText(/^(Ready|就绪)$/u)).toHaveCount(0);
      return;
    }
    await test.click();
    await expect(this.page.getByText(/^(Ready|就绪)$/u).first()).toBeVisible({ timeout: 60_000 });
  }

  private async openAgentMenu(): Promise<void> {
    await this.page.getByRole('button', { name: /^(Run configuration|运行设置)$/u }).click();
    await this.page.getByRole('menuitem', { name: /^Agent(?:\s|$)/u }).hover();
  }

  private async selectProvider(name: string): Promise<void> {
    await expect(this.page.locator('#chat-prompt')).toBeEditable({ timeout: 30_000 });
    await this.openAgentMenu();
    const option = this.providerOption(name);
    await expect(option).toBeEnabled();
    await option.click();
    await expect(option).toHaveAttribute('aria-checked', 'true');
    await this.page.keyboard.press('Escape');
  }

  private providerOption(name: string): Locator {
    return this.page.getByRole('menuitemradio', { name, exact: true });
  }

  private async createSession(
    prompt: string,
    response: string,
    position: 'first' | 'second'
  ): Promise<void> {
    await this.page.locator('#chat-prompt').fill(prompt);
    await this.page.getByRole('button', { name: /^(Send|发送)$/u }).click();
    await expect(this.page).toHaveURL(/#\/local\/sessions\/[^/?#]+(?:\?.*)?$/u, {
      timeout: 60_000,
    });
    const sessionId = this.currentSessionId();
    if (position === 'first') this.firstSessionId = sessionId;
    else this.secondSessionId = sessionId;
    await expect(this.assistantResponse(response)).toBeVisible({ timeout: 60_000 });
  }

  private async archiveAndPermanentlyDelete(sessionId: string): Promise<void> {
    const row = this.sessionRow(sessionId);
    await expect(row).toBeVisible();
    await row.click({ button: 'right' });
    await this.page.getByRole('menuitem', { name: /^(Archive [Ss]ession|归档会话)$/u }).click();
    await expect(row).toHaveCount(0);
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

  private sessionRow(sessionId: string): Locator {
    return this.page.locator(`[data-sidebar-session-id="${sessionId}"]`);
  }

  private archivedRow(sessionId: string): Locator {
    return this.page.locator(`[data-id="archive-session:${sessionId}"]`);
  }

  private assistantResponse(response: string): Locator {
    return this.page.getByRole('paragraph').filter({ hasText: response }).last();
  }

  private currentSessionId(): string {
    const match = /#\/local\/sessions\/([^?]+)/u.exec(this.page.url());
    if (!match?.[1]) throw new Error(`Expected a Session route, received ${this.page.url()}`);
    return decodeURIComponent(match[1]);
  }

  private sessionRoutePattern(sessionId: string): RegExp {
    return new RegExp(`#\\/local\\/sessions\\/${sessionId}(?:\\?.*)?$`, 'u');
  }

  private requireFirstSessionId(): string {
    if (!this.firstSessionId) throw new Error('The edited Provider Session was not created');
    return this.firstSessionId;
  }

  private requireSecondSessionId(): string {
    if (!this.secondSessionId) throw new Error('The alternate Provider Session was not created');
    return this.secondSessionId;
  }
}
