import { useCallback } from 'react';
import { useAtomValue } from 'jotai';
import { currentWorkspaceIdAtom } from '../atoms/workspace-context';
import type { CloudQuery, CloudMutation, CloudAction } from '@lody/platform';
import { useCloudQuery, useCloudMutation, useCloudAction } from '@lody/platform/react';
import {
  useAssertLegacyWorkspaceAccess,
  useLegacyWorkspaceQueriesEnabled,
} from './use-workspace-feature';

/** Only for legacy queries whose backend refuses encrypted workspaces. Control,
 * billing, and encrypted sharing operations keep their own supported paths. */
export function useLegacyWorkspaceQuery<Args extends { workspaceId?: string }, Result>(
  operation: CloudQuery<Args, Result>,
  args: Args | 'skip'
): Result | undefined {
  const enabled = useLegacyWorkspaceQueriesEnabled(args === 'skip' ? null : args.workspaceId);
  return useCloudQuery(operation, enabled ? args : 'skip');
}

function useLegacyWorkspaceOperation<Args extends object, Result>(
  run: (args: Args) => Promise<Result>
) {
  const assertAccess = useAssertLegacyWorkspaceAccess();
  const boundWorkspaceId = useAtomValue(currentWorkspaceIdAtom);
  return useCallback(
    async (args: Args): Promise<Result> => {
      const workspaceId =
        'workspaceId' in args && typeof args.workspaceId === 'string'
          ? args.workspaceId
          : boundWorkspaceId;
      assertAccess(workspaceId);
      return run(args);
    },
    [assertAccess, boundWorkspaceId, run]
  );
}

export function useLegacyWorkspaceMutation<Args extends object, Result>(
  operation: CloudMutation<Args, Result>
) {
  return useLegacyWorkspaceOperation(useCloudMutation(operation));
}

export function useLegacyWorkspaceAction<Args extends object, Result>(
  operation: CloudAction<Args, Result>
) {
  return useLegacyWorkspaceOperation(useCloudAction(operation));
}
