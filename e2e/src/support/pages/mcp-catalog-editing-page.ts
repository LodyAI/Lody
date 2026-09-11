import { expect, type Locator, type Page } from '@playwright/test';
import { McpCatalogEditingFixture } from '../fixtures/mcp-catalog-editing-fixture.js';

export class McpCatalogEditingPage {
  constructor(
    private readonly page: Page,
    private readonly fixture: McpCatalogEditingFixture
  ) {}

  async createDefaultEnabledServer(): Promise<void> {
    const settings = await this.openMcpSettings();
    await settings
      .getByRole('button', { name: /^(Add server|添加服务器)$/u })
      .first()
      .click();
    const editor = this.page.getByRole('dialog', {
      name: /^(Add MCP server|添加 MCP 服务器)$/u,
    });
    await editor.getByLabel(/^(Server name|服务器名称)$/u).fill(this.fixture.initialServerName);
    await editor.getByLabel(/^(Description|描述)$/u).fill(this.fixture.initialDescription);
    await editor.getByLabel(/^(Command|命令)$/u).fill(this.fixture.command);
    await editor.locator('input[placeholder="--flag"]').fill(this.fixture.args[0]!);
    const enabledByDefault = editor.getByRole('switch');
    await expect(enabledByDefault).toHaveAttribute('data-state', 'unchecked');
    await enabledByDefault.click();
    await expect(enabledByDefault).toHaveAttribute('data-state', 'checked');
    await editor.getByRole('button', { name: /^(Save|保存)$/u }).click();
    await expect(settings.getByText(this.fixture.initialServerName, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await this.closeSettings(settings);
  }

  async expectInitialEntryPersisted(): Promise<void> {
    const settings = await this.openMcpSettings();
    await expect(settings.getByText(this.fixture.initialServerName, { exact: true })).toBeVisible();
    await expect(
      settings.getByText(this.fixture.initialDescription, { exact: true })
    ).toBeVisible();
    await expect(settings.getByRole('switch')).toHaveAttribute('data-state', 'checked');
    await this.closeSettings(settings);
  }

  async editServer(): Promise<void> {
    const settings = await this.openMcpSettings();
    await settings.getByRole('button', { name: /^(Edit|编辑)$/u }).click();
    const editor = this.page.getByRole('dialog', {
      name: /^(Edit MCP server|编辑 MCP 服务器)$/u,
    });
    await editor.getByLabel(/^(Server name|服务器名称)$/u).fill(this.fixture.editedServerName);
    await editor.getByLabel(/^(Description|描述)$/u).fill(this.fixture.editedDescription);
    await editor.getByRole('button', { name: /^(Save|保存)$/u }).click();
    await expect(settings.getByText(this.fixture.initialServerName, { exact: true })).toBeHidden({
      timeout: 30_000,
    });
    await expect(settings.getByText(this.fixture.editedServerName, { exact: true })).toBeVisible();
    await this.closeSettings(settings);
  }

  async expectEditedEntryPersisted(): Promise<void> {
    const settings = await this.openMcpSettings();
    await expect(settings.getByText(this.fixture.initialServerName, { exact: true })).toBeHidden();
    await expect(settings.getByText(this.fixture.editedServerName, { exact: true })).toBeVisible();
    await expect(settings.getByText(this.fixture.editedDescription, { exact: true })).toBeVisible();
    await expect(settings.getByRole('switch')).toHaveAttribute('data-state', 'checked');
    await this.closeSettings(settings);
  }

  async disableAndReEnableServer(): Promise<void> {
    const settings = await this.openMcpSettings();
    const enabledByDefault = settings.getByRole('switch');
    await expect(enabledByDefault).toHaveAttribute('data-state', 'checked');
    await enabledByDefault.click();
    await expect(enabledByDefault).toHaveAttribute('data-state', 'unchecked');
    await this.closeSettings(settings);

    const reopened = await this.openMcpSettings();
    const persistedSwitch = reopened.getByRole('switch');
    await expect(persistedSwitch).toHaveAttribute('data-state', 'unchecked');
    await persistedSwitch.click();
    await expect(persistedSwitch).toHaveAttribute('data-state', 'checked');
    await this.closeSettings(reopened);
  }

  async expectReEnabledEntryPersisted(): Promise<void> {
    const settings = await this.openMcpSettings();
    await expect(settings.getByText(this.fixture.editedServerName, { exact: true })).toBeVisible();
    await expect(settings.getByRole('switch')).toHaveAttribute('data-state', 'checked');
    await this.closeSettings(settings);
  }

  async deleteServer(): Promise<void> {
    const settings = await this.openMcpSettings();
    await settings.getByRole('button', { name: /^(Remove|移除)$/u }).click();
    const confirmation = this.page.getByRole('alertdialog');
    await expect(confirmation.getByText(this.fixture.editedServerName)).toBeVisible();
    await confirmation.getByRole('button', { name: /^(Remove|移除)$/u }).click();
    await expect(settings.getByText(this.fixture.editedServerName, { exact: true })).toBeHidden({
      timeout: 30_000,
    });
    await expect(this.emptyCatalogMessage(settings)).toBeVisible();
    await this.closeSettings(settings);
  }

  async expectDeletedEntryPersisted(): Promise<void> {
    const settings = await this.openMcpSettings();
    await expect(settings.getByText(this.fixture.editedServerName, { exact: true })).toBeHidden();
    await expect(this.emptyCatalogMessage(settings)).toBeVisible();
    await this.closeSettings(settings);
  }

  private emptyCatalogMessage(settings: Locator): Locator {
    return settings.getByText(
      /^(No MCP servers are configured for this workspace\.|此工作区还没有配置 MCP 服务器。)$/u
    );
  }

  private async openMcpSettings(): Promise<Locator> {
    await this.page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = this.page.getByRole('dialog').filter({
      has: this.page.getByRole('navigation', { name: /^(Settings|设置)$/u }),
    });
    await expect(settings).toBeVisible();
    await settings.locator('[data-settings-tab-id="mcp"]').click();
    await expect(settings.getByRole('heading', { name: 'MCP', exact: true })).toBeVisible();
    return settings;
  }

  private async closeSettings(settings: Locator): Promise<void> {
    await this.page.keyboard.press('Escape');
    await expect(settings).toBeHidden();
    await expect(this.page.locator('#chat-prompt')).toBeEditable({ timeout: 30_000 });
  }
}
