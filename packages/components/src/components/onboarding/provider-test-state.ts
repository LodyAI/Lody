import type { AgentConfigId, MachineAcpBinaryProgressMessage } from '@lody/shared';

export type ProviderTestActivityPhase =
  | 'checking-runtime'
  | 'downloading-runtime'
  | 'verifying-runtime'
  | 'extracting-runtime'
  | 'installing-runtime'
  | 'probing-provider';

export type ProviderTestActivity = {
  phase: ProviderTestActivityPhase;
  percent?: number;
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
      // The final refresh response owns the durable error. Until it arrives,
      // keep the activity honest without briefly presenting a second result.
      return { phase: 'checking-runtime' };
  }

  const unreachableStatus: never = progress.status;
  throw new Error(`Unknown provider runtime progress status: ${String(unreachableStatus)}`);
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
