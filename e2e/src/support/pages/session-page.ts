import { expect, type Page } from '@playwright/test';
import { type ScriptedAcpEvent, WorkSessionFixture } from '../fixtures/work-session-fixture.js';

const PROVIDER_NAME = 'Deterministic E2E Agent';
const HELD_RESPONSE = 'Synthetic response started.';

export class SessionPage {
  constructor(
    private readonly page: Page,
    private readonly fixture: WorkSessionFixture
  ) {}

  async configureCustomAgentFromSettings(): Promise<void> {
    await this.page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = this.page.getByRole('dialog').filter({
      has: this.page.getByRole('navigation', { name: /^(Settings|设置)$/u }),
    });
    await expect(settings).toBeVisible();
    await settings.getByRole('button', { name: 'Agents', exact: true }).click();

    const addProvider = this.page.getByRole('button', {
      name: /^(Add provider|添加 Provider)$/u,
    });
    await expect(addProvider.first()).toBeEnabled({ timeout: 60_000 });
    await addProvider.first().click();
    await this.page.getByRole('option', { name: /^(Custom command|自定义命令)$/u }).click();
    await this.page.locator('#agent-config-name').fill(PROVIDER_NAME);
    await this.page.locator('#custom-acp-command').fill(this.fixture.scriptedAgentCommandLine);
    await this.page.getByRole('button', { name: /^(Test command|测试命令)$/u }).click();
    await expect(this.page.getByText(/^(Ready|就绪)$/u).first()).toBeVisible({ timeout: 60_000 });
    await this.page.getByRole('button', { name: /^(Create|创建)$/u }).click();
    await expect(this.page.getByText(PROVIDER_NAME, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await this.page.keyboard.press('Escape');
    await expect(settings).toBeHidden();
    await expect(this.page.locator('#chat-prompt')).toBeEditable({ timeout: 60_000 });
  }

  async createHeldSession(
    prompt = 'Exercise deterministic lifecycle [SCOUT:HOLD]'
  ): Promise<ScriptedAcpEvent> {
    await this.page.locator('#chat-prompt').fill(prompt);
    await this.page.getByRole('button', { name: /^(Send|发送)$/u }).click();
    await expect(this.page).toHaveURL(/#\/local\/sessions\/[^/?#]+(?:\?.*)?$/u, {
      timeout: 60_000,
    });
    await expect(this.page.getByText(HELD_RESPONSE, { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(this.page.getByRole('button', { name: /^(Stop|停止)$/u })).toBeVisible();

    const promptEvents = await this.fixture.waitForAcpEvent('prompt-start');
    const waiting = [...promptEvents].reverse().find((event) => event.mode === 'hold');
    expect(waiting, 'The scripted ACP did not observe the held prompt').toBeDefined();
    expect(waiting?.sessionId).toEqual(expect.any(String));
    return waiting!;
  }

  async createCompletedSession(
    prompt = 'Exercise deterministic reply [SCOUT:REPLY]'
  ): Promise<ScriptedAcpEvent> {
    const priorCount = this.fixture
      .readAcpEvents()
      .filter((event) => event.event === 'prompt-end').length;
    await this.page.locator('#chat-prompt').fill(prompt);
    await this.page.getByRole('button', { name: /^(Send|发送)$/u }).click();
    await expect(this.page).toHaveURL(/#\/local\/sessions\/[^/?#]+(?:\?.*)?$/u, {
      timeout: 60_000,
    });
    await expect(this.page.getByText(/Synthetic (?:response|diff revision)/u).first()).toBeVisible({
      timeout: 60_000,
    });
    const completed = await this.fixture.waitForAcpEvent('prompt-end', priorCount + 1);
    return completed.at(-1)!;
  }

  async stopHeldSession(waiting: ScriptedAcpEvent): Promise<void> {
    await this.page.getByRole('button', { name: /^(Stop|停止)$/u }).click();
    await this.waitForSessionEvent('session-cancel', waiting);
    const completed = await this.waitForSessionEvent('prompt-end', waiting);
    expect(completed.stopReason).toBe('cancelled');
    await expect(this.page.getByRole('button', { name: /^(Stop|停止)$/u })).toBeHidden({
      timeout: 30_000,
    });
  }

  async archiveSessionAndWaitForRuntimeExit(waiting: ScriptedAcpEvent): Promise<void> {
    await this.page
      .getByRole('button', { name: /^(More actions|更多操作)$/u })
      .last()
      .click();
    await this.page.getByRole('menuitem', { name: /^(Archive session|归档会话)$/u }).click();
    await expect(this.page).toHaveURL(/#\/local\/chat(?:\?.*)?$/u, { timeout: 30_000 });
    await this.fixture.expectAgentProcessesExited([waiting.pid]);
  }

  async archiveAndDeleteSession(waiting: ScriptedAcpEvent): Promise<void> {
    const match = /#\/local\/sessions\/([^?]+)/u.exec(this.page.url());
    if (!match?.[1]) throw new Error(`Expected a Session route, received ${this.page.url()}`);
    const sessionId = decodeURIComponent(match[1]);
    await this.archiveSessionAndWaitForRuntimeExit(waiting);
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
    await expect(this.page.locator('#chat-prompt')).toBeEditable({ timeout: 30_000 });
  }

  private async waitForSessionEvent(
    event: string,
    prompt: ScriptedAcpEvent
  ): Promise<ScriptedAcpEvent> {
    let match: ScriptedAcpEvent | undefined;
    await expect
      .poll(
        () => {
          match = this.fixture
            .readAcpEvents()
            .find(
              (entry) =>
                entry.event === event &&
                entry.pid === prompt.pid &&
                entry.sessionId === prompt.sessionId
            );
          return match !== undefined;
        },
        { timeout: 30_000, intervals: [50, 100, 250, 500] }
      )
      .toBe(true);
    return match!;
  }
}

export { PROVIDER_NAME as SCRIPTED_AGENT_NAME };
