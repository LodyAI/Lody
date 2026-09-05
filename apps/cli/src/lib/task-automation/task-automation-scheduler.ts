import {
  getTaskIndexFlockDocId,
  getTaskIndexScanPrefix,
  listVisibleTaskIndexRows,
  readTaskIndexRows,
  type AgentConfigMeta,
  type MachineId,
  type TaskId,
  type TaskIndexRow,
  type TaskIndexScanRow,
  type WorkspaceId,
} from '@lody/shared';
import type { Logger } from '@/utils/logger';
import type { AgentExecutionSlots } from '../agent-execution-slots';
import {
  collectTaskAutomationBaseline,
  planTaskAutomation,
  type TaskAutomationCandidate,
} from './task-automation-plan';

export type TaskAutomationSchedulerDeps = {
  workspaceId: WorkspaceId;
  machineId: MachineId;
  /** Authenticated user of this machine; only their tasks may auto-run. */
  operatorUserId: string;
  logger: Logger;
  /** Reads the workspace task index rows. */
  readTaskIndex: () => Promise<TaskIndexRow[]>;
  /** Agent configs that live on this machine. */
  listOwnedAgentConfigs: () => Promise<AgentConfigMeta[]>;
  /** Whether this machine can execute right now. */
  isMachineOnline: () => boolean;
  /** Starts the task; resolves once the dispatch is durable. */
  startTask: (taskId: TaskId, agentConfigId: string) => Promise<void>;
  /** Called when a task is eligible but has to wait its turn or for the agent. */
  onQueued?: (taskId: TaskId, position: number) => void;
  executionSlots?: AgentExecutionSlots;
};

const toCandidate = (row: TaskIndexRow): TaskAutomationCandidate => ({
  taskId: row.taskId,
  order: row.order,
  ownerId: row.ownerId,
  ...(row.agentConfigId ? { agentConfigId: row.agentConfigId } : {}),
  status: row.status,
  ready: row.ready !== false,
});

/**
 * Machine-side scheduler for tasks entrusted to an agent that lives here.
 *
 * The point of running this on the machine rather than in the app is that the
 * work continues when nobody is looking: a task assigned while the laptop was
 * closed starts when it opens, and the queue keeps draining after the user walks
 * away.
 *
 * Policy lives entirely in `planTaskAutomation`; this class only supplies facts,
 * enforces one-start-at-a-time, and performs the starts.
 */
export class TaskAutomationScheduler {
  private readonly deps: TaskAutomationSchedulerDeps;
  private baseline: Set<string> | null = null;
  private readonly started = new Set<string>();
  private readonly inFlightByAgentConfigId = new Map<string, string>();
  private running = false;
  private rerunRequested = false;
  private stopped = false;

  constructor(deps: TaskAutomationSchedulerDeps) {
    this.deps = deps;
  }

  stop(): void {
    this.stopped = true;
  }

