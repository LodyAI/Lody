import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const SCRIPTED_ACP_ENTRY = resolve(fixtureDirectory, 'session-queue-scripted-acp.mjs');

export type QueuePromptMode = 'hold' | 'cancelled' | 'retained';

export type QueueAcpEvent = {
  at: string;
  event: string;
  mode?: QueuePromptMode | 'title' | 'other';
  pid: number;
  sessionId?: string;
  stopReason?: string;
};

function quoteCommandArgument(value: string): string {
  if (/^[A-Za-z0-9_./:\\-]+$/u.test(value)) return value;
  return `"${value.replace(/["\\$`]/gu, '\\$&')}"`;
}

export class QueueSessionFixture {
  readonly scriptedAgentCommandLine: string;

  constructor(
    readonly acpEventLogPath: string,
    readonly releaseSignalPath: string
  ) {
    writeFileSync(acpEventLogPath, '', 'utf8');
    rmSync(releaseSignalPath, { force: true });
    this.scriptedAgentCommandLine = [
      process.execPath,
      SCRIPTED_ACP_ENTRY,
      acpEventLogPath,
      releaseSignalPath,
    ]
      .map(quoteCommandArgument)
      .join(' ');
  }

  readAcpEvents(): QueueAcpEvent[] {
    try {
      return readFileSync(this.acpEventLogPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as QueueAcpEvent];
          } catch {
            return [];
          }
        });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async waitForPromptEvent(event: 'prompt-start' | 'prompt-end', mode: QueuePromptMode) {
    await expect
      .poll(
        () => this.readAcpEvents().find((entry) => entry.event === event && entry.mode === mode),
        { timeout: 30_000, intervals: [50, 100, 250, 500] }
      )
      .toBeDefined();
    return this.readAcpEvents().find((entry) => entry.event === event && entry.mode === mode)!;
  }

  journeyPromptStartModes(): QueuePromptMode[] {
    return this.readAcpEvents()
      .filter(
        (entry): entry is QueueAcpEvent & { mode: QueuePromptMode } =>
          entry.event === 'prompt-start' &&
          (entry.mode === 'hold' || entry.mode === 'cancelled' || entry.mode === 'retained')
      )
      .map((entry) => entry.mode);
  }

  releaseHeldPrompt(): void {
    writeFileSync(this.releaseSignalPath, 'release\n', { flag: 'wx' });
  }
}
