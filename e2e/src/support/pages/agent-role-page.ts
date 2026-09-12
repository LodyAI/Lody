import { expect, type Locator, type Page } from '@playwright/test';
import { AgentRoleFixture } from '../fixtures/agent-role-fixture.js';

type SessionMetaEvidence = {
  id?: string;
  machineId?: string;
  agentConfigId?: string;
  agentRoleId?: string;
  agentRoleRevision?: number;
};

type ActiveInvocationEvidence = {
  type: string;
  sessionId: string;
  active: boolean;
  sourceTurnId?: string;
  inputConfig?: Record<string, unknown>;
};

export type AgentRoleResources = {
  sessionId: string;
  agentPid: number;
  acpSessionId: string;
  acceptedMeta: SessionMetaEvidence;
  acceptedInvocation: ActiveInvocationEvidence;
};

export class AgentRolePage {
  constructor(
    private readonly page: Page,
    private readonly fixture: AgentRoleFixture
  ) {}

  async configureAgentFromSettings(): Promise<void> {
    const settings = await this.openSettings();
    await settings.locator('[data-settings-tab-id="agents"]').click();
    const addProvider = settings.getByRole('button', {
      name: /^(Add provider|添加 Provider)$/u,
    });
    await expect(addProvider.first()).toBeEnabled({ timeout: 60_000 });
    await addProvider.first().click();
    await this.page.getByRole('option', { name: /^(Custom command|自定义命令)$/u }).click();
    await this.page.locator('#agent-config-name').fill(this.fixture.agentName);
    await this.page.locator('#custom-acp-command').fill(this.fixture.agentCommandLine);
    await this.page.getByRole('button', { name: /^(Test command|测试命令)$/u }).click();
    await expect(this.page.getByText(/^(Ready|就绪)$/u).first()).toBeVisible({ timeout: 60_000 });
    await this.page.getByRole('button', { name: /^(Create|创建)$/u }).click();
    await expect(this.page.getByText(this.fixture.agentName, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await this.closeSettings(settings);
    await expect(this.page.locator('#chat-prompt')).toBeEditable({ timeout: 30_000 });
  }

  async createRoleAndSelectIt(): Promise<void> {
    const settings = await this.openAgentRoleSettings();
    await settings
      .getByRole('button', { name: /^(Add role|添加角色)$/u })
      .first()
      .click();
    const editor = this.page.getByRole('dialog', {
      name: /^(New Agent Role|新建 Agent 角色)$/u,
    });
    await editor.getByLabel(/^(Name|名称)$/u).fill(this.fixture.roleName);
    await editor
      .getByLabel(/^(Default instruction|默认指令)$/u)
      .fill(this.fixture.initialInstruction);
    await editor.getByLabel(/^(Machine|机器)$/u).click();
    await this.page.getByRole('option').first().click();
    await editor.getByLabel(/^(Agent config|Agent 配置)$/u).click();
    await this.page.getByRole('option', { name: this.fixture.agentName, exact: true }).click();
    await editor.getByRole('button', { name: /^(Create role|创建角色)$/u }).click();
    await expect(editor).toBeHidden({ timeout: 30_000 });
    await expect(settings.getByText(this.fixture.roleName, { exact: true })).toBeVisible();
    await this.closeSettings(settings);

    const reopened = await this.openAgentRoleSettings();
    await expect(reopened.getByText(this.fixture.roleName, { exact: true })).toBeVisible();
    await this.closeSettings(reopened);
    await expect(this.page.locator('#chat-prompt')).toBeEditable({ timeout: 30_000 });

    await this.page.getByRole('button', { name: /^(Run configuration|运行设置)$/u }).click();
    const roleMenu = this.page.getByRole('menuitem', { name: /^(Role|角色)(?:\s|$)/u });
    await roleMenu.focus();
    await roleMenu.press('ArrowRight');
    const roleOption = this.page.getByRole('menuitemradio', {
      name: this.fixture.roleName,
      exact: true,
    });
    await expect(roleOption).toBeEnabled();
    await roleOption.press('Enter');
    await expect(
      this.page.getByRole('button', { name: /^(Run configuration|运行设置)$/u })
    ).toContainText(this.fixture.roleName);
  }

  async startHeldSession(): Promise<AgentRoleResources> {
    await this.page.locator('#chat-prompt').fill(this.fixture.taskPrompt);
    await this.page.getByRole('button', { name: /^(Send|发送)$/u }).click();
    await expect(this.page).toHaveURL(/#\/local\/sessions\/[^/?#]+(?:\?.*)?$/u, {
      timeout: 60_000,
    });
    const sessionId = this.currentSessionId();
    const promptEvent = await this.fixture.waitForEvent(
      'prompt-start',
      (event) => event.prompt?.includes(this.fixture.taskPrompt) === true
    );
    expect(promptEvent.sessionId).toEqual(expect.any(String));
    const acceptedMeta = await this.readSessionMeta(sessionId);
    const acceptedInvocation = await this.readActiveInvocation(sessionId, acceptedMeta);
    return {
      sessionId,
      agentPid: promptEvent.pid,
      acpSessionId: promptEvent.sessionId!,
      acceptedMeta,
      acceptedInvocation,
    };
  }

  async expectAcceptedRoleContract(resources: AgentRoleResources): Promise<void> {
    const { acceptedMeta, acceptedInvocation } = resources;
    expect(acceptedMeta.agentRoleId).toEqual(expect.any(String));
    expect(acceptedMeta.agentRoleRevision).toBe(1);
    expect(acceptedMeta.machineId).toEqual(expect.any(String));
    expect(acceptedMeta.agentConfigId).toEqual(expect.any(String));
    expect(acceptedInvocation).toMatchObject({
      type: 'session/active-invocation-context',
      sessionId: resources.sessionId,
      active: true,
      sourceTurnId: expect.any(String),
      inputConfig: {
        agentRoleId: acceptedMeta.agentRoleId,
        agentRoleRevision: 1,
      },
    });
    expect(String(acceptedInvocation.inputConfig?.prompt)).toContain(
      this.fixture.initialInstruction
    );
    expect(String(acceptedInvocation.inputConfig?.prompt)).toContain(this.fixture.taskPrompt);
    expect(
      this.fixture
        .readEvents()
        .find(
          (event) => event.event === 'prompt-start' && event.sessionId === resources.acpSessionId
        )?.prompt
    ).toContain(this.fixture.initialInstruction);
  }

  async editRoleAfterDispatch(): Promise<void> {
    const settings = await this.openAgentRoleSettings();
    await settings.getByRole('button', { name: /^(Edit|编辑)$/u }).click();
    const editor = this.page.getByRole('dialog', {
      name: /^(Edit Agent Role|编辑 Agent 角色)$/u,
    });
    await editor.getByLabel(/^(Name|名称)$/u).fill(this.fixture.editedRoleName);
    await editor
      .getByLabel(/^(Default instruction|默认指令)$/u)
      .fill(this.fixture.editedInstruction);
    await editor.getByRole('button', { name: /^(Save|保存)$/u }).click();
    await expect(editor).toBeHidden({ timeout: 30_000 });
    await expect(settings.getByText(this.fixture.editedRoleName, { exact: true })).toBeVisible();
    await this.closeSettings(settings);
  }

  async expectHeldSessionStillUsesAcceptedRole(resources: AgentRoleResources): Promise<void> {
    const currentMeta = await this.readSessionMeta(resources.sessionId);
    const currentInvocation = await this.readActiveInvocation(resources.sessionId, currentMeta);
    expect(currentMeta.agentRoleId).toBe(resources.acceptedMeta.agentRoleId);
    expect(currentMeta.agentRoleRevision).toBe(resources.acceptedMeta.agentRoleRevision);
    expect(currentMeta.machineId).toBe(resources.acceptedMeta.machineId);
    expect(currentMeta.agentConfigId).toBe(resources.acceptedMeta.agentConfigId);
    expect(currentInvocation.sourceTurnId).toBe(resources.acceptedInvocation.sourceTurnId);
    expect(currentInvocation.inputConfig).toEqual(resources.acceptedInvocation.inputConfig);
    expect(String(currentInvocation.inputConfig?.prompt)).not.toContain(
      this.fixture.editedInstruction
    );
  }

  async deleteRoleAndCompleteSession(resources: AgentRoleResources): Promise<void> {
    const settings = await this.openAgentRoleSettings();
    await settings.getByRole('button', { name: /^(Remove|移除)$/u }).click();
    const confirmation = this.page.getByRole('alertdialog');
    await expect(confirmation.getByText(this.fixture.editedRoleName)).toBeVisible();
    await confirmation.getByRole('button', { name: /^(Remove|移除)$/u }).click();
    await expect(settings.getByText(this.fixture.editedRoleName, { exact: true })).toBeHidden({
      timeout: 30_000,
    });
    await this.closeSettings(settings);

    this.fixture.releasePrompt();
    const responseBody = this.page.locator('p').filter({ hasText: this.fixture.responseText });
    await expect(responseBody).toHaveText(this.fixture.responseText, { timeout: 60_000 });
    const completed = await this.fixture.waitForEvent(
      'prompt-end',
      (event) => event.sessionId === resources.acpSessionId
    );
    expect(completed).toMatchObject({
      sessionId: resources.acpSessionId,
      stopReason: 'end_turn',
      prompt: expect.stringContaining(this.fixture.initialInstruction),
    });
    expect(completed.prompt).not.toContain(this.fixture.editedInstruction);
  }

  async deleteSessionAndVerifyCleanup(resources: AgentRoleResources): Promise<void> {
    const settings = this.settingsDialog();
    if (await settings.isVisible()) {
      await this.closeSettings(settings);
    }
    await this.page
      .getByRole('button', { name: /^(More actions|更多操作)$/u })
      .last()
      .click();
    await this.page.getByRole('menuitem', { name: /^(Archive session|归档会话)$/u }).click();
    await expect(this.page).toHaveURL(/#\/local\/chat(?:\?.*)?$/u, { timeout: 30_000 });
    await this.fixture.expectAgentExited(resources.agentPid);
    await this.page.getByRole('button', { name: /^(Archive|归档)$/u, exact: true }).click();
    await expect(this.page).toHaveURL(/#\/local\/archive(?:\?.*)?$/u);
    const archivedRow = this.page.locator(`[data-id="archive-session:${resources.sessionId}"]`);
    await expect(archivedRow).toBeVisible({ timeout: 30_000 });
    await archivedRow.hover();
    await this.page.getByRole('button', { name: /^(Delete permanently|永久删除)$/u }).click();
    const dialog = this.page.getByRole('dialog', {
      name: /^(Delete permanently\?|确认永久删除？)$/u,
    });
    await dialog.getByRole('button', { name: /^(Delete|删除)$/u }).click();
    await expect(archivedRow).toHaveCount(0);

    const reopenedSettings = await this.openAgentRoleSettings();
    await expect(reopenedSettings.getByText(this.fixture.roleName, { exact: true })).toBeHidden();
    await expect(
      reopenedSettings.getByText(this.fixture.editedRoleName, { exact: true })
    ).toBeHidden();
    await this.closeSettings(reopenedSettings);
  }

  private currentSessionId(): string {
    const match = /#\/local\/sessions\/([^?]+)/u.exec(this.page.url());
    if (!match?.[1]) throw new Error(`Expected a Session route, received ${this.page.url()}`);
    return decodeURIComponent(match[1]);
  }

  private async readSessionMeta(sessionId: string): Promise<SessionMetaEvidence> {
    return await this.page.evaluate(async (id) => {
      const repo = (
        window as typeof window & {
          repo?: { getDocMeta(roomId: string): Promise<{ meta?: unknown } | undefined> };
        }
      ).repo;
      if (!repo) throw new Error('Renderer workspace repo is unavailable');
      const entry = await repo.getDocMeta(`session-${id}`);
      if (!entry?.meta || typeof entry.meta !== 'object') {
        throw new Error(`Session metadata is unavailable for ${id}`);
      }
      return entry.meta as SessionMetaEvidence;
    }, sessionId);
  }

  private async readActiveInvocation(
    sessionId: string,
    meta: SessionMetaEvidence
  ): Promise<ActiveInvocationEvidence> {
    if (!meta.machineId) throw new Error('Session metadata is missing machineId');
    return await this.page.evaluate(
      async ({ id, machineId }) => {
        const ipc = window.ipc;
        if (!ipc) throw new Error('Electron IPC bridge is unavailable');
        const platform = (await ipc.invoke('localPlatform.getSnapshot')) as {
          workspace?: { workspaceId?: string };
        } | null;
        const workspaceId = platform?.workspace?.workspaceId;
        if (!workspaceId) throw new Error('Local workspace id is unavailable');
        const response = (await ipc.invoke('machineRpc.send', {
          method: 'session/get-active-invocation-context',
          machineId,
          workspaceId,
          params: { sessionId: id },
        })) as { ok?: boolean; result?: ActiveInvocationEvidence; error?: string };
        if (!response.ok || !response.result) {
          throw new Error(response.error ?? 'Active invocation RPC failed');
        }
        return response.result;
      },
      { id: sessionId, machineId: meta.machineId }
    );
  }

  private async openAgentRoleSettings(): Promise<Locator> {
    const settings = await this.openSettings();
    await settings.locator('[data-settings-tab-id="agent-roles"]').click();
    await expect(
      settings.getByText(/^(An Agent Role saves|Agent 角色保存了)/u).first()
    ).toBeVisible();
    return settings;
  }

  private async openSettings(): Promise<Locator> {
    await this.page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = this.settingsDialog();
    await expect(settings).toBeVisible();
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
}