  /**
   * Re-evaluates the queue. Safe to call on every task-index change: passes are
   * coalesced, so a burst of assignments produces one evaluation, not one per row.
   */
  async evaluate(): Promise<void> {
    if (this.stopped) {
      return;
    }
    if (this.running) {
      this.rerunRequested = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.rerunRequested = false;
        await this.runPass();
      } while (this.rerunRequested && !this.stopped);
    } finally {
      this.running = false;
    }
  }

  private async runPass(): Promise<void> {
    const rows = await this.deps.readTaskIndex();
    this.deps.executionSlots?.replaceTaskOccupancy(rows, this.deps.operatorUserId);
    const candidates = rows.map(toCandidate);
    const ownedAgents = await this.deps.listOwnedAgentConfigs();
    const ownedAgentConfigIds = new Set(
      ownedAgents
        .filter((config) => config.machineId === this.deps.machineId)
        .map((config) => config.id as string)
    );

    if (this.baseline === null) {
      // First pass only records what was already waiting. Starting it here would
      // mean every daemon restart replays the whole backlog.
      this.baseline = collectTaskAutomationBaseline(candidates, {
        ownedAgentConfigIds,
        operatorUserId: this.deps.operatorUserId,
      });
      if (this.baseline.size > 0) {
        this.deps.logger.debug(
          `[task-automation] baseline recorded count=${this.baseline.size} (not started)`
        );
      }
      return;
    }

    // A task that left eligibility is no longer "pre-existing": if it comes back,
    // that is a fresh observed transition and may run.
    const stillEligible = new Set(
      candidates
        .filter(
          (entry) =>
            (entry.status === 'backlog' || entry.status === 'todo') &&
            entry.ready &&
            entry.agentConfigId
        )
        .map((entry) => entry.taskId)
    );
    for (const taskId of [...this.baseline]) {
      if (!stillEligible.has(taskId)) {
        this.baseline.delete(taskId);
      }
    }

    // The machine being offline is the same wait as the agent being unreachable.
    const onlineAgentConfigIds = this.deps.isMachineOnline()
      ? ownedAgentConfigIds
      : new Set<string>();

    const plan = planTaskAutomation({
      candidates,
      ownedAgentConfigIds,
      onlineAgentConfigIds,
      operatorUserId: this.deps.operatorUserId,
      inFlightByAgentConfigId: this.inFlightByAgentConfigId,
      baselineTaskIds: this.baseline,
      startedTaskIds: this.started,
    });

    for (const queued of plan.queued) {
      this.deps.onQueued?.(queued.taskId as TaskId, queued.position);
    }

    for (const start of plan.start) {
      if (this.inFlightByAgentConfigId.has(start.agentConfigId)) {
        // Another start in this same pass already claimed the agent's slot.
        continue;
      }
      const slotOwner = `task:${start.taskId}`;
      if (
        this.deps.executionSlots &&
        !this.deps.executionSlots.reserve(start.agentConfigId, slotOwner)
      )
        continue;
      this.inFlightByAgentConfigId.set(start.agentConfigId, start.taskId);
      this.started.add(start.taskId);
      try {
        this.deps.logger.debug(
          `[task-automation] starting taskId=${start.taskId} agentConfigId=${start.agentConfigId}`
        );
        await this.deps.startTask(start.taskId as TaskId, start.agentConfigId);
      } catch (error) {
        // Let it be retried: drop the started marker so a later pass can pick it
        // up, but keep the agent's slot released so the queue is not wedged.
        this.started.delete(start.taskId);
        this.deps.logger.warn(
          `[task-automation] failed to start taskId=${start.taskId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      } finally {
        // Refresh the durable in_progress policy before relinquishing the
        // transient reservation, otherwise Schedule could slip into the gap.
        if (this.deps.executionSlots) {
          this.deps.executionSlots.replaceTaskOccupancy(
            await this.deps.readTaskIndex(),
            this.deps.operatorUserId
          );
          this.deps.executionSlots.release(start.agentConfigId, slotOwner);
        }
        this.inFlightByAgentConfigId.delete(start.agentConfigId);
      }
    }
  }
}

/** Minimal repo surface needed to read the workspace task index. */
export type TaskIndexReadableRepo = {
  openFlockDoc: (flockDocId: string) => Promise<{
    flock: { scan(options?: { prefix?: string[] }): Iterable<TaskIndexScanRow> };
  }>;
};

/** Reads the workspace task index rows from a Flock handle. */
export const readTaskIndexRowsForWorkspace = async (
  repo: TaskIndexReadableRepo,
  workspaceId: WorkspaceId
): Promise<TaskIndexRow[]> => {
  const handle = await repo.openFlockDoc(getTaskIndexFlockDocId(workspaceId));
  // `scan` must stay a method call: the Flock implementation reads `this`, so a
  // detached reference throws `Cannot read properties of undefined`.
  return listVisibleTaskIndexRows(
    readTaskIndexRows(handle.flock.scan({ prefix: getTaskIndexScanPrefix() }))
  );
};
