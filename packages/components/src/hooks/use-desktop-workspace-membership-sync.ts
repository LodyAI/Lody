import { useEffect, useRef } from 'react';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { useAuthClient } from '../providers/convex-provider';
import { useCloudQuery } from '@lody/platform/react';

/**
 * Refresh cloud clients' Better Auth organization cache when Convex observes a
 * cross-device membership change. The first value is only a baseline: the
 * organization store performs its own initial fetch.
 */
export function useDesktopWorkspaceMembershipSync(userId: string | null): void {
  const authClient = useAuthClient();
  const fingerprint = useCloudQuery(
    cloudOperations.auth.getMyWorkspaceMembershipFingerprint,
    userId ? {} : 'skip'
  );
  const observedMembershipRef = useRef<{ userId: string; fingerprint: string } | null>(null);

  useEffect(() => {
    if (!userId) {
      observedMembershipRef.current = null;
      return;
    }
    // `null` means the Convex auth provider has not authenticated this query.
    // An authenticated user with no memberships receives the empty string.
    if (fingerprint == null) {
      return;
    }
    const observedMembership = observedMembershipRef.current;
    if (!observedMembership || observedMembership.userId !== userId) {
      observedMembershipRef.current = { userId, fingerprint };
      return;
    }
    if (observedMembership.fingerprint === fingerprint) {
      return;
    }

    observedMembershipRef.current = { userId, fingerprint };
    void authClient
      .updateSession()
      .then(() => {
        authClient.$store.notify('$activeOrgSignal');
      })
      .catch((error) => {
        console.warn('[Auth] Failed to refresh workspaces after membership change', error);
      });
  }, [authClient, fingerprint, userId]);
}
