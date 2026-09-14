import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const SCRIPTED_ACP_ENTRY = resolve(fixtureDirectory, 'agent-provider-lifecycle-scripted-acp.mjs');

type AgentProviderAcpEvent = {
  at: string;
  event: string;
  pid: number;
  prompt?: string;
  sessionId?: string;
  variant?: string;
};

type ProviderVariant = 'initial' | 'edited' | 'alternate';

function quoteCommandArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@\\-]+$/u.test(value)) return value;
  return `"${value.replace(/["\\$`]/gu, '\\$&')}"`;
}

export class AgentProviderLifecycleFixture {
  readonly initialProviderName = 'Synthetic custom command provider';
  readonly editedProviderName = 'Edited custom command provider';
  readonly alternateProviderName = 'Independent custom command provider';
  readonly rejectedProviderName = 'Rejected custom command provider';
  readonly initialCustomPrompt = 'Use the initial synthetic provider instructions.';
  readonly editedCustomPrompt = 'Use the edited synthetic provider instructions.';
  readonly alternateCustomPrompt = 'Use the independent synthetic provider instructions.';
  readonly cancelledProviderName = 'Cancelled custom command provider';
  readonly cancelledCustomPrompt = 'Do not persist this synthetic provider instruction.';
  readonly firstSessionPrompt = 'Complete the edited Agent Provider lifecycle request.';
  readonly secondSessionPrompt = 'Complete the independent Agent Provider lifecycle request.';
  readonly initialResponseText = 'Synthetic initial Agent Provider lifecycle complete.';
  readonly editedResponseText = 'Synthetic edited Agent Provider lifecycle complete.';
  readonly alternateResponseText = 'Synthetic alternate Agent Provider lifecycle complete.';
  readonly invalidAgentCommandLine = 'lody-agent-provider-command "unterminated';
  readonly initialAgentCommandLine: string;
  readonly editedAgentCommandLine: string;
  readonly alternateAgentCommandLine: string;

  constructor(readonly eventLogPath: string) {
    writeFileSync(eventLogPath, '', 'utf8');
    this.initialAgentCommandLine = this.commandLineFor('initial');
    this.editedAgentCommandLine = this.commandLineFor('edited');
    this.alternateAgentCommandLine = this.commandLineFor('alternate');
  }

  async expectIsolatedSessionPrompts(): Promise<void> {
    const edited = await this.waitForPrompt(
      'edited',
      this.firstSessionPrompt,
      this.editedCustomPrompt
    );
    const alternate = await this.waitForPrompt(
      'alternate',
      this.secondSessionPrompt,
      this.alternateCustomPrompt
    );
    expect(edited.sessionId).toBeTruthy();
    expect(alternate.sessionId).toBeTruthy();
    expect(edited.sessionId).not.toBe(alternate.sessionId);
    expect(
      this.readEvents().some(
        (event) =>
          event.event === 'prompt-end' &&
          event.variant === 'edited' &&
          event.prompt?.includes(this.secondSessionPrompt)
      )
    ).toBe(false);
    expect(
      this.readEvents().some(
        (event) =>
          event.event === 'prompt-end' &&
          event.variant === 'alternate' &&
          event.prompt?.includes(this.firstSessionPrompt)
      )
    ).toBe(false);
  }

  private async waitForPrompt(
    variant: ProviderVariant,
    sessionPrompt: string,
    customPrompt: string
  ): Promise<AgentProviderAcpEvent> {
    await expect
      .poll(
        () =>
          this.readEvents().find(
            (event) =>
              event.event === 'prompt-end' &&
              event.variant === variant &&
              event.prompt?.includes(sessionPrompt) &&
              event.prompt?.includes(customPrompt)
          ),
        { timeout: 30_000, intervals: [50, 100, 250, 500] }
      )
      .toBeDefined();
    const event = this.readEvents().find(
      (candidate) =>
        candidate.event === 'prompt-end' &&
        candidate.variant === variant &&
        candidate.prompt?.includes(sessionPrompt) &&
        candidate.prompt?.includes(customPrompt)
    );
    if (!event) throw new Error(`No ${variant} ACP prompt event was recorded`);
    return event;
  }

  private commandLineFor(variant: ProviderVariant): string {
    return [process.execPath, SCRIPTED_ACP_ENTRY, this.eventLogPath, variant]
      .map(quoteCommandArgument)
      .join(' ');
  }

  private readEvents(): AgentProviderAcpEvent[] {
    try {
      return readFileSync(this.eventLogPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as AgentProviderAcpEvent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}
