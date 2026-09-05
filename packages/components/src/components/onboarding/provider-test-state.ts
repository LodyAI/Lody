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

export type ProviderTestRun = {
  id: number;
  signal: AbortSignal;
};

export type ProviderTestRunRegistry = ReturnType<typeof createProviderTestRunRegistry>;

/**
 * Tracks one current probe per config. Starting, editing, or deleting a config
 * invalidates its previous run so a late response can never overwrite newer UI.
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
    invalidateAll(): void {
      for (const entry of current.values()) entry.controller.abort();
      current.clear();
    },
  };
}
