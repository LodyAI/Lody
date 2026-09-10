import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const SCRIPTED_ACP_ENTRY = resolve(fixtureDirectory, 'agent-role-scripted-acp.mjs');

export type AgentRoleAcpEvent = {
  at: string;
  pid: number;
  event: string;
  sessionId?: string;
  prompt?: string;
  stopReason?: string;
};

function quoteCommandArgument(value: string): string {
  if (/^[A-Za-z0-9_./:\\-]+$/u.test(value)) return value;
  return `"${value.replace(/["\\$`]/gu, '\\$&')}"`;
}

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

export class AgentRoleFixture {
  readonly roleName = 'Deterministic Release Reviewer';
  readonly editedRoleName = 'Edited Release Reviewer';
  readonly initialInstruction = 'Use the accepted release-review contract.';
  readonly editedInstruction = 'This later instruction must not reach the accepted Session.';
  readonly taskPrompt = 'Review the synthetic release candidate.';
  readonly responseText = 'Synthetic role-bound review complete.';
  readonly agentName = 'Deterministic Agent Role E2E Agent';
  readonly agentCommandLine: string;

  constructor(
    readonly eventLogPath: string,
    readonly releaseSignalPath: string
  ) {
    writeFileSync(eventLogPath, '', 'utf8');
    rmSync(releaseSignalPath, { force: true });
    this.agentCommandLine = [process.execPath, SCRIPTED_ACP_ENTRY, eventLogPath, releaseSignalPath]
      .map(quoteCommandArgument)
      .join(' ');
  }

  readEvents(): AgentRoleAcpEvent[] {
    try {
      return readFileSync(this.eventLogPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as AgentRoleAcpEvent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async waitForEvent(
    event: string,
    matches: (entry: AgentRoleAcpEvent) => boolean = () => true
  ): Promise<AgentRoleAcpEvent> {
    await expect
      .poll(() => this.readEvents().find((entry) => entry.event === event && matches(entry)), {
        timeout: 30_000,
        intervals: [50, 100, 250, 500],
      })
      .toBeDefined();
    return this.readEvents().find((entry) => entry.event === event && matches(entry))!;
  }

  releasePrompt(): void {
    writeFileSync(this.releaseSignalPath, 'release\n', { flag: 'wx' });
  }

  async expectAgentExited(pid: number): Promise<void> {
    await expect.poll(() => isProcessAlive(pid), { timeout: 30_000 }).toBe(false);
  }
}
