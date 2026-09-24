import { expect, type Locator, type Page } from '@playwright/test';
import { QueueSessionFixture } from '../fixtures/session-queue-fixture.js';

const HOLD_PROMPT = '[LODY-QUEUE-001:HOLD] Keep this turn running.';
const CANCELLED_PROMPT = '[LODY-QUEUE-001:CANCELLED] This queued message must not run.';
const RETAINED_PROMPT = '[LODY-QUEUE-001:RETAINED] This queued message must run next.';

export class QueueSessionPage {
  constructor(
    private readonly page: Page,
    private readonly fixture: QueueSessionFixture
  ) {}

  async configureCustomAgentAndQueueBehavior(): Promise<void> {
    const settings = await this.openSettings();
    const queueBehavior = settings.getByRole('radiogroup', {
      name: /^(Queued message behavior|排队消息行为)$/u,
    });
    await queueBehavior.getByRole('radio', { name: /^(Queue|排队)$/u }).click();
    await expect(queueBehavior.getByRole('radio', { name: /^(Queue|排队)$/u })).toHaveAttribute(
      'aria-checked',
      'true'
    );

    await settings.getByRole('button', { name: /^(Agents|Agent)$/u }).click();
    const addProvider = settings.getByRole('button', {
      name: /^(Add provider|添加 Provider)$/u,
    });
    await expect(addProvider.first()).toBeEnabled({ timeout: 60_000 });
    await addProvider.first().click();
    await this.page.getByRole('option', { name: /^(Custom command|自定义命令)$/u }).click();
    await this.page.locator('#agent-config-name').fill('Deterministic Queue E2E Agent');
    await this.page.locator('#custom-acp-command').fill(this.fixture.scriptedAgentCommandLine);
    await this.page.getByRole('button', { name: /^(Test command|测试命令)$/u }).click();
    await expect(this.page.getByText(/^(Ready|就绪)$/u).first()).toBeVisible({ timeout: 60_000 });
    await this.page.getByRole('button', { name: /^(Create|创建)$/u }).click();
    await expect(this.page.getByText('Deterministic Queue E2E Agent', { exact: true })).toBeVisible(
      {
        timeout: 30_000,
      }
    );
    await this.page.keyboard.press('Escape');
    await expect(settings).toBeHidden();
    await expect(this.page.locator('#chat-prompt')).toBeEditable({ timeout: 30_000 });
  }

  async startHeldSession(): Promise<void> {
    await this.send(HOLD_PROMPT);
    await expect(this.page).toHaveURL(/#\/local\/sessions\/[^/?#]+(?:\?.*)?$/u, {
      timeout: 60_000,
    });
    await expect(this.page.getByText('Synthetic queue hold started.', { exact: true })).toBeVisible(
      {
        timeout: 60_000,
      }
    );
    await expect(this.page.getByRole('button', { name: /^(Stop|停止)$/u })).toBeVisible();
    await this.fixture.waitForPromptEvent('prompt-start', 'hold');
  }

  async queueFollowUpMessages(): Promise<void> {
    await this.send(CANCELLED_PROMPT);
    await expect(this.queueItem(CANCELLED_PROMPT)).toBeVisible({
      timeout: 30_000,
    });
    await this.send(RETAINED_PROMPT);
    await expect(this.queueItem(RETAINED_PROMPT)).toBeVisible({
      timeout: 30_000,
    });
  }

  async removeFirstFollowUpMessage(): Promise<void> {
    await expect(this.queueItem(CANCELLED_PROMPT)).toBeVisible();
    await expect(this.queueItem(RETAINED_PROMPT)).toBeVisible();
    await this.queueItem(CANCELLED_PROMPT)
      .getByRole('button', { name: /^(Remove from queue|从队列移除)$/u })
      .click();
    await expect(this.page.getByText(CANCELLED_PROMPT, { exact: true })).toBeHidden({
      timeout: 30_000,
    });
    await expect(this.queueItem(RETAINED_PROMPT)).toBeVisible();
  }

  async completeAndVerifyOnlyRetainedMessageRuns(): Promise<void> {
    this.fixture.releaseHeldPrompt();
    const heldEnd = await this.fixture.waitForPromptEvent('prompt-end', 'hold');
    expect(heldEnd.stopReason).toBe('end_turn');
    const retainedEnd = await this.fixture.waitForPromptEvent('prompt-end', 'retained');
    expect(retainedEnd.stopReason).toBe('end_turn');
    await expect(
      this.page.getByText('Synthetic retained queue message complete.', { exact: true })
    ).toBeVisible({ timeout: 30_000 });
    await expect(this.page.getByText(/^(Up next|下一步)/u)).toBeHidden({ timeout: 30_000 });

    expect(this.fixture.journeyPromptStartModes()).toEqual(['hold', 'retained']);
  }

  private async send(prompt: string): Promise<void> {
    await this.page.locator('[data-keyboard-nav="composer"]').fill(prompt);
    await this.page.getByRole('button', { name: /^(Send|发送)$/u }).click();
  }

  private queueItem(prompt: string): Locator {
    return this.page.getByText(prompt, { exact: true }).locator('../..');
  }

  private async openSettings(): Promise<Locator> {
    await this.page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = this.page.getByRole('dialog').filter({
      has: this.page.getByRole('navigation', { name: /^(Settings|设置)$/u }),
    });
    await expect(settings).toBeVisible();
    return settings;
  }
}
