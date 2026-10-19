import { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useCloudAction } from '@lody/platform/react';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { toast } from '@/lib/toast';
import {
  createPersonalGitHubProof,
  takePersonalGitHubCallback,
  storePersonalGitHubProof,
} from '@/components/settings/github-personal-authorization';

/** The browser proving the OAuth request must also retain its signed-in Lody user. */
export function usePersonalGitHubAuthorization(
  workspaceId: string | null,
  workspaceSlug: string | null | undefined
) {
  const begin = useCloudAction(cloudOperations.github.beginPersonalAuthorization);
  const complete = useCloudAction(cloudOperations.github.completePersonalAuthorization);
  const { t } = useTranslation();
  useEffect(() => {
    if (!workspaceId) return;
    try {
      const callback = takePersonalGitHubCallback();
      if (!callback) return;
      void complete({ workspaceId, ...callback }).catch(() => {
        toast.error(
          t('settings.integrations.github.personalIdentityAuthFailed', 'Authorization failed')
        );
      });
    } catch {
      toast.error(
        t('settings.integrations.github.personalIdentityAuthFailed', 'Authorization failed')
      );
    }
  }, [workspaceId, complete, t]);
  return useCallback(async () => {
    if (!workspaceId || !workspaceSlug) return;
    const { verifier, challenge } = await createPersonalGitHubProof();
    const result = await begin({
      workspaceId,
      challenge,
      callbackURL: new URL(
        `/${encodeURIComponent(workspaceSlug)}/settings/github`,
        window.location.origin
      ).toString(),
    });
    storePersonalGitHubProof(result.state, verifier);
    window.location.assign(result.url);
  }, [workspaceId, workspaceSlug, begin]);
}
