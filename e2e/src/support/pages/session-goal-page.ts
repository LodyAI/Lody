import { expect, type Locator, type Page } from '@playwright/test';
import {
  GOAL_OBJECTIVE,
  GOAL_START_PROMPT,
  GOAL_UPDATE_PROMPT,
  INDEPENDENT_SESSION_PROMPT,
  UPDATED_GOAL_OBJECTIVE,
  type GoalSessionFixture,
} from '../fixtures/session-goal-fixture.js';

const AGENT_NAME = 'Deterministic Goal Control Agent';

export class GoalSessionPage {
  private primarySessionId: string | null = null;
  private primaryAcpSessionId: string | null = null;
  private secondarySessionId: string | null = null;
  private secondaryAcpSessionId: string | null = null;

  constructor(
    private readonly page: Page,
    private readonly fixture: GoalSessionFixture
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

  async startRunningGoal(): Promise<void> {
    await expect(this.page.locator('#chat-prompt')).toBeEditable({ timeout: 60_000 });
    await this.page.locator('#chat-prompt').fill(GOAL_START_PROMPT);
    await this.page.getByRole('button', { name: /^(Send|发送)$/u }).click();
    await expect(this.page).toHaveURL(/#\/local\/sessions\/[^/?#]+(?:\?.*)?$/u, {
      timeout: 60_000,
    });
    this.primarySessionId = this.currentSessionId();
    this.primaryAcpSessionId = (await this.fixture.waitForInitialGoalPrompt()).sessionId ?? null;
    if (!this.primaryAcpSessionId) {
      throw new Error('The primary goal ACP session id has not been captured');
    }
    await this.fixture.expectGoalCapability();
    await expect(this.page.getByText('Synthetic goal is running.', { exact: true })).toBeVisible({
      timeout: 60_000,
    });
  }

  async expectRunningGoalControls(): Promise<void> {
    await this.expectGoalStage(/Pursuing goal|正在执行目标/u, GOAL_OBJECTIVE);
    await this.openGoalDetails();
    await expect(this.goalDetails().getByText(GOAL_OBJECTIVE, { exact: true })).toBeVisible();
    await expect(this.goalDetails().getByRole('button', { name: /^(Pause|暂停)$/u })).toBeEnabled();
    await expect(this.goalDetails().getByRole('button', { name: /^(Clear|清除)$/u })).toBeEnabled();
  }

