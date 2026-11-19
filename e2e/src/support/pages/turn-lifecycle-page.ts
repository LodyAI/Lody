import { expect, type Locator, type Page } from '@playwright/test';
import type { TurnLifecycleFixture } from '../fixtures/turn-lifecycle-fixture.js';

const PERMISSION_PROMPT = '[LODY-TURN-001:PERMISSION] Edit the synthetic file after approval.';
const CRASH_PROMPT = '[LODY-TURN-001:CRASH] The agent process dies during this turn.';
const RECOVER_PROMPT = '[LODY-TURN-001:RECOVER] Continue after the agent crash.';
const BEFORE_PROMPT = '[LODY-TURN-002:BEFORE] Reply before the desktop restarts.';
const AFTER_PROMPT = '[LODY-TURN-002:AFTER] Reply after the desktop restarts.';
const HOLD_PROMPT = '[LODY-TURN-003:HOLD] Keep working until the desktop restarts.';
// Local and cloud workspaces route Sessions under different workspace prefixes.
const SESSION_URL = /#\/(?:[^?#]*\/)?sessions\/([^/?#]+)(?:\?.*)?$/u;

export class TurnLifecyclePage {
  constructor(
    private readonly page: Page,
    private readonly fixture: TurnLifecycleFixture
  ) {}

  async configureCustomAgent(): Promise<void> {
    await this.page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = this.page.getByRole('dialog').filter({
      has: this.page.getByRole('navigation', { name: /^(Settings|设置)$/u }),
    });
    await expect(settings).toBeVisible();
    await settings.getByRole('button', { name: /^(Agents|Agent)$/u }).click();
    const addProvider = settings.getByRole('button', { name: /^(Add provider|添加 Provider)$/u });
    await expect(addProvider.first()).toBeEnabled({ timeout: 60_000 });
    await addProvider.first().click();
    await this.page.getByRole('option', { name: /^(Custom command|自定义命令)$/u }).click();
    await this.page.locator('#agent-config-name').fill('Deterministic Turn Lifecycle Agent');
    await this.page.locator('#custom-acp-command').fill(this.fixture.scriptedAgentCommandLine);
    await this.page.getByRole('button', { name: /^(Test command|测试命令)$/u }).click();
    await expect(this.page.getByText(/^(Ready|就绪)$/u).first()).toBeVisible({ timeout: 60_000 });
    await this.page.getByRole('button', { name: /^(Create|创建)$/u }).click();
    await expect(
      this.page.getByText('Deterministic Turn Lifecycle Agent', { exact: true })
    ).toBeVisible({ timeout: 30_000 });
    await this.page.keyboard.press('Escape');
    await expect(settings).toBeHidden();
    await this.expectComposerReady();
    await this.selectDeterministicAgent();
  }

