import { requireSessionAccepted } from '@lody/shared/session-data';
import { v4 as uuidv4 } from 'uuid';
import {
  getServerNow,
  type MessageContent,
  type SessionHistoryInput,
  type SessionId,
  type TerminalExitStatus,
  type WorktreeScriptPhase,
} from '@lody/shared';
import type { SessionDocument } from '@/lib/loro/doc';
import type { Logger } from '@/utils/logger';
import type {
  WorktreeScriptEndEvent,
  WorktreeScriptEvents,
  WorktreeScriptStartEvent,
  WorktreeScriptStepEndEvent,
  WorktreeScriptStepStartEvent,
} from './worktree-setup-runner';

const WORKTREE_SCRIPT_HISTORY_OUTPUT_MAX_CHARS = 128_000;
const WORKTREE_SCRIPT_HISTORY_FLUSH_INTERVAL_MS = 250;

type WorktreeScriptHistoryStep = {
  command: string;
  status: 'in_progress' | 'completed' | 'failed';
  output: string;
  truncated?: boolean;
  exitStatus?: TerminalExitStatus;
  startedAt?: number;
  endedAt?: number;
};

class WorktreeScriptHistoryRecorder implements WorktreeScriptEvents {
  private readonly historyId: string;
  private readonly startedAt: number;
  private readonly steps: WorktreeScriptHistoryStep[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly args: {
      sessionDoc: SessionDocument;
      sessionId: SessionId;
      phase: WorktreeScriptPhase;
      logger: Logger;
      insertBeforeEntryId?: string;
    }
  ) {
    this.historyId = `worktree-script-${args.phase}-${uuidv4()}`;
    this.startedAt = getServerNow();
  }

  async onStart(_event: WorktreeScriptStartEvent): Promise<void> {
    await this.enqueueWrite({ status: 'in_progress' });
  }

  async onStepStart(event: WorktreeScriptStepStartEvent): Promise<void> {
    this.steps[event.stepIndex] = {
      command: event.displayCommand,
      status: 'in_progress',
      output: '',
      startedAt: getServerNow(),
    };
    await this.enqueueWrite({ status: 'in_progress' });
  }

  onOutput({ stepIndex, chunk }: { stepIndex: number; chunk: string }): void {
    const step = this.steps[stepIndex];
    if (!step) {
      throw new Error(`Unknown worktree script step: ${stepIndex}`);
    }
    const next = step.output + chunk;
    if (next.length > WORKTREE_SCRIPT_HISTORY_OUTPUT_MAX_CHARS) {
      step.output = next.slice(next.length - WORKTREE_SCRIPT_HISTORY_OUTPUT_MAX_CHARS);
      step.truncated = true;
    } else {
      step.output = next;
    }
    this.scheduleFlush();
  }

  async onStepEnd(event: WorktreeScriptStepEndEvent): Promise<void> {
    const step = this.steps[event.stepIndex];
    if (!step) {
      throw new Error(`Unknown worktree script step: ${event.stepIndex}`);
    }
    step.status = event.status === 'completed' ? 'completed' : 'failed';
    step.exitStatus = event.exitStatus;
    step.endedAt = getServerNow();
    await this.enqueueWrite({ status: 'in_progress' });
  }

  async onEnd(event: WorktreeScriptEndEvent): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.writes;
    await this.enqueueWrite({
      status: event.status === 'completed' ? 'completed' : 'failed',
      finished: true,
    });
    await this.args.sessionDoc.waitUntilSynced();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.enqueueWrite({ status: 'in_progress' }).catch((error: unknown) => {
        this.args.logger.warn(
          `[${this.args.sessionId}] Failed to record worktree ${this.args.phase} output: ${formatUnknownError(
            error
          )}`
        );
      });
    }, WORKTREE_SCRIPT_HISTORY_FLUSH_INTERVAL_MS);
  }

  private enqueueWrite(options: {
    status: 'in_progress' | 'completed' | 'failed';
    finished?: boolean;
  }): Promise<void> {
    const write = this.writes.then(() => this.write(options));
    this.writes = write.catch(() => {});
    return write;
  }

  private async write(options: {
    status: 'in_progress' | 'completed' | 'failed';
    finished?: boolean;
  }): Promise<void> {
    const entry = this.buildEntry(options);
    await this.args.sessionDoc.sessionData.commands
      .applyHistoryAction({
        kind: 'upsert-turn',
        turn: entry,
        beforeTurnId: this.args.insertBeforeEntryId,
      })
      .then(requireSessionAccepted);
  }

  private buildEntry(options: {
    status: 'in_progress' | 'completed' | 'failed';
    finished?: boolean;
  }): SessionHistoryInput {
    const endedAt = options.finished ? getServerNow() : undefined;
    const items: MessageContent[] = [
      {
        type: 'worktree_script',
        phase: this.args.phase,
        status: options.status,
        steps: this.steps.map((step) => ({ ...step })),
        startedAt: this.startedAt,
        endedAt,
      },
    ];

    return {
      id: this.historyId,
      role: 'system',
      items: items as SessionHistoryInput['items'],
      timestamp: new Date(this.startedAt).toISOString(),
      startedAt: this.startedAt,
      endedAt,
      finished: options.finished,
      userId: undefined,
      read: undefined,
      fileDiff: [],
    };
  }
}

export function createWorktreeScriptHistoryRecorder(args: {
  sessionDoc: SessionDocument;
  sessionId: SessionId;
  phase: WorktreeScriptPhase;
  logger: Logger;
  insertBeforeEntryId?: string;
}): WorktreeScriptEvents {
  return new WorktreeScriptHistoryRecorder(args);
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