  async completeIndependentSessionAndReturnToGoal(): Promise<void> {
    await this.openHome();
    await expect(this.page.locator('#chat-prompt')).toBeEditable();
    await this.page.locator('#chat-prompt').fill(INDEPENDENT_SESSION_PROMPT);
    await this.page.getByRole('button', { name: /^(Send|发送)$/u }).click();
    await expect(this.page).toHaveURL(/#\/local\/sessions\/[^/?#]+(?:\?.*)?$/u, {
      timeout: 60_000,
    });
    this.secondarySessionId = this.currentSessionId();
    this.secondaryAcpSessionId =
      (await this.fixture.waitForIndependentSessionPrompt()).sessionId ?? null;
    if (!this.secondaryAcpSessionId) {
      throw new Error('The independent Session ACP session id has not been captured');
    }
    await expect(this.page.getByText('Synthetic response complete.', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(this.goalStage()).toHaveCount(0);
    await this.primarySessionRow().click();
    await expect(this.page).toHaveURL(this.primarySessionRoutePattern());
  }

  async expectSessionIsolation(): Promise<void> {
    const primaryAcpSessionId = this.requirePrimaryAcpSessionId();
    const secondaryAcpSessionId = this.requireSecondaryAcpSessionId();
    expect(secondaryAcpSessionId).not.toBe(primaryAcpSessionId);
    expect(this.requireSecondarySessionId()).not.toBe(this.requirePrimarySessionId());
    expect(
      this.fixture
        .readEvents()
        .some(
          (event) => event.event === 'goal-snapshot' && event.sessionId === secondaryAcpSessionId
        )
    ).toBe(false);
    await this.expectGoalStage(/Pursuing goal|正在执行目标/u, GOAL_OBJECTIVE);
  }

  async pauseRunningGoal(): Promise<void> {
    await this.openGoalDetails();
    await this.goalDetails()
      .getByRole('button', { name: /^(Pause|暂停)$/u })
      .click();
  }

  async expectPausedGoalAndControlEvidence(): Promise<void> {
    const pause = await this.fixture.waitForControl('pause');
    expect(pause.sessionId).toBeTruthy();
    await this.fixture.waitForGoalSnapshot(pause.sessionId!, 'paused');
    const events = this.fixture.readEvents();
    const sessionEvents = events.filter((event) => event.sessionId === pause.sessionId);
    const pauseIndex = sessionEvents.findIndex(
      (event) => event.event === 'goal-control' && event.action === 'pause'
    );
    expect(pauseIndex).toBeGreaterThanOrEqual(0);
    expect(
      sessionEvents
        .slice(0, pauseIndex)
        .filter((event) => event.event === 'prompt-start')
        .map((event) => event.mode)
    ).toEqual(['initial-goal']);
    expect(sessionEvents.slice(pauseIndex).some((event) => event.mode === 'resume-goal')).toBe(
      false
    );
    await this.expectGoalStage(/Goal paused|目标已暂停/u, GOAL_OBJECTIVE);
    await this.openGoalDetails();
    await expect(
      this.goalDetails().getByRole('button', { name: /^(Resume|恢复)$/u })
    ).toBeEnabled();
    await expect(this.goalDetails().getByRole('button', { name: /^(Clear|清除)$/u })).toBeEnabled();
  }

  async expectPausedGoalRejectsDuplicateActions(): Promise<void> {
    const primaryAcpSessionId = this.requirePrimaryAcpSessionId();
    await this.openGoalDetails();
    await expect(this.goalDetails().getByRole('button', { name: /^(Pause|暂停)$/u })).toHaveCount(
      0
    );
    expect(this.fixture.controlEvents(primaryAcpSessionId, 'pause')).toHaveLength(1);
    await this.expectNoGoalActionError();
  }

  async resumePausedGoal(): Promise<void> {
    await this.openGoalDetails();
    await this.goalDetails()
      .getByRole('button', { name: /^(Resume|恢复)$/u })
      .click();
  }

  async updatePausedGoal(): Promise<void> {
    const composer = this.sessionComposer();
    await expect(composer).toBeEditable({ timeout: 30_000 });
    await composer.fill(GOAL_UPDATE_PROMPT);
    await this.page.getByRole('button', { name: /^(Send|发送)$/u }).click();
    await this.fixture.waitForGoalUpdatePrompt();
  }

  async expectResumedGoalAndPromptEvidence(): Promise<void> {
    const resume = await this.fixture.waitForResumePrompt();
    expect(resume.promptText).toBe('Continue working toward the active goal.');
    expect(resume.promptText).not.toContain('/goal resume');
    expect(resume.goalControl).toEqual({ version: 1, action: 'resume' });
    await this.expectGoalStage(/Pursuing goal|正在执行目标/u, UPDATED_GOAL_OBJECTIVE);
    await expect(
      this.page.getByText('Synthetic goal resumed through prompt metadata.', { exact: true })
    ).toBeVisible({
      timeout: 30_000,
    });
    await this.openGoalDetails();
    await expect(this.goalDetails().getByRole('button', { name: /^(Pause|暂停)$/u })).toBeEnabled();
  }

  async expectUpdatedGoalMetadataAndWireEvidence(): Promise<void> {
    const primaryAcpSessionId = this.requirePrimaryAcpSessionId();
    const updated = await this.fixture.waitForGoalSnapshot(
      primaryAcpSessionId,
      'paused',
      UPDATED_GOAL_OBJECTIVE
    );
    expect(updated).toMatchObject({ tokenBudget: 10_000, tokensUsed: 4_200, timeUsedSeconds: 210 });
    await expect(
      this.page.getByText('Synthetic goal details updated through ACP.', { exact: true })
    ).toBeVisible({ timeout: 30_000 });
    await this.expectGoalStage(/Goal paused|目标已暂停/u, UPDATED_GOAL_OBJECTIVE);
    await this.openGoalDetails();
    await expect(
      this.goalDetails().getByText('tokens: 4.20K / 10K', { exact: true })
    ).toBeVisible();
  }

  async reopenGoalSessionThroughSidebar(): Promise<void> {
    await this.openHome();
    await this.primarySessionRow().click();
    await expect(this.page).toHaveURL(this.primarySessionRoutePattern());
  }

  async expectUpdatedGoalAfterReopen(): Promise<void> {
    await this.expectGoalStage(/Pursuing goal|正在执行目标/u, UPDATED_GOAL_OBJECTIVE);
    await this.openGoalDetails();
    await expect(this.goalDetails().getByRole('button', { name: /^(Pause|暂停)$/u })).toBeEnabled();
    await expect(
      this.goalDetails().getByText('tokens: 4.20K / 10K', { exact: true })
    ).toBeVisible();
  }

  async pauseReopenedGoalAndClearIt(): Promise<void> {
    const primaryAcpSessionId = this.requirePrimaryAcpSessionId();
    await this.openGoalDetails();
    await this.goalDetails()
      .getByRole('button', { name: /^(Pause|暂停)$/u })
      .click();
    await expect
      .poll(() => this.fixture.controlEvents(primaryAcpSessionId, 'pause').length, {
        timeout: 30_000,
        intervals: [50, 100, 250, 500],
      })
      .toBe(2);
    await this.expectGoalStage(/Goal paused|目标已暂停/u, UPDATED_GOAL_OBJECTIVE);
    await this.openGoalDetails();
    await this.goalDetails()
      .getByRole('button', { name: /^(Clear|清除)$/u })
      .click();
  }

  async expectClearedGoalStateMachineAndNoErrors(): Promise<void> {
    const primaryAcpSessionId = this.requirePrimaryAcpSessionId();
    const clear = await this.fixture.waitForControl('clear');
    expect(clear.sessionId).toBe(primaryAcpSessionId);
    await this.fixture.waitForGoalSnapshot(primaryAcpSessionId, null);
    expect(this.fixture.controlEvents(primaryAcpSessionId, 'pause')).toHaveLength(2);
    expect(this.fixture.controlEvents(primaryAcpSessionId, 'clear')).toHaveLength(1);
    expect(
      this.fixture
        .readEvents()
        .filter(
          (event) => event.sessionId === primaryAcpSessionId && event.event === 'prompt-start'
        )
        .map((event) => event.mode)
    ).toEqual(['initial-goal', 'update-goal', 'resume-goal']);
    await this.expectGoalStage(/Goal cleared|目标已清除/u, UPDATED_GOAL_OBJECTIVE);
    await this.openGoalDetails();
    await expect(this.goalDetails().getByRole('button', { name: /^(Pause|暂停)$/u })).toHaveCount(
      0
    );
    await expect(this.goalDetails().getByRole('button', { name: /^(Resume|恢复)$/u })).toHaveCount(
      0
    );
    await expect(this.goalDetails().getByRole('button', { name: /^(Clear|清除)$/u })).toHaveCount(
      0
    );
    await expect(
      this.goalDetails().getByRole('button', { name: /^(Dismiss goal banner|关闭目标横幅)$/u })
    ).toBeVisible();
    await this.expectNoGoalActionError();
  }

  async archiveAndRestoreClearedGoalSession(): Promise<void> {
    await this.archiveCurrentSession();
    const archived = this.archivedRow();
    await expect(archived).toBeVisible({ timeout: 30_000 });
    await archived.hover();
    await this.page.getByRole('button', { name: /^(Restore session|恢复会话)$/u }).click();
    await expect(archived).toHaveCount(0);
    await expect(this.primarySessionRow()).toBeVisible();
  }

  async expectRestoredClearedGoalAndFinalCleanup(): Promise<void> {
    await this.primarySessionRow().click();
    await expect(this.page).toHaveURL(this.primarySessionRoutePattern());
    await this.expectGoalStage(/Goal cleared|目标已清除/u, UPDATED_GOAL_OBJECTIVE);
    await this.archiveAndPermanentlyDeleteSession(this.requirePrimarySessionId());
    await this.secondarySessionRow().click();
    await expect(this.page).toHaveURL(this.secondarySessionRoutePattern());
    await this.archiveAndPermanentlyDeleteSession(this.requireSecondarySessionId());
  }

  private goalStage(): Locator {
    return this.page.getByRole('button', { name: /^(Goal|目标)$/u });
  }

  private goalDetails(): Locator {
    return this.page.getByRole('dialog', { name: /^(Goal|目标)$/u });
  }

  private async expectGoalStage(status: RegExp, objective: string): Promise<void> {
    await expect(this.goalStage()).toBeVisible();
    await expect(this.goalStage()).toContainText(status);
    await expect(this.goalStage()).toContainText(objective);
  }

  private async openGoalDetails(): Promise<void> {
    const stage = this.goalStage();
    if ((await stage.getAttribute('aria-expanded')) !== 'true') {
      await stage.click();
    }
    await expect(this.goalDetails()).toBeVisible();
  }

  private primarySessionRow(): Locator {
    return this.page.locator(`[data-sidebar-session-id="${this.requirePrimarySessionId()}"]`);
  }

  private secondarySessionRow(): Locator {
    return this.page.locator(`[data-sidebar-session-id="${this.requireSecondarySessionId()}"]`);
  }

  private archivedRow(): Locator {
    return this.page.locator(`[data-id="archive-session:${this.requirePrimarySessionId()}"]`);
  }

  private archivedRowFor(sessionId: string): Locator {
    return this.page.locator(`[data-id="archive-session:${sessionId}"]`);
  }

  private currentSessionId(): string {
    const match = /#\/local\/sessions\/([^?]+)/u.exec(this.page.url());
    if (!match?.[1]) throw new Error(`Expected a Session route, received ${this.page.url()}`);
    return decodeURIComponent(match[1]);
  }

  private primarySessionRoutePattern(): RegExp {
    return new RegExp(`#\\/local\\/sessions\\/${this.requirePrimarySessionId()}(?:\\?.*)?$`, 'u');
  }

  private secondarySessionRoutePattern(): RegExp {
    return new RegExp(`#\\/local\\/sessions\\/${this.requireSecondarySessionId()}(?:\\?.*)?$`, 'u');
  }

  private sessionComposer(): Locator {
    return this.page.locator('[data-keyboard-nav="composer"]');
  }

  private async openHome(): Promise<void> {
    await this.page.getByRole('button', { name: /^(Home|New chat|主页|新对话)$/u }).click();
    await expect(this.page).toHaveURL(/#\/local\/chat(?:\?.*)?$/u);
  }

  private async archiveCurrentSession(): Promise<void> {
    await this.page
      .getByRole('button', { name: /^(More actions|更多操作)$/u })
      .last()
      .click();
    await this.page.getByRole('menuitem', { name: /^(Archive session|归档会话)$/u }).click();
    await expect(this.page).toHaveURL(/#\/local\/chat(?:\?.*)?$/u, { timeout: 30_000 });
    await this.page.getByRole('button', { name: /^(Archive|归档)$/u, exact: true }).click();
    await expect(this.page).toHaveURL(/#\/local\/archive(?:\?.*)?$/u);
  }

  private async archiveAndPermanentlyDeleteSession(sessionId: string): Promise<void> {
    await this.archiveCurrentSession();
    const archived = this.archivedRowFor(sessionId);
    await expect(archived).toBeVisible({ timeout: 30_000 });
    await archived.hover();
    await this.page.getByRole('button', { name: /^(Delete permanently|永久删除)$/u }).click();
    const dialog = this.page.getByRole('dialog', {
      name: /^(Delete permanently\?|确认永久删除？)$/u,
    });
    await dialog.getByRole('button', { name: /^(Delete|删除)$/u }).click();
    await expect(archived).toHaveCount(0);
    await expect(this.page.locator(`[data-sidebar-session-id="${sessionId}"]`)).toHaveCount(0);
  }

  private requirePrimarySessionId(): string {
    if (!this.primarySessionId)
      throw new Error('The primary goal Session id has not been captured');
    return this.primarySessionId;
  }

  private requireSecondarySessionId(): string {
    if (!this.secondarySessionId)
      throw new Error('The independent Session id has not been captured');
    return this.secondarySessionId;
  }

  private requirePrimaryAcpSessionId(): string {
    if (!this.primaryAcpSessionId) {
      throw new Error('The primary goal ACP session id has not been captured');
    }
    return this.primaryAcpSessionId;
  }

  private requireSecondaryAcpSessionId(): string {
    if (!this.secondaryAcpSessionId) {
      throw new Error('The independent Session ACP session id has not been captured');
    }
    return this.secondaryAcpSessionId;
  }

  private async expectNoGoalActionError(): Promise<void> {
    await expect(this.page.getByText(/Goal (pause|resume|clear) failed/i)).toHaveCount(0);
    await expect(
      this.page.getByText('Invalid synthetic goal control request', { exact: true })
    ).toHaveCount(0);
  }
}
