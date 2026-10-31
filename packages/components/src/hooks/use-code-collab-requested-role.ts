import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useAtomValue } from 'jotai';
import { getCodeCollabMaxRoleForWorkspaceMember, type CodeCollabRole } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useOrganization } from './useOrganization';

// Derives the Code Collab edit capability exposed by the UI from workspace
// membership. v2 file operations still go through Machine RPC authorization;
// this value only drives local read/write affordances such as save buttons.
//
// Mapping (from `getCodeCollabMaxRoleForWorkspaceMember`):
//   workspace owner/admin/member → 'write'
//   workspace viewer/read/guest → 'read'
//   non-member / unknown        → 'read' (fallback; server will
//                                  reject as 'not-workspace-member'
//                                  if the user really has no role)
//
// Encrypted workspaces use the verified ledger role from the runtime instead:
// the organization listing is display data there and never grants file writes.
//
// `host` is reserved for the CLI machine boundary; web users never use it.
export function useCodeCollabRequestedRole(): CodeCollabRole {
  const { role: workspaceRole } = useOrganization();
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const encrypted = runtime?.contentMode === 'e2ee';
  const protectedRole = encrypted ? runtime.protectedCodeCollabRole : undefined;
  const subscribe = useCallback(
    (listener: () => void) => protectedRole?.subscribe(listener) ?? (() => undefined),
    [protectedRole]
  );
  const getProtectedRole = useCallback(() => protectedRole?.get() ?? 'read', [protectedRole]);
  const verifiedRole = useSyncExternalStore(subscribe, getProtectedRole, getProtectedRole);
  return useMemo(() => {
    if (encrypted) return verifiedRole;
    return getCodeCollabMaxRoleForWorkspaceMember({ workspaceRole }) ?? 'read';
  }, [encrypted, verifiedRole, workspaceRole]);
}
