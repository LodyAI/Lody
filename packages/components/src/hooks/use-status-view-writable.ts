import { useCallback, useSyncExternalStore } from 'react';
import { useAtomValue } from 'jotai';
import { usePlatform } from '@lody/platform/react';
import { getCodeCollabMaxRoleForWorkspaceMember } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';

/**
 * Whether this member may change shared Status view state: Later, Settle,
 * Move to Focus, Focus order and pin sections. Display gate only; every write
 * still passes the session management guard.
 *
 * Encrypted workspaces use the verified ledger role, where a Guest is
 * read-only and its metadata upload would fail silently. Ordinary workspaces
 * hide the actions only for a known read-only membership (`workspaceRole`,
 * when the caller has it); an unresolved role keeps them, because the server
 * still decides.
 */
export function useStatusViewWritable(workspaceRole?: string | null): boolean {
  const platform = usePlatform();
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const protectedRole =
    runtime?.contentMode === 'e2ee' ? runtime.protectedCodeCollabRole : undefined;
  const subscribe = useCallback(
    (listener: () => void) => protectedRole?.subscribe(listener) ?? (() => undefined),
    [protectedRole]
  );
  const getProtectedRole = useCallback(() => protectedRole?.get() ?? 'read', [protectedRole]);
  const verifiedRole = useSyncExternalStore(subscribe, getProtectedRole, getProtectedRole);
  if (platform.kind === 'local') return true;
  if (runtime?.contentMode === 'e2ee') return verifiedRole === 'write';
  if (!workspaceRole) return true;
  return getCodeCollabMaxRoleForWorkspaceMember({ workspaceRole }) !== 'read';
}
