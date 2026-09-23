import type { AgentConfigId, MachineAcpBinaryProgressMessage } from '@lody/shared';

import type { AgentReadiness } from '@/components/shared/agent-readiness-mark';

export type ProviderTestActivityPhase =
  | 'checking-runtime'
  | 'downloading-runtime'
  | 'verifying-runtime'
  | 'extracting-runtime'
  | 'installing-runtime'
  | 'probing-provider'
  | 'runtime-failed';

export type ProviderTestActivity = {
  phase: ProviderTestActivityPhase;
  percent?: number;
  /**
   * When the owning request started, so a stage with no denominator can still
   * show elapsed time. A wait you can measure is bounded; an unbounded one is
   * the thing that has no floor.
   */
  startedAtMs?: number;
};

export function providerTestActivityFromProgress(
  progress: MachineAcpBinaryProgressMessage
): ProviderTestActivity {
  switch (progress.status) {
    case 'checking':
    case 'not-installed':
      return { phase: 'checking-runtime' };
    case 'downloading':
      return {
        phase: 'downloading-runtime',
        ...(typeof progress.percent === 'number'
          ? { percent: Math.min(100, Math.max(0, progress.percent)) }
          : {}),
      };
    case 'verifying':
      return { phase: 'verifying-runtime' };
    case 'extracting':
      return { phase: 'extracting-runtime' };
    case 'publishing':
      return { phase: 'installing-runtime' };
    case 'installed':
      return { phase: 'probing-provider' };
    case 'unsupported-platform':
    case 'incompatible-host':
    case 'error':
      // The final refresh response still owns the durable error and its reason;
      // this phase only keeps the in-flight activity honest until it arrives.
      // Reporting a runtime that already failed as 'checking-runtime' is how a
      // known failure gets presented as work still in progress.
      return { phase: 'runtime-failed' };
  }

  const unreachableStatus: never = progress.status;
  throw new Error(`Unknown provider runtime progress status: ${String(unreachableStatus)}`);
}

export type AgentRuntimeReadiness = {
  readiness: AgentReadiness;
  /** Only ever set while downloading, the one stage with a real denominator. */
  percent: number | null;
};

/**
 * Turns the machine's ephemeral runtime progress into the readiness a mark can
 * wear. Background prefetch fills those snapshots before the user reaches this
 * step, so the logo wall reads as an inventory filling in rather than as a
 * queue of pending work.
 *
 * A failed runtime reads as `cold`, not as a failure: the mark carries no
 * failure vocabulary, and the row's own badge owns the reason.
 */
export function agentRuntimeReadinessFromProgress(
  progress: MachineAcpBinaryProgressMessage | null | undefined
): AgentRuntimeReadiness {
  if (!progress) return { readiness: 'cold', percent: null };
  switch (progress.status) {
    case 'installed':
      return { readiness: 'ready', percent: null };
    case 'downloading':
      return {
        readiness: 'arriving',
        percent:
          typeof progress.percent === 'number'
            ? Math.min(100, Math.max(0, progress.percent))
            : null,
      };
    case 'checking':
    case 'not-installed':
    case 'verifying':
    case 'extracting':
    case 'publishing':
      return { readiness: 'arriving', percent: null };
    case 'unsupported-platform':
    case 'incompatible-host':
    case 'error':
      return { readiness: 'cold', percent: null };
  }

  const unreachableStatus: never = progress.status;
  throw new Error(`Unknown provider runtime progress status: ${String(unreachableStatus)}`);
}

/**
 * Readiness for a row whose test/setup request is in flight. The request owns
 * the mark while it runs, so a determinate download fills the ring and every
 * denominator-free stage — including the ACP handshake — orbits instead.
 */
export function agentRuntimeReadinessFromActivity(
  activity: ProviderTestActivity | undefined
): AgentRuntimeReadiness | null {
  if (!activity) return null;
  if (activity.phase === 'runtime-failed') return { readiness: 'cold', percent: null };
  if (activity.phase === 'downloading-runtime') {
    return {
      readiness: 'arriving',
      percent:
        typeof activity.percent === 'number'
          ? Math.min(100, Math.max(0, activity.percent))
          : null,
    };
  }
  return { readiness: 'arriving', percent: null };
}

/**
 * How a wait presents once it stops being routine.
 *
 * - `normal` — name the stage and nothing else. A counter under a few seconds
 *   only teaches the user to watch a number that was never going to matter.
 * - `measured` — show elapsed time. The wait has run long enough that the user
 *   wants it bounded, and a number they can watch is what bounds it.
 * - `exceptional` — say so. Past here a stage name over a rising number reads
 *   as the UI insisting everything is fine; the honest move is to admit the
 *   wait has left the normal range. Not by inventing progress — by changing
 *   what the interface is willing to claim.
 */
export type ProviderWaitEscalation = 'normal' | 'measured' | 'exceptional';

/** Elapsed seconds at which a wait starts showing its number. */
export const PROVIDER_WAIT_MEASURED_AFTER_SECONDS = 10;

/** Elapsed seconds at which a wait stops presenting itself as ordinary. */
export const PROVIDER_WAIT_EXCEPTIONAL_AFTER_SECONDS = 60;

export function providerWaitEscalation(elapsedSeconds: number): ProviderWaitEscalation {
  if (elapsedSeconds >= PROVIDER_WAIT_EXCEPTIONAL_AFTER_SECONDS) return 'exceptional';
  if (elapsedSeconds >= PROVIDER_WAIT_MEASURED_AFTER_SECONDS) return 'measured';
  return 'normal';
}

export type ProviderTestRun = {
  id: number;
  signal: AbortSignal;
};

export type ProviderTestRunRegistry = ReturnType<typeof createProviderTestRunRegistry>;

/**
 * Tracks one current probe per config. Starting, editing, or deleting a config
 * invalidates its previous run so a late response can never overwrite newer UI.
 *
 * Not committing a result and cancelling the work behind it are two different
 * decisions, so they have two different methods. `invalidate` is for a probe
 * that became meaningless — its config was edited, deleted, or replaced — and
 * aborts. `detachAll` is for leaving the screen, and does not.
 */
export function createProviderTestRunRegistry() {
  let nextId = 0;
  const current = new Map<AgentConfigId, { id: number; controller: AbortController }>();

  const isCurrent = (configId: AgentConfigId, run: ProviderTestRun): boolean => {
    const active = current.get(configId);
    return active?.id === run.id && active.controller.signal === run.signal && !run.signal.aborted;
  };

  return {
    start(configId: AgentConfigId): ProviderTestRun {
      current.get(configId)?.controller.abort();
      const controller = new AbortController();
      const id = ++nextId;
      current.set(configId, { id, controller });
      return { id, signal: controller.signal };
    },
    isCurrent,
    finish(configId: AgentConfigId, run: ProviderTestRun): boolean {
      if (!isCurrent(configId, run)) return false;
      current.delete(configId);
      return true;
    },
    invalidate(configId: AgentConfigId): void {
      current.get(configId)?.controller.abort();
      current.delete(configId);
    },
    /**
     * Stop committing every run's result, but let the requests themselves run.
     *
     * Unmount is not a reason to abandon a recovery the machine is already
     * executing. A refresh writes durable capabilities, and the machine drops
     * the work when its last consumer leaves — so aborting here is what made
     * "continue past this step" silently also mean "give up on this agent",
     * at exactly the moment a slow first run makes moving on most attractive.
     */
    detachAll(): void {
      current.clear();
    },
  };
}
