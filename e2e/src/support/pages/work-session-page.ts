import { existsSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';

type TerminalSnapshot = {
  terminalId: string;
  title: string;
  cwd?: string;
};

export type WorkSessionResources = {
  sessionId: string;
  terminalIds: string[];
  worktreePath: string;
};

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ESRCH'
    );
  }
}

export class WorkSessionPage {
  constructor(private readonly page: Page) {}

  async addLocalProject(
    rootPath: string,
    projectName: string,
    machineName?: string
  ): Promise<void> {
    await this.page.getByRole('button', { name: /^(Select a project|选择项目)$/u }).click();
    await this.page.getByRole('menuitem', { name: /^(Add a folder|添加文件夹)$/u }).click();

    const dialog = this.page.getByRole('dialog', { name: /^(Add a folder|添加文件夹)$/u });
    await expect(dialog).toBeVisible();
    const editPath = dialog.getByTitle(/^(Edit path|编辑路径)$/u);
    if (!(await editPath.isVisible())) {
      const machine = machineName
        ? dialog.getByText(machineName, { exact: true })
        : dialog.getByText(/^(Your machine|你的机器)$/u);
      await machine.click();
    }
    await expect(editPath).toBeVisible();
    await editPath.click();
    const pathInput = dialog.getByPlaceholder(/^(Type an absolute path|输入绝对路径)$/u);
    await pathInput.fill(rootPath);
    await pathInput.press('Enter');

    await expect(dialog.getByText(projectName, { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: /^(Add|添加)$/u }).click();
    await expect(dialog).toBeHidden();
    await expect(this.page.getByRole('button', { name: projectName, exact: true })).toBeVisible();
  }

  async selectLocalProject(projectName: string): Promise<void> {
    const selected = this.page.getByRole('button', { name: projectName, exact: true });
    if (await selected.isVisible()) return;
    await this.page.getByRole('button', { name: /^(Select a project|选择项目)$/u }).click();
    await this.page.getByPlaceholder(/^(Search projects|搜索项目)$/u).fill(projectName);
    await this.page.getByRole('menuitem', { name: projectName, exact: true }).click();
    await expect(selected).toBeVisible();
  }

  async selectAgent(agentName: string): Promise<void> {
    await this.page.getByRole('button', { name: /^(Run configuration|运行设置)$/u }).click();
    await this.page.getByRole('menuitem', { name: /^Agent(?:\s|$)/u }).hover();
    const agentOption = this.page.getByRole('menuitemradio', { name: agentName, exact: true });
    await agentOption.click();
    await expect(agentOption).toHaveAttribute('aria-checked', 'true');
    await this.page.keyboard.press('Escape');
  }

  async enableWorktree(): Promise<void> {
    const checkbox = this.page.getByRole('checkbox', { name: /^(Use worktree|使用 worktree)$/u });
    await expect(checkbox).toBeEnabled({ timeout: 30_000 });
    await checkbox.check();
    await expect(checkbox).toBeChecked();
  }

  async startSession(prompt: string): Promise<string> {
    await this.page.locator('#chat-prompt').fill(prompt);
    await this.page.getByRole('button', { name: /^(Send|发送)$/u }).click();
    await expect(this.page).toHaveURL(/#\/local\/sessions\/[^?]+(?:\?.*)?$/u, { timeout: 60_000 });
    const match = /#\/local\/sessions\/([^?]+)/u.exec(this.page.url());
    if (!match?.[1]) throw new Error(`Unable to read Session id from ${this.page.url()}`);
    return decodeURIComponent(match[1]);
  }

  async openTerminalAndRun(command: string, outputMarker: string): Promise<TerminalSnapshot[]> {
    await this.page.getByRole('button', { name: /^(Show terminal panel|显示终端面板)$/u }).click();
    const terminal = this.page.locator('.lody-terminal-panel');
    await expect(terminal).toBeVisible({ timeout: 30_000 });
    const input = terminal.locator('.xterm-helper-textarea');
    await input.focus();
    await this.page.keyboard.type(command);
    await this.page.keyboard.press('Enter');
    await expect(terminal.locator('.xterm-rows')).toContainText(outputMarker, { timeout: 30_000 });

    const sessionId = this.currentSessionId();
    await expect
      .poll(() => this.listTerminals(sessionId), {
        timeout: 30_000,
        intervals: [50, 100, 250, 500],
      })
      .not.toEqual([]);
    return await this.listTerminals(sessionId);
  }

  async captureResources(): Promise<WorkSessionResources> {
    const sessionId = this.currentSessionId();
    const terminals = await this.listTerminals(sessionId);
    expect(terminals.length, 'The Session has no live terminal to clean up').toBeGreaterThan(0);
    const worktreePath = terminals.find((terminal) => terminal.cwd)?.cwd;
    expect(worktreePath, 'The live terminal did not report its worktree cwd').toEqual(
      expect.any(String)
    );
    await expect.poll(() => existsSync(worktreePath!)).toBe(true);
    return {
      sessionId,
      terminalIds: terminals.map((terminal) => terminal.terminalId),
      worktreePath: worktreePath!,
    };
  }

  async archiveAndDeletePermanently(resources: WorkSessionResources): Promise<void> {
    expect(this.currentSessionId()).toBe(resources.sessionId);
    await this.page
      .getByRole('button', { name: /^(More actions|更多操作)$/u })
      .last()
      .click();
    await this.page.getByRole('menuitem', { name: /^(Archive session|归档会话)$/u }).click();
    await expect(this.page).toHaveURL(/#\/local\/chat(?:\?.*)?$/u, { timeout: 30_000 });
    await expect
      .poll(() => this.listTerminals(resources.sessionId), {
        timeout: 30_000,
        intervals: [50, 100, 250, 500],
      })
      .toEqual([]);

    await this.page.evaluate((sessionId) => {
      window.location.hash = `/local/sessions/${encodeURIComponent(sessionId)}`;
    }, resources.sessionId);
    await expect(this.page).toHaveURL(
      new RegExp(`#\\/local\\/sessions\\/${resources.sessionId}(?:\\?.*)?$`, 'u')
    );
    await this.page
      .getByRole('button', { name: /^(More actions|更多操作)$/u })
      .last()
      .click();
    await this.page.getByRole('menuitem', { name: /^(Delete permanently|永久删除)$/u }).click();
    const dialog = this.page.getByRole('dialog', {
      name: /^(Delete permanently\?|确认永久删除？)$/u,
    });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /^(Delete permanently|永久删除)$/u }).click();
    await expect(this.page).toHaveURL(/#\/local\/chat(?:\?.*)?$/u, { timeout: 30_000 });
  }

  async expectResourcesReleased(
    resources: WorkSessionResources,
    agentPids: readonly number[]
  ): Promise<void> {
    expect(agentPids.length, 'The ACP process was not observed before deletion').toBeGreaterThan(0);
    await expect
      .poll(
        async () => ({
          terminals: await this.listTerminals(resources.sessionId),
          worktreeExists: existsSync(resources.worktreePath),
          liveAgentPids: agentPids.filter(isProcessAlive),
        }),
        { timeout: 60_000, intervals: [50, 100, 250, 500, 1000] }
      )
      .toEqual({ terminals: [], worktreeExists: false, liveAgentPids: [] });
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
}
