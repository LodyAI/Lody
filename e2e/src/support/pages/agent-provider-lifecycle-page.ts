import { expect, type Locator, type Page } from '@playwright/test';
import { AgentProviderLifecycleFixture } from '../fixtures/agent-provider-lifecycle-fixture.js';
import { openSidebarArchive } from './sidebar-footer.js';

type ProviderInput = { name: string; command: string; prompt: string };

export class AgentProviderLifecyclePage {
  private firstSessionId: string | null = null;
  private secondSessionId: string | null = null;

  constructor(
    private readonly page: Page,
    private readonly fixture: AgentProviderLifecycleFixture
  ) {}

  async expectProviderListed(name: string, present = true): Promise<void> {
    const settings = await this.openAgentSettings();
    const row = settings.getByText(name, { exact: true });
    if (present) await expect(row).toBeVisible();
    else await expect(row).toHaveCount(0);
    await this.closeSettings(settings);
  }

  async renameProvider(previous: string, next: string): Promise<void> {
    const settings = await this.openAgentSettings();
    await this.openProviderEditor(settings, previous);
    // Preserve write-only launch/env/prompt fields; execution proves preservation.
    const nameInput = this.page.locator('#agent-config-name, #catalog-agent-name');
    await nameInput.fill(next);
    if (await this.isNativeEditor()) await this.keepNativePrivateFields();
    await this.page.getByRole('button', { name: /^(Save|保存)$/u }).click();
    await expect(nameInput).toBeHidden();
    await expect(settings.getByText(next, { exact: true })).toBeVisible();
    await this.closeSettings(settings);
  }

  async sendWithProvider(name: string, prompt: string, response: string): Promise<void> {
    await this.openHome();
    await this.selectProvider(name);
    await this.createSession(prompt, response, 'first');
  }

  async deleteProviderByName(name: string): Promise<void> {
    const settings = await this.openAgentSettings();
    await this.deleteProvider(settings, name);
    await this.closeSettings(settings);
  }

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
    if (await this.isNativeEditor()) await this.selectNativePrivateMode('prompt', 'clear');
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
    const verificationPrompt = 'Verify the saved Provider survived the cancelled private draft.';
    await this.sendWithProvider(
      this.fixture.initialProviderName,
      verificationPrompt,
      this.fixture.initialResponseText
    );
    await this.fixture.expectInitialExecution(verificationPrompt);
    await this.archiveAndPermanentlyDelete(this.requireFirstSessionId());
    this.firstSessionId = null;
    await this.openHome();
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
    await expect(this.editorName()).toBeHidden({ timeout: 30_000 });
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

  async revisitProviderCatalogThroughSettings(): Promise<void> {
    const settings = await this.openAgentSettings();
    await this.closeSettings(settings);
  }

