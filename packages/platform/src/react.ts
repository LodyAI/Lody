import { createContext, useContext, useSyncExternalStore } from 'react';
import type { PlatformCapability } from './capabilities';
import {
  CloudCapabilityUnavailableError,
  type CloudAction,
  type CloudActionFunction,
  type CloudMutation,
  type CloudMutationFunction,
  type CloudQueryState,
  type OptionalCloudArgsOrSkip,
  type CloudQuery,
} from './cloud-api';
import type { PlatformProvider, PlatformSessionState, WorkspacesState } from './provider';
import type { ReadonlyStore } from './store';

/**
 * React binding for the platform contracts. App entries put their assembled
 * `PlatformProvider` into this context; UI reads it through the hooks below
 * instead of touching Convex / Better Auth hooks directly.
 */
export const PlatformContext = createContext<PlatformProvider | null>(null);

export function usePlatform(): PlatformProvider {
  const platform = useContext(PlatformContext);
  if (!platform) {
    throw new Error('usePlatform must be used within a PlatformContext provider');
  }
  return platform;
}

export function useStoreValue<T>(store: ReadonlyStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export function usePlatformSession(): PlatformSessionState {
  return useStoreValue(usePlatform().identity.session);
}

export function usePlatformWorkspaces(): WorkspacesState {
  return useStoreValue(usePlatform().workspaces.state);
}

export function usePlatformCapability(capability: PlatformCapability): boolean {
  return usePlatform().capabilities.has(capability);
}

function requireCloudApi(platform: PlatformProvider, capability: PlatformCapability) {
  if (!platform.capabilities.has(capability)) {
    throw new CloudCapabilityUnavailableError(capability);
  }
  if (!platform.cloudApi) {
    throw new Error(
      `Platform ${JSON.stringify(platform.kind)} exposes capability ${JSON.stringify(capability)} without a CloudApi implementation`,
    );
  }
  return platform.cloudApi;
}

const noopRetry = () => {};

/**
 * Capabilities are immutable for a mounted PlatformProvider, so the selected
 * hook implementation cannot change during the component lifetime. Local
 * builds return before entering a cloud SDK hook; cloud builds fail fast on an
 * incomplete provider instead of silently probing or falling back.
 */
export function useCloudQuery<Args, Result>(
  operation: CloudQuery<Args, Result>,
  ...args: OptionalCloudArgsOrSkip<NoInfer<Args>>
): Result | undefined {
  const platform = usePlatform();
  if (!platform.capabilities.has(operation.capability)) {
    return undefined;
  }
  return requireCloudApi(platform, operation.capability).useQuery(
    operation,
    (args[0] ?? {}) as Args | 'skip',
  );
}

/**
 * Non-throwing cloud query state with explicit `error` and `retry` for surfaces
 * that display an inline failure or recovery control.
 */
export function useCloudQueryState<Args, Result>(
  operation: CloudQuery<Args, Result>,
  ...args: OptionalCloudArgsOrSkip<NoInfer<Args>>
): CloudQueryState<Result> {
  const platform = usePlatform();
  if (!platform.capabilities.has(operation.capability)) {
    return { data: undefined, error: null, retry: noopRetry };
  }
  const cloudApi = requireCloudApi(platform, operation.capability);
  const resolvedArgs = (args[0] ?? {}) as Args | 'skip';
  if (cloudApi.useQueryState) {
    return cloudApi.useQueryState(operation, resolvedArgs);
  }
  return {
    data: cloudApi.useQuery(operation, resolvedArgs),
    error: null,
    retry: noopRetry,
  };
}

export function useCloudMutation<Args, Result>(
  operation: CloudMutation<Args, Result>,
): CloudMutationFunction<Args, Result> {
  const platform = usePlatform();
  if (!platform.capabilities.has(operation.capability)) {
    return () => Promise.reject(new CloudCapabilityUnavailableError(operation.capability));
  }
  return requireCloudApi(platform, operation.capability).useMutation(operation);
}

export function useCloudAction<Args, Result>(
  operation: CloudAction<Args, Result>,
): CloudActionFunction<Args, Result> {
  const platform = usePlatform();
  if (!platform.capabilities.has(operation.capability)) {
    return () => Promise.reject(new CloudCapabilityUnavailableError(operation.capability));
  }
  return requireCloudApi(platform, operation.capability).useAction(operation);
}
