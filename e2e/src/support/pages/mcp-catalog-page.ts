import { expect, type Locator, type Page } from '@playwright/test';
import { type McpCatalogAcpEvent, McpCatalogFixture } from '../fixtures/mcp-catalog-fixture.js';

const RESPONSE_TEXT = 'Synthetic MCP selection received.';

export class McpCatalogPage {
  constructor(
    private readonly page: Page,
    private readonly fixture: McpCatalogFixture
  ) {}

  async configureCustomAgent(): Promise<void> {
    const settings = await this.openSettings();
    await settings.getByRole('button', { name: /^(Agents|Agent)$/u }).click();
    const addProvider = settings.getByRole('button', {
      name: /^(Add provider|添加 Provider)$/u,
    });
    await expect(addProvider.first()).toBeEnabled({ timeout: 60_000 });
    await addProvider.first().click();
    await this.page.getByRole('option', { name: /^(Custom command|自定义命令)$/u }).click();
    await this.page.locator('#agent-config-name').fill('Deterministic MCP E2E Agent');
    await this.page.locator('#custom-acp-command').fill(this.fixture.scriptedAgentCommandLine);
    await this.page.getByRole('button', { name: /^(Test command|测试命令)$/u }).click();
    await expect(this.page.getByText(/^(Ready|就绪)$/u).first()).toBeVisible({ timeout: 60_000 });
    await this.page.getByRole('button', { name: /^(Create|创建)$/u }).click();
    await expect(this.page.getByText('Deterministic MCP E2E Agent', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await this.closeSettings(settings);
  }

  async createSyntheticStdioServer(): Promise<void> {
    const settings = await this.openMcpSettings();
    await settings
      .getByRole('button', { name: /^(Add server|添加服务器)$/u })
      .first()
      .click();
    const editor = this.page.getByRole('dialog', {
      name: /^(Add MCP server|添加 MCP 服务器)$/u,
    });
    await editor.getByLabel(/^(Server name|服务器名称)$/u).fill(this.fixture.serverName);
    await editor.getByLabel(/^(Description|描述)$/u).fill(this.fixture.serverDescription);
    await editor.getByLabel(/^(Command|命令)$/u).fill(this.fixture.mcpCommand);
    const argumentsField = editor
      .getByText(/^(Arguments|参数)$/u)
      .locator('..')
      .locator('..');
    const argumentInputs = argumentsField.locator('input[placeholder="--flag"]');
    await argumentInputs.first().fill(this.fixture.mcpArgs[0]!);
    await argumentsField.getByRole('button', { name: /^(Add argument|添加参数)$/u }).click();
    await argumentInputs.nth(1).fill(this.fixture.mcpArgs[1]!);
    await editor.getByRole('button', { name: /^(Save|保存)$/u }).click();
    await expect(settings.getByText(this.fixture.serverName, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await this.closeSettings(settings);

    const reopened = await this.openMcpSettings();
    await expect(reopened.getByText(this.fixture.serverName, { exact: true })).toBeVisible();
    await expect(reopened.getByText(this.fixture.serverDescription, { exact: true })).toBeVisible();
    await this.closeSettings(reopened);
  }

  async selectServerForNextTurn(): Promise<void> {
    await this.page.getByRole('button', { name: /^(Add attachment|添加附件)$/u }).click();
    const mcpMenu = this.page.getByRole('menuitem', {
      name: /^(No MCP servers loaded|未加载 MCP)$/u,
    });
    await mcpMenu.hover();
    const server = this.page.getByRole('menuitemcheckbox', {
      name: new RegExp(this.fixture.serverName, 'u'),
    });
    await expect(server).toBeVisible();
    await server.click();
    await expect(server).toHaveAttribute('aria-checked', 'true');
    await this.page.keyboard.press('Escape');
    await this.page.keyboard.press('Escape');
  }

  async createCompletedSession(): Promise<McpCatalogAcpEvent> {
    const priorSessions = this.fixture
      .readAcpEvents()
      .filter((event) => event.event === 'session-new');
    await this.page.locator('#chat-prompt').fill('Use the explicitly selected synthetic MCP.');
    await this.page.getByRole('button', { name: /^(Send|发送)$/u }).click();
    await expect(this.page).toHaveURL(/#\/local\/sessions\/[^/?#]+(?:\?.*)?$/u, {
      timeout: 60_000,
    });
    const assistantTurn = this.page
      .locator('[data-assistant-turn-id]')
      .getByText(RESPONSE_TEXT, { exact: true });
    await expect(assistantTurn).toBeVisible({ timeout: 60_000 });
    const sessions = await this.fixture.waitForEvent('session-new', priorSessions.length + 1);
    const session = sessions.at(-1);
    expect(session?.sessionId).toEqual(expect.any(String));
    await this.fixture.waitForEvent('prompt-end');
    return session!;
  }

  async expectSelectedServerAtAcpStartup(event: McpCatalogAcpEvent): Promise<void> {
    expect(this.externalServers(event)).toEqual([
      {
        name: 'Synthetic workspace MCP',
        command: this.fixture.mcpCommand,
        args: this.fixture.mcpArgs,
        env: [],
      },
    ]);
    expect(await this.fixture.waitForMcpEvent('process-start')).toMatchObject({
      pid: expect.any(Number),
    });
  }

  async deleteSyntheticServer(): Promise<void> {
    const settings = await this.openMcpSettings();
    const main = settings.getByRole('main');
    await main.getByRole('button', { name: /^(Remove|移除)$/u }).click();
    const confirmation = this.page.getByRole('alertdialog');
    await expect(confirmation.getByText(this.fixture.serverName)).toBeVisible();
    await confirmation.getByRole('button', { name: /^(Remove|移除)$/u }).click();
    await expect(settings.getByText(this.fixture.serverName, { exact: true })).toBeHidden({
      timeout: 30_000,
    });
    await expect(
      settings.getByText(
        /^(No MCP servers are configured for this workspace\.|此工作区还没有配置 MCP 服务器。)$/u
      )
    ).toBeVisible();
    await this.closeSettings(settings);
  }

  async expectServerDeletedAndPriorTurnPreserved(event: McpCatalogAcpEvent): Promise<void> {
    const settings = await this.openMcpSettings();
    await expect(settings.getByText(this.fixture.serverName, { exact: true })).toBeHidden();
    await this.closeSettings(settings);
    const persistedStartup = this.fixture
      .readAcpEvents()
      .find((entry) => entry.event === 'session-new' && entry.sessionId === event.sessionId);
    expect(persistedStartup, 'The completed Turn lost its ACP startup evidence').toBeDefined();
    await this.expectSelectedServerAtAcpStartup(persistedStartup!);
    expect(this.fixture.readAcpEvents()).toContainEqual(
      expect.objectContaining({
        event: 'prompt-end',
        sessionId: event.sessionId,
        stopReason: 'end_turn',
      })
    );
  }

  async deleteSessionAndReleaseAgent(event: McpCatalogAcpEvent): Promise<void> {
    const mcpProcess = await this.fixture.waitForMcpEvent('process-start');
    const match = /#\/local\/sessions\/([^?]+)/u.exec(this.page.url());
    if (!match?.[1]) throw new Error(`Expected a Session route, received ${this.page.url()}`);
    const sessionId = decodeURIComponent(match[1]);
    await this.page
      .getByRole('button', { name: /^(More actions|更多操作)$/u })
      .last()
      .click();
    await this.page.getByRole('menuitem', { name: /^(Archive session|归档会话)$/u }).click();
    await expect(this.page).toHaveURL(/#\/local\/chat(?:\?.*)?$/u, { timeout: 30_000 });
    await Promise.all([
      this.fixture.expectAgentExited(event.pid),
      this.fixture.expectMcpExited(mcpProcess.pid),
    ]);
    await this.page.evaluate((id) => {
      window.location.hash = `/local/sessions/${encodeURIComponent(id)}`;
    }, sessionId);
    const actions = this.page.getByRole('button', { name: /^(More actions|更多操作)$/u }).last();
    await expect(actions).toBeVisible({ timeout: 30_000 });
    await actions.click();
    await this.page.getByRole('menuitem', { name: /^(Delete permanently|永久删除)$/u }).click();
    const dialog = this.page.getByRole('dialog', {
      name: /^(Delete permanently\?|确认永久删除？)$/u,
    });
    await dialog.getByRole('button', { name: /^(Delete permanently|永久删除)$/u }).click();
    await expect(this.page).toHaveURL(/#\/local\/chat(?:\?.*)?$/u, { timeout: 30_000 });
  }

  private externalServers(event: McpCatalogAcpEvent) {
    return (event.mcpServers ?? [])
      .filter((server) => server.name !== 'lody')
      .map(({ name, command, args, env }) => ({ name, command, args, env }));
  }

  private async openMcpSettings(): Promise<Locator> {
    const settings = await this.openSettings();
    await settings.locator('[data-settings-tab-id="mcp"]').click();
    await expect(settings.getByRole('heading', { name: 'MCP', exact: true })).toBeVisible();
    return settings;
  }

  private async openSettings(): Promise<Locator> {
    await this.page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = this.page.getByRole('dialog').filter({
      has: this.page.getByRole('navigation', { name: /^(Settings|设置)$/u }),
    });
    await expect(settings).toBeVisible();
    return settings;
  }

  private async closeSettings(settings: Locator): Promise<void> {
    await this.page.keyboard.press('Escape');
    await expect(settings).toBeHidden();
    if (/#\/local\/sessions\/[^/?#]+/u.test(this.page.url())) {
      await expect(
        this.page.locator('[data-assistant-turn-id]').getByText(RESPONSE_TEXT, { exact: true })
      ).toBeVisible({ timeout: 30_000 });
      return;
    }
    await expect(this.page.locator('#chat-prompt')).toBeEditable({ timeout: 30_000 });
  }
}