  async expectReopenedProviderMatrix(): Promise<void> {
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
    await this.closeAgentMenu();
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
    await this.closeAgentMenu();
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
    await expect(settings.getByText(/^(No agents on .+ yet|.+ 上还没有 Agent)$/u)).toBeVisible();
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

  private editorName(): Locator {
    return this.page.locator('#agent-config-name, #catalog-agent-name');
  }

  private isNativeEditor(): Promise<boolean> {
    return this.page.locator('#catalog-agent-name').isVisible();
  }

  private nativePrivateGroup(field: 'command' | 'prompt'): Locator {
    return this.page.getByRole('group', {
      name:
        field === 'command' ? /^(Custom command|自定义命令)$/u : /^(System prompt|系统提示词)$/u,
      exact: true,
    });
  }

  private nativePrivateInput(field: 'command' | 'prompt'): Locator {
    return this.page.getByRole('textbox', {
      name:
        field === 'command' ? /^(Custom command|自定义命令)$/u : /^(System prompt|系统提示词)$/u,
      exact: true,
    });
  }

  private async selectNativePrivateMode(
    field: 'command' | 'prompt',
    mode: 'keep' | 'replace' | 'clear'
  ): Promise<void> {
    const group = this.nativePrivateGroup(field);
    const names = {
      keep: /^(Keep|保留)$/u,
      replace: /^(Replace|替换)$/u,
      clear: /^(Clear|清除)$/u,
    };
    const button = group.getByRole('button', { name: names[mode], exact: true });
    await expect(button).toBeEnabled();
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    if (mode !== 'replace') await expect(this.nativePrivateInput(field)).toHaveCount(0);
  }

  private async keepNativePrivateFields(): Promise<void> {
    for (const field of ['command', 'prompt'] as const) {
      await expect(this.nativePrivateGroup(field).locator('..')).toContainText(
        /A saved value is present\. Its contents stay on the machine\.|已有保存的值，内容保留在执行机器上。/u
      );
      await this.selectNativePrivateMode(field, 'keep');
    }
  }

  private async fillCustomProvider(input: ProviderInput): Promise<void> {
    await this.editorName().fill(input.name);
    if (await this.isNativeEditor()) {
      await this.selectNativePrivateMode('command', 'replace');
      const command = this.nativePrivateInput('command');
      await expect(command).toHaveValue('');
      await command.fill(input.command);
      await this.selectNativePrivateMode('prompt', input.prompt ? 'replace' : 'clear');
      if (input.prompt) {
        const prompt = this.nativePrivateInput('prompt');
        await expect(prompt).toHaveValue('');
        await prompt.fill(input.prompt);
      }
    } else {
      await this.page.locator('#custom-acp-command').fill(input.command);
      await (await this.openCustomPrompt()).fill(input.prompt);
    }
  }

  private async expectProviderValues(settings: Locator, input: ProviderInput): Promise<void> {
    await this.openProviderEditor(settings, input.name);
    await expect(this.editorName()).toHaveValue(input.name);
    if (await this.isNativeEditor()) {
      // Public presence is the UI contract. The scripted ACP later verifies the
      // saved launch variant and full prompt; no private read port is used here.
      await this.keepNativePrivateFields();
      await expect(this.page.locator('#custom-acp-command')).toHaveCount(0);
    } else {
      await expect(this.page.locator('#custom-acp-command')).toHaveValue(input.command);
      await expect(await this.openCustomPrompt()).toHaveValue(input.prompt);
    }
    await this.closeProviderEditor();
  }

  private async openAgentSettings(): Promise<Locator> {
    await this.page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = this.settingsDialog();
    await expect(settings).toBeVisible();
    await settings.locator('[data-settings-tab-id="agents"]').click();
    await expect(
      settings.getByRole('button', { name: /^(Add provider|添加 Provider)$/u }).first()
    ).toBeEnabled();
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
    await expect(this.page.locator('#agent-config-name, #catalog-agent-name')).toBeVisible();
  }

  private async closeProviderEditor(): Promise<void> {
    await this.page.getByRole('button', { name: /^(Cancel|取消)$/u }).click();
    await expect(this.editorName()).toBeHidden();
  }

  private async deleteProvider(settings: Locator, name: string): Promise<void> {
    const row = settings.getByText(name, { exact: true }).locator('xpath=../../../..');
    await expect(row).toBeVisible();
    const manage = row.getByRole('button', { name: /^(Manage|管理) /u });
    if ((await manage.count()) > 0) {
      await manage.click();
      await this.page.getByRole('menuitem', { name: /^(Delete|删除)$/u }).click();
    } else {
      await row.getByRole('button', { name: /^(Delete|删除)$/u }).click();
    }
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
    if (await this.isNativeEditor()) {
      // Native edit verifies the candidate in trusted Node during Save. The
      // standalone Test command belongs only to the legacy/create dialog.
      if (!expectReady) throw new Error('Invalid-command rejection must use the create dialog');
      await expect(
        this.nativePrivateGroup('command').getByRole('button', { name: /^(Replace|替换)$/u })
      ).toHaveAttribute('aria-pressed', 'true');
      await expect(this.page.getByRole('button', { name: /^(Save|保存)$/u })).toBeEnabled();
      return;
    }
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
    const trigger = this.runConfigurationButton();
    if ((await trigger.getAttribute('aria-expanded')) !== 'true') {
      await trigger.click();
    }
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');

    const agentSubmenu = this.agentSubmenuTrigger();
    await expect(agentSubmenu).toBeVisible();
    await agentSubmenu.hover();
    await expect(agentSubmenu).toHaveAttribute('aria-expanded', 'true');
  }

  private async closeAgentMenu(): Promise<void> {
    const trigger = this.runConfigurationButton();
    await this.page.keyboard.press('Escape');
    if (await this.agentSubmenuTrigger().isVisible()) {
      await this.page.keyboard.press('Escape');
    }
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(this.agentSubmenuTrigger()).toBeHidden();
  }

  private async selectProvider(name: string): Promise<void> {
    await expect(this.page.locator('#chat-prompt')).toBeEditable({ timeout: 30_000 });
    await this.openAgentMenu();
    const option = this.providerOption(name);
    await expect(option).toBeVisible();
    await expect(option).toBeEnabled();

    const bounds = await option.boundingBox();
    if (!bounds) throw new Error(`Provider option is not rendered: ${name}`);
    // Emit the intermediate pointer events a user produces while crossing the submenu gap.
    await this.page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, {
      steps: 8,
    });
    await expect(this.agentSubmenuTrigger()).toHaveAttribute('aria-expanded', 'true');
    await option.click();
    await expect(option).toHaveAttribute('aria-checked', 'true');
    await this.closeAgentMenu();
  }

  private runConfigurationButton(): Locator {
    return this.page.locator(
      'button[aria-label="Run configuration"], button[aria-label="运行设置"]'
    );
  }

  private agentSubmenuTrigger(): Locator {
    return this.page.getByRole('menuitem', { name: /^Agent(?:\s|$)/u });
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
      await openSidebarArchive(this.page);
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
