import { useAtomValue } from 'jotai';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useWorkspaceLocalAccountId } from '@/lib/e2ee-account';
import {
  useResolvedWorkspaceScope,
  type WorkspaceScopeOptions,
} from './use-resolved-workspace-scope';

/** Reading member-encrypted documents grants no machine or project execution access. */
export function useWorkspaceHistoryAccess(options: WorkspaceScopeOptions = {}): boolean {
  const scope = useResolvedWorkspaceScope(options);
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const accountId = useWorkspaceLocalAccountId();
  return Boolean(
    scope.enabled &&
    accountId &&
    runtime?.accountId === accountId &&
    runtime.workspaceId === scope.workspaceId &&
    runtime.contentMode === 'e2ee'
  );
}