  /** A new provider is not guaranteed to become the composer's selection; choose it. */
  private async selectDeterministicAgent(): Promise<void> {
    const trigger = this.page.locator(
      'button[aria-label="Run configuration"], button[aria-label="运行设置"]'
    );
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const agentSubmenu = this.page.getByRole('menuitem', { name: /^Agent(?:\s|$)/u });
    await agentSubmenu.hover();
    await expect(agentSubmenu).toHaveAttribute('aria-expanded', 'true');
    const option = this.page.getByRole('menuitemradio', {
      name: 'Deterministic Turn Lifecycle Agent',
      exact: true,
    });
    const bounds = await option.boundingBox();
    if (!bounds) throw new Error('The deterministic agent is not offered in the composer');
    // Cross the submenu gap the way a pointer does so the submenu stays open.
    await this.page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, {
      steps: 8,
    });
    await option.click();
    await expect(option).toHaveAttribute('aria-checked', 'true');
    await this.page.keyboard.press('Escape');
    if (await agentSubmenu.isVisible()) await this.page.keyboard.press('Escape');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  }

  /** Starts a Session whose first Turn waits on a provider permission request. */
  async startSessionAwaitingPermission(): Promise<void> {
    await this.send(PERMISSION_PROMPT);
    await expect(this.page).toHaveURL(SESSION_URL, { timeout: 60_000 });
    await expect(this.allowOnce()).toBeVisible({ timeout: 60_000 });
  }

  async approvePermission(): Promise<void> {
    await this.allowOnce().click();
    await expect(
      this.page.getByText('Synthetic permission outcome: allow-once.', { exact: true })
    ).toBeVisible({ timeout: 30_000 });
    await this.expectTurnSettled();
    // The provider received exactly the user's choice, once.
    expect(this.fixture.permissionOutcomes()).toEqual(['allow-once']);
  }

  async sendTurnThatCrashesTheAgent(): Promise<void> {
    await this.send(CRASH_PROMPT);
    await this.fixture.waitForEvent((event) => event.event === 'crash');
    await expect(
      this.page.getByText('Synthetic output before the agent crash.', { exact: true })
    ).toBeVisible({ timeout: 30_000 });
  }

  /** A dead provider must release its Turn so the Session accepts the next message. */
  async expectCrashedTurnReleasedAndFollowUpRecovers(): Promise<void> {
    await this.expectTurnSettled();
    await this.send(RECOVER_PROMPT);
    await expect(this.page.getByText('Synthetic recovery reply.', { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await this.expectTurnSettled();

    const starts = this.fixture.journeyPromptStarts();
    expect(starts.map((start) => start.mode)).toEqual(['permission', 'crash', 'recover']);
    const crashed = starts.find((start) => start.mode === 'crash')!;
    const recovered = starts.find((start) => start.mode === 'recover')!;
    expect(recovered.pid, 'the follow-up runs in a replacement provider process').not.toBe(
      crashed.pid
    );
  }

  /** Completes one Turn and returns the Session id the desktop routed to. */
  async completeTurnBeforeRestart(): Promise<string> {
    await this.send(BEFORE_PROMPT);
    await expect(this.page).toHaveURL(SESSION_URL, { timeout: 60_000 });
    await expect(
      this.page.getByText('Synthetic reply before restart.', { exact: true })
    ).toBeVisible({ timeout: 60_000 });
    await this.expectTurnSettled();
    const sessionId = SESSION_URL.exec(this.page.url())?.[1];
    if (!sessionId) throw new Error(`No Session id in ${this.page.url()}`);
    return decodeURIComponent(sessionId);
  }

  /** After a cold restart the reopened Session admits a follow-up exactly once, in order. */
  async reopenSessionAndSendFollowUp(sessionId: string): Promise<void> {
    const entry = this.page.locator(`[data-sidebar-session-id="${sessionId}"]`);
    await expect(entry).toBeVisible({ timeout: 60_000 });
    await entry.click();
    await expect(
      this.page.getByText('Synthetic reply before restart.', { exact: true })
    ).toBeVisible({ timeout: 60_000 });
    await this.expectComposerReady();
    await this.send(AFTER_PROMPT);
    const reply = this.page.getByText('Synthetic reply after restart.', { exact: true });
    await expect(reply).toBeVisible({ timeout: 60_000 });
    await this.expectTurnSettled();

    // The new user message renders before the reply it produced.
    const userBox = await this.page.getByText(AFTER_PROMPT, { exact: true }).last().boundingBox();
    const replyBox = await reply.boundingBox();
    expect(userBox && replyBox && userBox.y < replyBox.y).toBe(true);
    expect(this.fixture.journeyPromptStarts().map((start) => start.mode)).toEqual([
      'before',
      'after',
    ]);
  }

  /** Starts a Turn whose agent keeps working until its process ends; returns the Session id. */
  async startLongRunningTurn(): Promise<string> {
    await this.send(HOLD_PROMPT);
    await expect(this.page).toHaveURL(SESSION_URL, { timeout: 60_000 });
    await expect(
      this.page.getByText('Synthetic long-running work started.', { exact: true })
    ).toBeVisible({ timeout: 60_000 });
    await this.fixture.waitForEvent((event) => event.event === 'hold-started');
    await expect(this.page.getByRole('button', { name: /^(Stop|停止)$/u })).toBeVisible();
    const sessionId = SESSION_URL.exec(this.page.url())?.[1];
    if (!sessionId) throw new Error(`No Session id in ${this.page.url()}`);
    return decodeURIComponent(sessionId);
  }

  /** A Session the CLI accepted survives a hard kill: listed, openable, history intact. */
  async expectSessionListedWithHistory(sessionId: string): Promise<void> {
    const entry = this.page.locator(`[data-sidebar-session-id="${sessionId}"]`);
    await expect(entry).toBeVisible({ timeout: 60_000 });
    await entry.click();
    await expect(this.page.getByText(HOLD_PROMPT, { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(
      this.page.getByText('Synthetic long-running work started.', { exact: true })
    ).toBeVisible({ timeout: 60_000 });
  }

  /**
   * After a restart that interrupted a running Turn, the agent is relaunched and
   * continues on its own: no user action, the original request is not re-sent, and
   * the continuation is asked for exactly once, in a new agent process.
   */
  async expectInterruptedTurnContinuesWithoutUserAction(sessionId: string): Promise<void> {
    const entry = this.page.locator(`[data-sidebar-session-id="${sessionId}"]`);
    await expect(entry).toBeVisible({ timeout: 60_000 });
    await entry.click();
    await expect(
      this.page.getByText('Synthetic work resumed after restart.', { exact: true })
    ).toBeVisible({ timeout: 45_000 });
    await this.expectTurnSettled();
    const starts = this.fixture.journeyPromptStarts();
    expect(starts.map((start) => start.mode)).toEqual(['hold', 'continue']);
    expect(starts[1].pid, 'the continuation runs in a relaunched agent process').not.toBe(
      starts[0].pid
    );
  }

  private allowOnce(): Locator {
    return this.page.getByRole('button', { name: 'Allow once', exact: true });
  }

  private async expectTurnSettled(): Promise<void> {
    await expect(this.page.getByRole('button', { name: /^(Stop|停止)$/u })).toBeHidden({
      timeout: 60_000,
    });
    await this.expectComposerReady();
  }

  private async expectComposerReady(): Promise<void> {
    await expect(this.composer()).toBeEditable({ timeout: 30_000 });
  }

  private composer(): Locator {
    return this.page.locator('[data-keyboard-nav="composer"]');
  }

  private async send(prompt: string): Promise<void> {
    await this.composer().fill(prompt);
    await this.page.getByRole('button', { name: /^(Send|发送)$/u }).click();
  }
}
