import { useEffect, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { CompactSection } from './compact-layout';
import { settingsSurface as surface } from './surface';
import { readGitHubInstallError, readGitHubInstallRetry } from '@/lib/github-installation-recovery';
import { isElectronRenderer } from '@/lib/electron';
import { openExternalUrl } from '@/lib/native-browser';

const retryable = new Set([
  'authorization_required',
  'temporarily_unavailable',
  'installation_not_visible',
  'suspended',
  'repositories_too_many',
]);

export function GitHubInstallationNotice({
  needsAuthorization = false,
  authorized,
  onAuthorize,
  disabled = false,
}: {
  needsAuthorization?: boolean;
  authorized: boolean;
  onAuthorize: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const router = useRouter({ warn: false });
  const readRouterLocation = () => ({
    search: router.state.location.searchStr,
    hash: `#${router.state.location.hash}`,
  });
  const [location, setLocation] = useState(() =>
    router
      ? readRouterLocation()
      : {
          search: window.location.search,
          hash: window.location.hash,
        }
  );
  useEffect(() => {
    // Router replace navigation does not dispatch browser popstate/hashchange.
    const unsubscribe = router?.subscribe('onResolved', () => setLocation(readRouterLocation()));
    const updateWindow = () =>
      setLocation({ search: window.location.search, hash: window.location.hash });
    window.addEventListener('hashchange', updateWindow);
    window.addEventListener('popstate', updateWindow);
    return () => {
      unsubscribe?.();
      window.removeEventListener('hashchange', updateWindow);
      window.removeEventListener('popstate', updateWindow);
    };
  }, [router]);
  const code = needsAuthorization
    ? 'authorization_required'
    : readGitHubInstallError(location.search);
  if (!code) return null;
  const messages = {
    authorization_required: authorized
      ? t(
          'settings.integrations.github.installErrors.managementRequired',
          'Reauthorize with the installation owner’s GitHub account or an active organization administrator, then retry.'
        )
      : t(
          'settings.integrations.github.installErrors.authorizationRequired',
          'Authorize your personal GitHub account first, then connect the GitHub App. This does not change your “Act as you” preference.'
        ),
    temporarily_unavailable: t(
      'settings.integrations.github.installErrors.temporarilyUnavailable',
      'GitHub could not be reached. Try the same installation again.'
    ),
    installation_not_visible: t(
      'settings.integrations.github.installErrors.installationNotVisible',
      'Your GitHub account cannot access this installation. Check the account and repository access, then retry.'
    ),
    linked_elsewhere: t(
      'settings.integrations.github.installErrors.linkedElsewhere',
      'This installation is already connected to another workspace. Disconnect it there before connecting it here.'
    ),
    suspended: t(
      'settings.integrations.github.installErrors.suspended',
      'This GitHub installation is suspended. Restore it in GitHub, then retry.'
    ),
    encrypted_workspace: t(
      'settings.integrations.github.installErrors.encryptedWorkspace',
      'GitHub App connections are unavailable in encrypted workspaces.'
    ),
    repositories_too_many: t(
      'settings.integrations.github.installErrors.repositoriesTooMany',
      'This installation has too many repositories to verify. Select fewer repositories in GitHub, then retry.'
    ),
    invalid_state: t(
      'settings.integrations.github.installErrors.invalidState',
      'This installation attempt has expired or already finished. Start a new connection.'
    ),
    forbidden: t(
      'settings.integrations.github.installErrors.forbidden',
      'Only a current workspace owner or admin can connect this installation.'
    ),
    deletion_in_progress: t(
      'settings.integrations.github.installErrors.deletionInProgress',
      'This account or workspace is being deleted. The installation cannot be connected.'
    ),
    unknown: t(
      'settings.integrations.github.installErrors.unknown',
      'The installation could not be connected. Start a new connection or contact support.'
    ),
  };
  const retry = retryable.has(code)
    ? readGitHubInstallRetry(location.hash, import.meta.env.VITE_CONVEX_SITE_URL)
    : null;
  return (
    <CompactSection>
      <p role="alert" {...stylex.props(surface.cardNote)}>
        {messages[code]}
      </p>
      {code === 'authorization_required' || code === 'installation_not_visible' ? (
        <Button variant="secondary" size="small" onClick={onAuthorize} disabled={disabled}>
          {t('settings.integrations.github.personalIdentityAuthorize', 'Authorize')}
        </Button>
      ) : null}
      {retry && (code !== 'authorization_required' || authorized) ? (
        <Button
          variant="secondary"
          size="small"
          disabled={disabled}
          onClick={() => {
            if (isElectronRenderer()) void openExternalUrl(retry);
            else window.location.assign(retry);
          }}
        >
          {t('settings.integrations.github.retryInstallation', 'Retry installation')}
        </Button>
      ) : null}
    </CompactSection>
  );
}
