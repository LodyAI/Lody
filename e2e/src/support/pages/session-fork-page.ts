import { existsSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import { isProcessAlive, SessionForkFixture } from '../fixtures/session-fork-fixture.js';

const AGENT_NAME = 'Deterministic Session Fork Agent';
const SOURCE_PROMPT = 'Create a completed source for deterministic Session fork coverage.';
const RESPONSE = 'Synthetic forkable response complete.';

type TerminalSnapshot = { terminalId: string; cwd?: string };

export type SessionForkResources = {
  sourceSessionId: string;
  targetSessionId: string;
  sourceAcpSessionId: string;
  targetAcpSessionId: string;
  sourceAgentPid: number;
  targetAgentPid: number;
  targetWorktreePath: string;
};

export class SessionForkPage {
  constructor(
    private readonly page: Page,
    private readonly fixture: SessionForkFixture
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
    await expect(this.page.getByText(AGENT_NAME, { exact: true })).toBeVisible({ timeout: 30_000 });
    await this.page.keyboard.press('Escape');
    await expect(settings).toBeHidden();
  }

  async addProjectAndSelectAgent(): Promise<void> {
    await this.page.getByRole('button', { name: /^(Select a project|选择项目)$/u }).click();
    await this.page.getByRole('menuitem', { name: /^(Add a folder|添加文件夹)$/u }).click();
    const dialog = this.page.getByRole('dialog', { name: /^(Add a folder|添加文件夹)$/u });
    await expect(dialog).toBeVisible();
    const editPath = dialog.getByTitle(/^(Edit path|编辑路径)$/u);
    if (!(await editPath.isVisible())) await dialog.getByText(/^(Your machine|你的机器)$/u).click();
    await editPath.click();
    const pathInput = dialog.getByPlaceholder(/^(Type an absolute path|输入绝对路径)$/u);
    await pathInput.fill(this.fixture.projectRoot);
    await pathInput.press('Enter');
    await expect(dialog.getByText(this.fixture.projectName, { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: /^(Add|添加)$/u }).click();
    await expect(dialog).toBeHidden();

    await this.page.getByRole('button', { name: /^(Run configuration|运行设置)$/u }).click();
    await this.page.getByRole('menuitem', { name: /^Agent(?:\s|$)/u }).hover();
    const agent = this.page.getByRole('menuitemradio', { name: AGENT_NAME, exact: true });
    await agent.click();
    await expect(agent).toHaveAttribute('aria-checked', 'true');
    await this.page.keyboard.press('Escape');
  }

  async createCompletedSourceAndForkToWorktree(): Promise<SessionForkResources> {
    await this.page.locator('#chat-prompt').fill(SOURCE_PROMPT);
    await this.page.getByRole('button', { name: /^(Send|发送)$/u }).click();
    await expect(this.page).toHaveURL(/#\/local\/sessions\/[^/?#]+(?:\?.*)?$/u, {
      timeout: 60_000,
    });
    const sourceSessionId = this.currentSessionId();
    await expect(this.assistantResponse()).toBeVisible({ timeout: 60_000 });
    const sourcePrompt = await this.fixture.waitForSourcePrompt();
    expect(sourcePrompt.sessionId).toEqual(expect.any(String));
    expect(sourcePrompt.turnId).toEqual(expect.any(String));

    const forkButton = this.page.getByRole('button', { name: /^(Fork session|分叉会话)$/u });
    await expect(forkButton.last()).toBeVisible({ timeout: 30_000 });
    await forkButton.last().click();
    const newWorktree = this.page.getByRole('menuitem', { name: /^(New worktree|新 worktree)/u });
    await expect(newWorktree).toBeEnabled({ timeout: 30_000 });
    await newWorktree.click();

    await expect
      .poll(() => this.currentSessionId(), {
        timeout: 60_000,
        intervals: [50, 100, 250, 500, 1_000],
      })
      .not.toBe(sourceSessionId);
    const targetSessionId = this.currentSessionId();
    const forkEvent = (await this.fixture.waitForEvent('session-fork')).at(-1)!;
    expect(forkEvent.sourceSessionId).toBe(sourcePrompt.sessionId);
    expect(forkEvent.sourceTurnId).toBe(sourcePrompt.turnId);
    expect(forkEvent.sessionId).toEqual(expect.any(String));
    expect(forkEvent.sessionId).not.toBe(sourcePrompt.sessionId);
    expect(forkEvent.pid).not.toBe(sourcePrompt.pid);

    await expect(this.page.getByText(SOURCE_PROMPT, { exact: true })).toBeVisible();
    await expect(this.assistantResponse()).toBeVisible();
    await expect(this.page.getByText(/^(This conversation was forked from|此对话分叉自)$/u)).toBeVisible();

    await this.page.getByRole('button', { name: /^(Show terminal panel|显示终端面板)$/u }).click();
    await expect(this.page.locator('.lody-terminal-panel')).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => this.listTerminals(targetSessionId)).not.toEqual([]);
    const targetWorktreePath = (await this.listTerminals(targetSessionId)).find(
      (terminal) => terminal.cwd
    )?.cwd;
    expect(targetWorktreePath).toEqual(expect.any(String));
    expect(targetWorktreePath).toBe(forkEvent.cwd);
    await expect.poll(() => existsSync(targetWorktreePath!)).toBe(true);

    return {
      sourceSessionId,
      targetSessionId,
      sourceAcpSessionId: sourcePrompt.sessionId!,
      targetAcpSessionId: forkEvent.sessionId!,
      sourceAgentPid: sourcePrompt.pid,
      targetAgentPid: forkEvent.pid,
      targetWorktreePath: targetWorktreePath!,
    };
  }

  async verifyOriginAndCleanup(resources: SessionForkResources): Promise<void> {
    const originPrefix = this.page.getByText(/^(This conversation was forked from|此对话分叉自)$/u);
    await originPrefix.locator('..').getByRole('button').click();
    await expect.poll(() => this.currentSessionId()).toBe(resources.sourceSessionId);
    await expect(this.page.getByText(SOURCE_PROMPT, { exact: true })).toBeVisible();
    await expect(this.assistantResponse()).toBeVisible();

    await this.navigateToSession(resources.targetSessionId);
    await this.archiveAndDeleteCurrentSession(resources.targetSessionId);
    await expect
      .poll(
        async () => ({
          terminals: await this.listTerminals(resources.targetSessionId),
          worktreeExists: existsSync(resources.targetWorktreePath),
          targetAgentAlive: isProcessAlive(resources.targetAgentPid),
        }),
        { timeout: 60_000, intervals: [50, 100, 250, 500, 1_000] }
      )
      .toEqual({ terminals: [], worktreeExists: false, targetAgentAlive: false });
    expect(isProcessAlive(resources.sourceAgentPid)).toBe(true);

    await this.navigateToSession(resources.targetSessionId);
    await expect(
      this.page.getByRole('heading', { name: /^(Session Not Found|未找到会话)$/u })
    ).toBeVisible({ timeout: 30_000 });
    await this.navigateToSession(resources.sourceSessionId);
    await expect(this.page.getByText(SOURCE_PROMPT, { exact: true })).toBeVisible();
    await expect(this.assistantResponse()).toBeVisible();
    await this.archiveAndDeleteCurrentSession(resources.sourceSessionId);
    await expect.poll(() => isProcessAlive(resources.sourceAgentPid), { timeout: 30_000 }).toBe(false);
  }

  private async archiveAndDeleteCurrentSession(sessionId: string): Promise<void> {
    expect(this.currentSessionId()).toBe(sessionId);
    await this.page.getByRole('button', { name: /^(More actions|更多操作)$/u }).last().click();
    await this.page.getByRole('menuitem', { name: /^(Archive session|归档会话)$/u }).click();
    await expect(this.page).toHaveURL(/#\/local\/chat(?:\?.*)?$/u, { timeout: 30_000 });
    await this.navigateToSession(sessionId);
    await this.page.getByRole('button', { name: /^(More actions|更多操作)$/u }).last().click();
    await this.page.getByRole('menuitem', { name: /^(Delete permanently|永久删除)$/u }).click();
    const dialog = this.page.getByRole('dialog', {
      name: /^(Delete permanently\?|确认永久删除？)$/u,
    });
    await dialog.getByRole('button', { name: /^(Delete permanently|永久删除)$/u }).click();
    await expect(this.page).toHaveURL(/#\/local\/chat(?:\?.*)?$/u, { timeout: 30_000 });
  }

  private async navigateToSession(sessionId: string): Promise<void> {
    await this.page.evaluate((id) => {
      window.location.hash = `/local/sessions/${encodeURIComponent(id)}`;
    }, sessionId);
    await expect(this.page).toHaveURL(
      new RegExp(`#\\/local\\/sessions\\/${sessionId}(?:\\?.*)?$`, 'u')
    );
  }

  private currentSessionId(): string {
    const match = /#\/local\/sessions\/([^?]+)/u.exec(this.page.url());
    if (!match?.[1]) throw new Error(`Expected a Session route, received ${this.page.url()}`);
    return decodeURIComponent(match[1]);
  }

  private async listTerminals(sessionId: string): Promise<TerminalSnapshot[]> {
    return (await this.page.evaluate(async (targetSessionId) => {
      return await window.ipc!.invoke('terminal.list', targetSessionId);
    }, sessionId)) as TerminalSnapshot[];
  }

  private assistantResponse() {
    return this.page.locator('[data-assistant-turn-id]').getByText(RESPONSE, { exact: true });
  }
}
