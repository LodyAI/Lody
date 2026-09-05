import {
  isReviewRunTerminal,
  type MachineId,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';
import type { LoroRepo } from 'loro-repo';
import type { Logger } from '@/utils/logger';
import { listReviewRuns } from './review-automation-store';

export type ReviewAutomationSchedulerDeps = {
  repo: LoroRepo;
  workspaceId: WorkspaceId;
  machineId: MachineId;
  logger: Logger;
  /** Only sessions this machine owns may be driven. */
  ownsSession: (sessionId: SessionId) => Promise<boolean>;
  step: (sessionId: SessionId) => Promise<void>;
  /** Durably counts a failed step and blocks the run once it keeps failing. */
  recordFailure: (sessionId: SessionId, message: string) => Promise<void>;
  isMachineOnline: () => boolean;
  /**
   * Concurrent runs on one machine. Small on purpose: each active run drives an
   * agent turn in a working copy, and several at once mostly means they all get
   * slower.
   */
  maxConcurrentRuns?: number;
};

const DEFAULT_MAX_CONCURRENT_RUNS = 2;

/**
 * Drives every active review run this machine owns.
 *
 * Unlike `TaskAutomationScheduler`, the first pass after a restart deliberately
 * DOES act. That scheduler records a baseline so a daemon restart cannot replay
 * a backlog of tasks nobody explicitly started; here every run exists because a
 * person ticked a box on that specific session, and a run that silently stopped
 * surviving restarts would be worse than one that resumes — the user is told it
 * is watching the branch.
 */
export class ReviewAutomationScheduler {
  private running = false;
  private rerunRequested = false;
  private stopped = false;
  private rotation = 0;
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: ReviewAutomationSchedulerDeps) {}

  stop(): void {
    this.stopped = true;
  }

  /** Coalesced: a burst of document changes produces one pass, not one per change. */
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
    if (!this.deps.isMachineOnline()) {
      // Merging and CI reads both need the network. Holding the pass keeps the
      // run where it is instead of failing it.
      return;
    }

    const runs = await listReviewRuns(this.deps.repo, this.deps.workspaceId);
    const active = runs.filter((run) => !isReviewRunTerminal(run.state) && run.state !== 'paused');
    if (active.length === 0) {
      return;
    }

    const limit = this.deps.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS;
    let started = 0;

    // Steps are sequential, so the cap truncates the pass rather than bounding
    // real concurrency. Always starting from index 0 therefore starved every run
    // past the cap forever — a run parked waiting for confirmation would hold a
    // slot indefinitely. Rotating the start point gives each run its turn.
    const ordered =
      active.length > limit
        ? [
            ...active.slice(this.rotation % active.length),
            ...active.slice(0, this.rotation % active.length),
          ]
        : active;
    this.rotation = (this.rotation + limit) % Math.max(1, active.length);

    for (const run of ordered) {
      if (this.stopped) {
        return;
      }
      if (this.inFlight.has(run.sessionId)) {
        continue;
      }
      if (started >= limit) {
        this.deps.logger.debug(
          `[review-automation] queued sessionId=${run.sessionId} (pass limit ${limit})`
        );
        continue;
      }
      if (!(await this.deps.ownsSession(run.sessionId).catch(() => false))) {
        continue;
      }

      started += 1;
      this.inFlight.add(run.sessionId);
      try {
        await this.deps.step(run.sessionId);
      } catch (error) {
        this.deps.logger.warn(
          `[review-automation] step failed sessionId=${run.sessionId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        // A throwing step leaves durable state untouched, so the identical
        // action would be retried on every document change — a hot loop that can
        // repeatedly attempt session creation. Count the failures durably and
        // stop after a few.
        await this.deps
          .recordFailure(run.sessionId, error instanceof Error ? error.message : String(error))
          .catch(() => undefined);
      } finally {
        this.inFlight.delete(run.sessionId);
      }
    }
  }
}
