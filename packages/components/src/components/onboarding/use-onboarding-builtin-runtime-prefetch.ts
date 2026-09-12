import { useEffect } from 'react';
import { useAtomValue } from 'jotai';
import type { ManagedBuiltinAgentType } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { currentWorkspaceIdAtom } from '@/atoms/workspace-context';
import { localCliStartingAtom, localMachineIdAtom } from '@/atoms/local-probe';
import { useMachineAcpBinaryActions } from '@/hooks/use-machine-acp-binary-actions';

/**
 * The managed runtimes warmed in the background. Exported because the provider
 * step reads readiness for exactly this set: a mark may only light up for an
 * agent something is actually preparing.
 */
export const BUILTIN_BACKGROUND_PREFETCH_AGENT_TYPES = [
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
  readonly running: Set<ManagedBuiltinAgentType>;
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
      running: new Set<ManagedBuiltinAgentType>(),
      owner: null,
      task: null,
      onError: null,
    };
    this.scopes.set(scopeKey, state);
    const owner = Symbol(scopeKey);
    state.owner = owner;
    state.task = task;
    state.onError = onError ?? null;
    this.launchPending(scopeKey, state, order);

    return {
      dispose: () => {
        if (state.owner !== owner) return;
        state.owner = null;
        state.task = null;
        state.onError = null;
      },
    };
  }

  reset(): void {
    this.scopes.clear();
  }

  /**
   * Every runtime that is not already running or finished starts now. `order`
   * still decides which request reaches the wire first, so a selected provider
   * gets the connection ahead of the rest without waiting behind it.
   */
  private launchPending(
    scopeKey: string,
    state: PrefetchScopeState,
    order: readonly ManagedBuiltinAgentType[]
  ): void {
    if (!state.owner || !state.task) return;
    const task = state.task;
    const onError = state.onError;
    for (const agentType of order) {
      if (state.running.has(agentType) || state.completed.has(agentType)) continue;
      state.running.add(agentType);
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
          state.running.delete(agentType);
        });
    }
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
 * step before managed built-in runtimes begin downloading. The runtimes are
 * downloaded CONCURRENTLY: the wait a user actually feels is wall-clock, and
 * running them one at a time made it the sum of three downloads instead of the
 * longest one. They are independent artifacts keyed by agent type, and
 * `useMachineAcpBinaryActions` already dedupes installs per machine and agent,
 * so nothing is duplicated by starting them together. Selecting a provider only
 * moves it to the front of the launch order; work already in flight continues.
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
