import { useEffect, useSyncExternalStore } from 'react';
import type { PlatformProvider } from '@lody/platform';
import { readWorkspaceModeEvidence, retainWorkspaceModeProof } from '@/lib/e2ee-workspace-storage';
import { isListedEncryptedWorkspace } from '@/components/e2ee/encrypted-workspace-mark';
import {
  assertNoRetainedEncryptedIdentity,
  HostIdentityUnavailableError,
  WORKSPACE_MODE_ADMISSION_TIMEOUT_MS,
} from './workspace-mode-admission';

export const WORKSPACE_MODE_PREFETCH_CONCURRENCY = 4;

/** After the account's session is confirmed, retain a mode proof for every listed
 * workspace that lacks one, so a later offline open of any of them is admitted
 * from local evidence instead of provisionally. Best effort with bounded
 * concurrency: a failed read is left for the next listing change or launch, and
 * runtime admission remains the authority for whichever workspace is opened. The
 * routed workspace is skipped (its runtime reads the mode itself), as are
 * workspaces listed as encrypted, which always wait for authoritative admission.
 * A proof is saved only after the device host reports no encrypted identity for
 * the workspace, the same check runtime admission applies to a fresh answer.
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
    let hostUnavailable = false;
    const abort = new AbortController();
    let nextIndex = 0;
    const workerCount = Math.min(WORKSPACE_MODE_PREFETCH_CONCURRENCY, entries.length);
    const runWorker = async () => {
      while (!cancelled && !hostUnavailable) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= entries.length) return;
        const [workspaceId, slug] = entries[index]!;
        try {
          if (readWorkspaceModeEvidence(localStorage, accountId, workspaceId).descriptor) continue;
          const descriptor = await workspaces.describe({ workspaceId });
          if (cancelled || hostUnavailable) return;
          if (descriptor.workspaceId !== workspaceId) continue;
          // A retained host identity records its marker and throws; any host
          // failure also throws, so no plaintext proof is saved without the host.
          await assertNoRetainedEncryptedIdentity({
            runtime: workspaces.runtime,
            storage: localStorage,
            accountId,
            workspaceId,
            descriptor,
            signal: abort.signal,
            deadlineMs: WORKSPACE_MODE_ADMISSION_TIMEOUT_MS,
            failFast: true,
          });
          if (cancelled || hostUnavailable) return;
          retainWorkspaceModeProof(localStorage, accountId, slug, descriptor);
        } catch (error) {
          // Unreadable or conflicting local evidence and failed reads are handled
          // by runtime admission when that workspace is actually opened.
          console.info('Workspace mode prefetch skipped', { workspaceId, error });
          // A temporarily unavailable host affects every remaining workspace alike;
          // the next listing change or launch prefetches again.
          if (error instanceof HostIdentityUnavailableError) {
            hostUnavailable = true;
            abort.abort();
            return;
          }
        }
      }
    };
    void Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [workspaces, accountId, authenticated, listed]);
}
