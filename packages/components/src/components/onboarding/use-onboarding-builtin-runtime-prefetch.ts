import { useEffect } from 'react';
import { useAtomValue } from 'jotai';
import type { ManagedBuiltinAgentType } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { currentWorkspaceIdAtom } from '@/atoms/workspace-context';
import { localCliStartingAtom, localMachineIdAtom } from '@/atoms/local-probe';
import { useMachineAcpBinaryActions } from '@/hooks/use-machine-acp-binary-actions';

const BUILTIN_BACKGROUND_PREFETCH_AGENT_TYPES = [
  'kimi',
  'codex',
  'claude',
] as const satisfies readonly ManagedBuiltinAgentType[];

function resolvePrefetchOrder(
  preferredAgentType: ManagedBuiltinAgentType | null
): ManagedBuiltinAgentType[] {
  if (preferredAgentType === null) return [...BUILTIN_BACKGROUND_PREFETCH_AGENT_TYPES];
  return [
    preferredAgentType,
    ...BUILTIN_BACKGROUND_PREFETCH_AGENT_TYPES.filter(
      (agentType) => agentType !== preferredAgentType
    ),
  ];
}

type PrefetchTask = (agentType: ManagedBuiltinAgentType) => Promise<void>;
type PrefetchErrorHandler = (agentType: ManagedBuiltinAgentType, error: unknown) => void;

type PrefetchScopeState = {
  readonly completed: Set<ManagedBuiltinAgentType>;
  pending: ManagedBuiltinAgentType[];
  running: ManagedBuiltinAgentType | null;
  owner: symbol | null;
  task: PrefetchTask | null;
  onError: PrefetchErrorHandler | null;
};

class OnboardingBuiltinRuntimePrefetchScheduler {
  private readonly scopes = new Map<string, PrefetchScopeState>();

  schedule(
    scopeKey: string,
    order: readonly ManagedBuiltinAgentType[],
    task: PrefetchTask,
    onError?: PrefetchErrorHandler
  ): { dispose: () => void } {
    const state = this.scopes.get(scopeKey) ?? {
      completed: new Set<ManagedBuiltinAgentType>(),
      pending: [],
      running: null,
      owner: null,
      task: null,
      onError: null,
    };
    this.scopes.set(scopeKey, state);
    const owner = Symbol(scopeKey);
    state.owner = owner;
    state.task = task;
    state.onError = onError ?? null;
    state.pending = order.filter(
      (agentType) => agentType !== state.running && !state.completed.has(agentType)
    );
    this.runNext(scopeKey, state);

    return {
      dispose: () => {
        if (state.owner !== owner) return;
        state.owner = null;
        state.task = null;
        state.onError = null;
        state.pending = [];
      },
    };
  }

  reset(): void {
    this.scopes.clear();
  }

  private runNext(scopeKey: string, state: PrefetchScopeState): void {
    if (state.running || !state.owner || !state.task) return;
    const agentType = state.pending.shift();
    if (!agentType) return;
    const task = state.task;
    const onError = state.onError;
    state.running = agentType;
    void Promise.resolve()
      .then(() => task(agentType))
      .then(() => {
        state.completed.add(agentType);
      })
      .catch((error) => {
        onError?.(agentType, error);
      })
      .finally(() => {
        if (this.scopes.get(scopeKey) !== state) return;
        state.running = null;
        this.runNext(scopeKey, state);
      });
  }
}

const prefetchScheduler = new OnboardingBuiltinRuntimePrefetchScheduler();

export const __onboardingBuiltinRuntimePrefetchForTests = {
  resolvePrefetchOrder,
  schedule: prefetchScheduler.schedule.bind(prefetchScheduler),
  reset(): void {
    prefetchScheduler.reset();
  },
};

/**
 * Onboarding should not wait for a user to reach or interact with the provider
 * step before managed built-in runtimes begin downloading. Background work is
 * serial across effect restarts. Selecting a provider reorders work that has
 * not started; the current download is allowed to finish first.
 */
export function useOnboardingBuiltinRuntimePrefetch(
  preferredAgentType: ManagedBuiltinAgentType | null
) {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const localMachineId = useAtomValue(localMachineIdAtom);
  const localCliStarting = useAtomValue(localCliStartingAtom);
  const { checkBinaryStatus, installBinary } = useMachineAcpBinaryActions(runtime, workspaceId);

  useEffect(() => {
    if (!runtime || workspaceId === null || localMachineId === null || localCliStarting) {
      return undefined;
    }

    const scheduled = prefetchScheduler.schedule(
      `${workspaceId}:${localMachineId}`,
      resolvePrefetchOrder(preferredAgentType),
      async (agentType) => {
        const status = await checkBinaryStatus({ machineId: localMachineId, agentType });
        if (status.status === 'not-installed') {
          await installBinary({ machineId: localMachineId, agentType });
        }
      },
      (agentType, error) => {
        console.error(
          `[onboarding] Builtin Agent runtime prefetch failed for ${agentType}:`,
          error
        );
      }
    );

    return scheduled.dispose;
  }, [
    checkBinaryStatus,
    installBinary,
    localCliStarting,
    localMachineId,
    preferredAgentType,
    runtime,
    workspaceId,
  ]);
}
