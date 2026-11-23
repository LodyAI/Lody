import { useCallback, useSyncExternalStore } from 'react';
import { useAtomValue, useStore } from 'jotai';
import type { CloudQuery, CloudMutation, CloudAction } from '@lody/platform';
import {
  useCloudQuery,
  useCloudMutation,
  useCloudAction,
  usePlatform,
  usePlatformWorkspaces,
} from '@lody/platform/react';
import { userAtom } from '@/atoms';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { workspaceContentModeAtom } from '@/atoms/workspace-content-mode';
import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from '@/atoms/workspace-context';
import { useWorkspaceRouteTargetSlug } from '../providers/workspace-route-target';
import {
  assertGithubWorkspaceAccess,
  githubWorkspaceOperations,
  resolveGithubWorkspaceStatus,
} from '@/lib/github-workspace-admission';
import { LegacyWorkspaceAdmissionError } from '@/lib/legacy-workspace-admission';

export function useGithubWorkspaceStatus(workspaceId: string | null | undefined, manage = false) {
  const platform = usePlatform();
  const mode = useAtomValue(workspaceContentModeAtom);
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const accountId = useAtomValue(userAtom)?.id ?? null;
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom);
  const slug = useAtomValue(currentWorkspaceSlugAtom);
  const routeSlug = useWorkspaceRouteTargetSlug() ?? slug;
  const workspacesState = usePlatformWorkspaces();
  const role = runtime?.protectedMemberRole;
  const subscribe = useCallback(
    (listener: () => void) => role?.subscribe(listener) ?? (() => {}),
    [role]
  );
  const get = useCallback(() => role?.get() ?? null, [role]);
  useSyncExternalStore(subscribe, get, get);
  return resolveGithubWorkspaceStatus(
    {
      workspaceId,
      platformKind: platform.kind,
      mode,
      runtime,
      accountId,
      currentWorkspaceId,
      routeSlug,
      workspacesState,
    },
    manage
  );
}

export function useGithubWorkspaceQuery<Args extends { workspaceId?: string }, Result>(
  operation: CloudQuery<Args, Result>,
  args: Args | 'skip'
): Result | undefined {
  const status = useGithubWorkspaceStatus(args === 'skip' ? null : args.workspaceId);
  return useCloudQuery(
    operation,
    status === 'allowed' && githubWorkspaceOperations.get(operation.name) === 'use' ? args : 'skip'
  );
}

function useGithubWorkspaceOperation<Args extends object, Result>(
  operation: string,
  run: (args: Args) => Promise<Result>
) {
  const store = useStore();
  const platform = usePlatform();
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const slug = useAtomValue(currentWorkspaceSlugAtom);
  const routeSlug = useWorkspaceRouteTargetSlug() ?? slug;
  const accountId = useAtomValue(userAtom)?.id ?? null;
  return useCallback(
    async (args: Args) => {
      const target =
        'workspaceId' in args && typeof args.workspaceId === 'string'
          ? args.workspaceId
          : workspaceId;
      if ((store.get(userAtom)?.id ?? null) !== accountId)
        throw new LegacyWorkspaceAdmissionError('account_changed');
      assertGithubWorkspaceAccess(
        {
          workspaceId: target,
          platformKind: platform.kind,
          mode: store.get(workspaceContentModeAtom),
          runtime: store.get(activeWorkspaceRuntimeAtom),
          accountId,
          currentWorkspaceId: store.get(currentWorkspaceIdAtom),
          routeSlug,
          workspacesState: platform.workspaces.state.get(),
        },
        operation
      );
      return run(args);
    },
    [store, platform, workspaceId, routeSlug, accountId, operation, run]
  );
}

export function useGithubWorkspaceMutation<Args extends object, Result>(
  operation: CloudMutation<Args, Result>
) {
  return useGithubWorkspaceOperation(operation.name, useCloudMutation(operation));
}
export function useGithubWorkspaceAction<Args extends object, Result>(
  operation: CloudAction<Args, Result>
) {
  return useGithubWorkspaceOperation(operation.name, useCloudAction(operation));
}
