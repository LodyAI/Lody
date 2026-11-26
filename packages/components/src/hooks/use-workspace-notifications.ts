import { useCallback } from 'react';
import { useAtomValue } from 'jotai';
import { useCloudQuery, useCloudMutation } from '@lody/platform/react';
import type { CloudQuery, CloudMutation } from '@lody/platform';
import { currentWorkspaceIdAtom } from '../atoms/workspace-context';
import {
  useAssertLegacyWorkspaceAccess,
  useLegacyWorkspaceQueryStatus,
} from './use-workspace-feature';

const operations = new Set([
  'inbox:listMine',
  'inbox:getSharingReviewState',
  'inbox:markRead',
  'inbox:dismiss',
  'inbox:reconcileSharingReview',
  'inbox:suppressSharingReview',
  'pushSubscriptions:register',
]);
function assertOperation(operation: { name: string }) {
  if (!operations.has(operation.name))
    throw new Error('Unsupported workspace notification operation');
}

export function useWorkspaceNotificationQuery<Args extends { workspaceId?: string }, Result>(
  operation: CloudQuery<Args, Result>,
  args: Args | 'skip'
): Result | undefined {
  assertOperation(operation);
  const status = useLegacyWorkspaceQueryStatus(args === 'skip' ? null : args.workspaceId, true);
  return useCloudQuery(operation, status === 'allowed' ? args : 'skip');
}

export function useWorkspaceNotificationMutation<Args extends object, Result>(
  operation: CloudMutation<Args, Result>
) {
  assertOperation(operation);
  const run = useCloudMutation(operation);
  const assertAccess = useAssertLegacyWorkspaceAccess(true);
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  return useCallback(
    async (args: Args) => {
      const target =
        'workspaceId' in args && typeof args.workspaceId === 'string'
          ? args.workspaceId
          : workspaceId;
      assertAccess(target);
      return run(args);
    },
    [run, assertAccess, workspaceId]
  );
}
