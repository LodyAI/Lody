import { restoreGitHubInstallationRecovery } from '@/lib/github-installation-recovery';
import { useLegacyWorkspaceQueryStatus } from './use-workspace-feature';
import { useLegacyWorkspaceAction } from '@/hooks/use-legacy-workspace-query';
import { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
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
  const begin = useLegacyWorkspaceAction(cloudOperations.github.beginPersonalAuthorization);
  const complete = useLegacyWorkspaceAction(cloudOperations.github.completePersonalAuthorization);
  const { t } = useTranslation();
  const legacyStatus = useLegacyWorkspaceQueryStatus(workspaceId);
  useEffect(() => {
    if (!workspaceId || legacyStatus !== 'allowed') return;
    let active = true;
    try {
      const callback = takePersonalGitHubCallback();
      if (!callback) return;
      const callbackLocation = window.location.href;
      const { installationRecovery, ...authorization } = callback;
      void complete({ workspaceId, ...authorization })
        .then(() => {
          if (active && window.location.href === callbackLocation && installationRecovery)
            restoreGitHubInstallationRecovery(installationRecovery);
        })
        .catch(() => {
          if (active && window.location.href === callbackLocation && installationRecovery)
            restoreGitHubInstallationRecovery(installationRecovery);
          toast.error(
            t('settings.integrations.github.personalIdentityAuthFailed', 'Authorization failed')
          );
        });
    } catch {
      toast.error(
        t('settings.integrations.github.personalIdentityAuthFailed', 'Authorization failed')
      );
    }
    return () => {
      active = false;
    };
  }, [workspaceId, complete, legacyStatus, t]);
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
