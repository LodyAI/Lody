import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { quoteCommandArgument } from './command-line.js';

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const SCRIPTED_ACP_ENTRY = resolve(fixtureDirectory, 'turn-lifecycle-scripted-acp.mjs');

export type TurnPromptMode =
  | 'permission'
  | 'crash'
  | 'recover'
  | 'before'
  | 'after'
  | 'hold'
  | 'continue';
const JOURNEY_MODES: ReadonlySet<string> = new Set([
  'permission',
  'crash',
  'recover',
  'before',
  'after',
  'hold',
  'continue',
]);

export type TurnAcpEvent = {
  at: string;
  event: string;
  mode?: string;
  outcome?: string;
  pid: number;
  sessionId?: string;
  stopReason?: string;
};

export class TurnLifecycleFixture {
  readonly scriptedAgentCommandLine: string;

  constructor(readonly acpEventLogPath: string) {
    writeFileSync(acpEventLogPath, '', 'utf8');
    this.scriptedAgentCommandLine = [process.execPath, SCRIPTED_ACP_ENTRY, acpEventLogPath]
      .map(quoteCommandArgument)
      .join(' ');
  }

  readAcpEvents(): TurnAcpEvent[] {
    try {
      return readFileSync(this.acpEventLogPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as TurnAcpEvent];
          } catch {
            return [];
          }
        });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async waitForEvent(predicate: (event: TurnAcpEvent) => boolean): Promise<TurnAcpEvent> {
    await expect
      .poll(() => this.readAcpEvents().find(predicate), {
        timeout: 30_000,
        intervals: [50, 100, 250, 500],
      })
      .toBeDefined();
    return this.readAcpEvents().find(predicate)!;
  }

  /** Journey prompts in the order the provider received them, with their process. */
  journeyPromptStarts(): Array<{ mode: TurnPromptMode; pid: number }> {
    return this.readAcpEvents()
      .filter((entry) => entry.event === 'prompt-start' && JOURNEY_MODES.has(entry.mode ?? ''))
      .map((entry) => ({ mode: entry.mode as TurnPromptMode, pid: entry.pid }));
  }

  permissionOutcomes(): string[] {
    return this.readAcpEvents()
      .filter((entry) => entry.event === 'permission-outcome')
      .map((entry) => entry.outcome ?? '');
  }
}
