import { useEffect, useSyncExternalStore } from 'react';
import type { PlatformProvider } from '@lody/platform';
import { readWorkspaceModeEvidence, retainWorkspaceModeProof } from '@/lib/e2ee-workspace-storage';
import { isListedEncryptedWorkspace } from '@/components/e2ee/encrypted-workspace-mark';

/** After the account's session is confirmed, retain a mode proof for every listed
 * workspace that lacks one, so a later offline open of any of them is admitted
 * from local evidence instead of provisionally. Best effort and sequential: a
 * failed read is left for the next listing change or launch, and runtime
 * admission remains the authority for whichever workspace is opened. The routed
 * workspace is skipped (its runtime reads the mode itself), as are workspaces
 * listed as encrypted, which always wait for authoritative admission.
 */
export function useWorkspaceModeProofPrefetch(
  platform: PlatformProvider,
  accountId: string | null,
  routedSlug: string | null
) {
  const workspaces = platform.e2eeWorkspaces;
  const session = platform.identity.session;
  const authenticated = useSyncExternalStore(session.subscribe, () => {
    const current = session.get();
    return current.status === 'authenticated' && current.user.id === accountId;
  });
  const listing = platform.workspaces.state;
  // Stable across re-renders while the listed id/slug pairs are unchanged.
  const listed = useSyncExternalStore(listing.subscribe, () => {
    const state = listing.get();
    if (state.status !== 'ready') return '';
    return JSON.stringify(
      state.workspaces
        .filter(
          (item) => item.slug && item.slug !== routedSlug && !isListedEncryptedWorkspace(item)
        )
        .map((item) => [item.id, item.slug])
        .sort()
    );
  });

  useEffect(() => {
    if (!workspaces || !accountId || !authenticated || !listed) return undefined;
    const entries = JSON.parse(listed) as [string, string][];
    let cancelled = false;
    void (async () => {
      for (const [workspaceId, slug] of entries) {
        if (cancelled) return;
        try {
          if (readWorkspaceModeEvidence(localStorage, accountId, workspaceId).descriptor) continue;
          const descriptor = await workspaces.describe({ workspaceId });
          if (cancelled) return;
          if (descriptor.workspaceId !== workspaceId) continue;
          retainWorkspaceModeProof(localStorage, accountId, slug, descriptor);
        } catch (error) {
          // Unreadable or conflicting local evidence and failed reads are handled
          // by runtime admission when that workspace is actually opened.
          console.info('Workspace mode prefetch skipped', { workspaceId, error });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaces, accountId, authenticated, listed]);
}
