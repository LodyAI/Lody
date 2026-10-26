import { useCallback, useMemo } from 'react';
import type { WorkspaceId } from '@lody/shared';
import { useE2eeAccountId } from '@/lib/e2ee-account';
import { workspaceInfoCache } from '@/lib/local-storage-cache';
import {
  readE2eeGenesisPin,
  readWorkspaceModeEvidence,
  readWorkspaceModeProof,
} from '@/lib/e2ee-workspace-storage';
import { isNavigableWorkspaceSlug, writePreferredWorkspaceSlug } from '@/lib/workspace';

export type SidebarWorkspaceChoice = {
  id: string;
  slug?: string;
  name: string;
  logo?: string | null;
};

/** Display/navigation hints only. Native open still checks the account binding,
 * verified ledger and key. A different account's cache never enters this list. */
function cachedEncryptedChoices(accountId: string): SidebarWorkspaceChoice[] {
  return Object.entries(workspaceInfoCache.readAll()).flatMap(([slug, info]) => {
    if (!isNavigableWorkspaceSlug(slug)) return [];
    try {
      const pin = readE2eeGenesisPin(localStorage, accountId, info.workspaceId);
      const evidence = readWorkspaceModeEvidence(localStorage, accountId, info.workspaceId);
      const descriptor = readWorkspaceModeProof(localStorage, accountId, info.workspaceId, slug);
      if (
        evidence.rejected ||
        !pin ||
        !descriptor ||
        !('contentMode' in descriptor) ||
        descriptor.contentMode !== 'e2ee' ||
        descriptor.genesisHash !== pin
      )
        return [];
      return [{ id: info.workspaceId, slug, name: info.workspaceName }];
    } catch {
      // An unreadable display hint cannot authorize a fallback or hide other
      // workspaces. Opening the affected workspace still checks its evidence.
      return [];
    }
  });
}

/** Keep ordinary organization selection intact. An already-open encrypted
 * workspace can navigate between locally joined peers while cloud auth is offline. */
export function useSidebarWorkspaceNavigation(input: {
  encryptedAccountId: string | null;
  organizations: SidebarWorkspaceChoice[] | undefined;
  switchOrganization: (id: string) => Promise<void>;
  setContext: (context: { slug: string; workspaceId: WorkspaceId }) => void;
  navigate: (slug: string) => void;
  close: () => void;
}) {
  const { encryptedAccountId, organizations, switchOrganization, setContext, navigate, close } = input;
  const local = encryptedAccountId !== null && organizations === undefined;
  const accountId = useE2eeAccountId(local);
  const workspaces = useMemo(
    () =>
      organizations ??
      (local && accountId && accountId === encryptedAccountId
        ? cachedEncryptedChoices(accountId)
        : []),
    [organizations, local, accountId, encryptedAccountId]
  );
  const select = useCallback(
    (id: string) => {
      const target = workspaces.find((workspace) => workspace.id === id);
      if (!target?.slug) return;
      writePreferredWorkspaceSlug(target.slug);
      setContext({ slug: target.slug, workspaceId: target.id as WorkspaceId });
      if (!local) void switchOrganization(target.id);
      close();
      navigate(target.slug);
    },
    [workspaces, local, setContext, switchOrganization, close, navigate]
  );
  return { workspaces, select };
}
