import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const SCRIPTED_ACP_ENTRY = resolve(fixtureDirectory, 'session-goal-scripted-acp.mjs');

export const GOAL_START_PROMPT =
  '[LODY-GOAL-001:START] Keep working toward the synthetic release objective.';
export const GOAL_UPDATE_PROMPT =
  '[LODY-GOAL-001:UPDATE] Replace the objective with the verified release handoff.';
export const GOAL_OBJECTIVE = 'Publish the synthetic release checklist without user intervention.';
export const UPDATED_GOAL_OBJECTIVE =
  'Verify the synthetic release handoff and publish its evidence.';
export const INDEPENDENT_SESSION_PROMPT =
  '[LODY-GOAL-001:SECONDARY] Complete independent release-note formatting.';

export type GoalAcpEvent = {
  at: string;
  event:
    | 'process-start'
    | 'initialize'
    | 'session-new'
    | 'prompt-start'
    | 'prompt-end'
    | 'goal-snapshot'
    | 'goal-control'
    | 'session-close';
  pid: number;
  sessionId?: string;
  mode?: 'title' | 'initial-goal' | 'resume-goal' | 'update-goal' | 'other';
  action?: 'pause' | 'clear';
  goalCapability?: {
    version: number;
    actions: string[];
    controlActions: string[];
    promptActions: string[];
  };
  goalControl?: { version?: number; action?: string };
  goalStatus?: 'active' | 'paused' | null;
  objective?: string | null;
  tokenBudget?: number | null;
  tokensUsed?: number | null;
  timeUsedSeconds?: number | null;
  promptText?: string;
  stopReason?: string;
};

function quoteCommandArgument(value: string): string {
  if (/^[A-Za-z0-9_./:\\-]+$/u.test(value)) return value;
  return `"${value.replace(/["\\$`]/gu, '\\$&')}"`;
}

export class GoalSessionFixture {
  readonly agentCommandLine: string;

  constructor(readonly eventLogPath: string) {
    writeFileSync(eventLogPath, '', 'utf8');
    this.agentCommandLine = [process.execPath, SCRIPTED_ACP_ENTRY, eventLogPath]
      .map(quoteCommandArgument)
      .join(' ');
  }

  readEvents(): GoalAcpEvent[] {
    try {
      return readFileSync(this.eventLogPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as GoalAcpEvent];
          } catch {
            return [];
          }
        });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async waitForInitialGoalPrompt(): Promise<GoalAcpEvent> {
    return await this.waitForEvent(
      (event) => event.event === 'prompt-start' && event.mode === 'initial-goal'
    );
  }

  async waitForIndependentSessionPrompt(): Promise<GoalAcpEvent> {
    return await this.waitForEvent(
      (event) =>
        event.event === 'prompt-start' &&
        event.mode === 'other' &&
        event.promptText?.includes(INDEPENDENT_SESSION_PROMPT) === true
    );
  }

  async expectGoalCapability(): Promise<void> {
    const goalCapability = {
      version: 1,
      actions: ['set', 'pause', 'resume', 'clear'],
      controlActions: ['pause', 'clear'],
      promptActions: ['set', 'pause', 'resume', 'clear'],
    };
    await expect
      .poll(
        () =>
          this.readEvents().find(
            (event) => event.event === 'initialize' && event.goalCapability !== undefined
          )?.goalCapability,
        { timeout: 30_000, intervals: [50, 100, 250, 500] }
      )
      .toEqual(goalCapability);
  }

  async waitForControl(action: 'pause' | 'clear'): Promise<GoalAcpEvent> {
    return await this.waitForEvent(
      (event) => event.event === 'goal-control' && event.action === action
    );
  }

  async waitForResumePrompt(): Promise<GoalAcpEvent> {
    return await this.waitForEvent(
      (event) =>
        event.event === 'prompt-start' &&
        event.mode === 'resume-goal' &&
        event.goalControl?.version === 1 &&
        event.goalControl.action === 'resume'
    );
  }

  async waitForGoalUpdatePrompt(): Promise<GoalAcpEvent> {
    return await this.waitForEvent(
      (event) =>
        event.event === 'prompt-start' &&
        event.mode === 'update-goal' &&
        event.promptText?.includes(GOAL_UPDATE_PROMPT) === true
    );
  }

  async waitForGoalSnapshot(
    sessionId: string,
    goalStatus: GoalAcpEvent['goalStatus'],
    objective?: string
  ): Promise<GoalAcpEvent> {
    return await this.waitForEvent(
      (event) =>
        event.event === 'goal-snapshot' &&
        event.sessionId === sessionId &&
        event.goalStatus === goalStatus &&
        (objective === undefined || event.objective === objective)
    );
  }

  controlEvents(sessionId: string, action: 'pause' | 'clear'): GoalAcpEvent[] {
    return this.readEvents().filter(
      (event) =>
        event.event === 'goal-control' && event.sessionId === sessionId && event.action === action
    );
  }

  async waitForEvent(predicate: (event: GoalAcpEvent) => boolean): Promise<GoalAcpEvent> {
    await expect
      .poll(() => this.readEvents().find(predicate), {
        timeout: 30_000,
        intervals: [50, 100, 250, 500],
      })
      .toBeDefined();
    return this.readEvents().find(predicate)!;
  }
}
