import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { Badge } from '@lody/ui/badge';
import { ArrowUpRight, Book, Github, Search } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { Spinner } from '@lody/ui/spinner';
import { useCloudAction, useCloudMutation } from '@lody/platform/react';
import { useAtomValue } from 'jotai';
import { currentWorkspaceSlugAtom } from '@/atoms';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { useAppCapability } from '@/lib/app-platform';
import { Switch } from '@lody/ui/switch';
import { Input } from '@lody/ui/input';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from '@/lib/toast';
import {
  MobileSettingsRow,
  MobileSettingsRowGroup,
  MobileSettingsSection,
} from '@/components/mobile/mobile-settings-row';
import {
  useSettingsDataCache,
  type SettingsWorkspaceRepoWithStatus,
} from '@/components/settings/settings-data-cache';
import { isElectronRenderer } from '@/lib/electron';
import { openExternalUrl } from '@/lib/native-browser';
import { getPersonalGitHubAuthorizationUrl } from '@/components/settings/github-personal-authorization';
import { usePersonalGitHubAuthorization } from '@/hooks/use-personal-github-authorization';
import { canRunAuthedWorkspaceQuery } from '@/lib/authed-convex-query';
import { invalidateGitHubTokensForWorkspace } from '@/lib/github-token';
import { GitHubPersonalIdentitySettingsCard } from '@/components/settings/integrations-setting';
import { isNativeAppShell } from '@/lib/native-platform';
import { useAuthenticatedConvex } from '@/hooks/use-authenticated-convex';
import { useCloudQuery } from '@lody/platform/react';
import { useConvexErrorMessage } from '@/hooks/use-convex-error-message';
// The theme tokens are imported by path, not by the `@/` alias: the StyleX
// compiler links a theme file on its own and does not follow bundler aliases.
import { themeColors } from '../../style/theme-colors.stylex';
import { themeSpace } from '../../style/theme-scale.stylex';
import { mobileSurface } from './surface';

const styles = stylex.create({
  /** The page: the sections stacked, set apart by the page's own rhythm. */
  page: {
    display: 'flex',
    flexDirection: 'column',
    paddingBottom: themeSpace[6],
    paddingTop: themeSpace[1],
  },
  /** The identity tile, in the accent's stronger wash. */
  identityTileStrong: { backgroundColor: 'hsl(var(--primary) / 0.15)' },
  /** The identity's name, in the ink of the page. */
  identityName: { color: themeColors.foreground },
  /** The panel the personal-identity card sits in, under its row. */
  identityPanel: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: themeColors.border,
    paddingInline: themeSpace[3],
    paddingBlock: themeSpace[3],
  },
  /** The search field's row, at the top of the repositories card. */
  searchBar: {
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: themeColors.border,
    paddingInline: themeSpace[3],
    paddingBlock: themeSpace[2],
  },
  searchField: { position: 'relative' },
  searchIcon: {
    position: 'absolute',
    left: themeSpace[3],
    top: '50%',
    height: themeSpace[4],
    width: themeSpace[4],
    transform: 'translateY(-50%)',
    color: themeColors.mutedForeground,
  },
  /** The list is still loading. */
  notice: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: themeSpace[2],
    paddingInline: themeSpace[4],
    paddingBlock: themeSpace[6],
    fontSize: '0.9rem',
    color: themeColors.mutedForeground,
  },
  /** The list has nothing to show. */
  emptyNotice: {
    paddingInline: themeSpace[4],
    paddingBlock: themeSpace[6],
    fontSize: '0.9rem',
    color: themeColors.mutedForeground,
  },
  /** A repository's row: its mark and its name. */
  repoIdentity: { display: 'flex', alignItems: 'center', gap: themeSpace[2], minWidth: 0 },
  repoIcon: { height: themeSpace[4], width: themeSpace[4], flexShrink: 0, opacity: 0.7 },
  /** The note under the card, with the way to fix it. */
  hint: {
    marginInline: themeSpace[5],
    marginTop: themeSpace[2],
    fontSize: '0.78rem',
    lineHeight: 1.625,
    color: 'hsl(var(--muted-foreground) / 0.8)',
  },
  hintLink: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: themeSpace[0.5],
    color: 'hsl(var(--foreground) / 0.8)',
    textUnderlineOffset: '2px',
    textDecorationLine: { default: 'none', ':hover': 'underline' },
  },
  hintIcon: { height: themeSpace[3], width: themeSpace[3] },
  /** The arrow inside a button. */
  buttonArrow: { height: themeSpace[3.5], width: themeSpace[3.5] },
});

export function MobileIntegrationsSettings() {
  // Hidden from the settings list without 'githubIntegration' (open-source
  // local build); safety net for direct navigation.
  const githubIntegrationAvailable = useAppCapability('githubIntegration');
  if (!githubIntegrationAvailable) {
    return null;
  }
  return <MobileCloudIntegrationsSettings />;
}

function MobileCloudIntegrationsSettings() {
  const { t } = useTranslation();
  const getConvexErrorMessage = useConvexErrorMessage();
  const {
    workspaceId: currentWorkspaceId,
    canManageGithub: canManage,
    workspaceReposWithStatus,
    workspaceReposLoading,
  } = useSettingsDataCache();
  const currentWorkspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const {
    claimAutomaticCommand,
    isAuthenticated: isConvexAuthenticated,
    isLoading: isConvexAuthLoading,
  } = useAuthenticatedConvex();
  const authedWorkspaceId = canRunAuthedWorkspaceQuery(currentWorkspaceId, isConvexAuthenticated)
    ? currentWorkspaceId
    : null;
  const workspaceAuthReady = authedWorkspaceId !== null;
  const authorizePersonal = usePersonalGitHubAuthorization(authedWorkspaceId, currentWorkspaceSlug);
  const workspaceAuthPending =
    Boolean(currentWorkspaceId) && (isConvexAuthLoading || !isConvexAuthenticated);
  const authorizeInBrowser = isElectronRenderer() || isNativeAppShell();
  const canAuthorizePersonalGitHub = Boolean(currentWorkspaceSlug);

  const [repoSearch, setRepoSearch] = useState('');
  const personalOperationSettings = useCloudQuery(
    cloudOperations.github.getPersonalOperationSettings,
    currentWorkspaceId ? { workspaceId: currentWorkspaceId } : 'skip'
  );
  const createGitHubInstallState = useCloudAction(cloudOperations.github.createGitHubInstallState);
  const setRepoEnabled = useCloudMutation(cloudOperations.github.setRepoEnabled);
  const setPersonalOperationPreference = useCloudMutation(
    cloudOperations.github.setPersonalOperationPreference
  );
  const refreshPersonalGitHubProfile = useCloudAction(
    cloudOperations.github.refreshPersonalGitHubProfile
  );
  const [connectingToGitHub, setConnectingToGitHub] = useState(false);
  const [updatingPersonalPreference, setUpdatingPersonalPreference] = useState(false);
  const [authorizingPersonalGitHub, setAuthorizingPersonalGitHub] = useState(false);

  // Track optimistic toggle states: repoFullName -> desired enabled state
  const [optimisticToggles, setOptimisticToggles] = useState<Record<string, boolean>>({});

  const [prevWorkspaceId, setPrevWorkspaceId] = useState(currentWorkspaceId);
  if (prevWorkspaceId !== currentWorkspaceId) {
    setPrevWorkspaceId(currentWorkspaceId);
    setRepoSearch('');
    setOptimisticToggles({});
  }

  // Clear optimistic state when server data updates
  useEffect(() => {
    if (!workspaceReposWithStatus) return;
    setOptimisticToggles((prev) => {
      const next: Record<string, boolean> = {};
      for (const [key, val] of Object.entries(prev)) {
        const serverRepo = workspaceReposWithStatus.find((r) => r.repoFullName === key);
        // Keep optimistic state only if server hasn't caught up yet
        if (serverRepo && serverRepo.enabled !== val) {
          next[key] = val;
        }
      }
      return next;
    });
  }, [workspaceReposWithStatus]);

  const repos = useMemo<SettingsWorkspaceRepoWithStatus[]>(() => {
    if (!workspaceReposWithStatus) return [];
    return workspaceReposWithStatus.map((repo) => ({
      ...repo,
      enabled: optimisticToggles[repo.repoFullName] ?? repo.enabled,
    }));
  }, [workspaceReposWithStatus, optimisticToggles]);

  const searchQuery = repoSearch.trim().toLowerCase();
  const filteredRepos = useMemo(() => {
    if (!searchQuery) return repos;
    return repos.filter((repo) => repo.repoFullName.toLowerCase().includes(searchQuery));
  }, [repos, searchQuery]);

  const enabledCount = useMemo(() => repos.filter((r) => r.enabled).length, [repos]);
  const showGitHubConnectSpinner = connectingToGitHub || workspaceAuthPending;
  const personalIdentityEnabled = personalOperationSettings?.enabled ?? false;
  const personalAuthorizationState = personalOperationSettings?.authorization.state ?? 'missing';
  const personalAuthorization =
    personalOperationSettings?.authorization.state === 'authorized' ||
    personalOperationSettings?.authorization.state === 'expired'
      ? personalOperationSettings.authorization
      : undefined;
  const personalGithubAccountId = personalAuthorization?.githubAccountId;
  const personalGithubProfile = personalAuthorization?.profile;

  const handleConnectGitHub = useCallback(async () => {
    if (!canManage) {
      toast.error(t('settings.integrations.github.adminRequired'));
      return;
    }
    if (!currentWorkspaceId) {
      console.error('Workspace ID missing when attempting to connect GitHub');
      return;
    }
    if (!authedWorkspaceId) {
      toast.info(
        t(
          'settings.integrations.github.authRefreshing',
          'Refreshing your session. Please try again in a moment.'
        )
      );
      return;
    }

    const githubAppName = import.meta.env.VITE_GITHUB_APP_NAME || 'lodyai';
    const isElectron = isElectronRenderer();
    const popup = isElectron ? null : window.open('', '_blank');
    setConnectingToGitHub(true);

    try {
      const { state } = await createGitHubInstallState({
        workspaceId: authedWorkspaceId,
        workspaceSlug: currentWorkspaceSlug ?? undefined,
        returnTarget: isElectron ? 'desktop' : 'web',
      });
      const installUrl = `https://github.com/apps/${githubAppName}/installations/new?state=${encodeURIComponent(state)}`;
      let openedExternally = false;
      if (isElectron) {
        openedExternally = await openExternalUrl(installUrl);
        if (!openedExternally) {
          throw new Error(
            t('settings.integrations.github.connectFailed', 'Failed to start GitHub installation')
          );
        }
      } else if (popup) {
        popup.opener = null;
        popup.location.href = installUrl;
        openedExternally = true;
      } else {
        openedExternally = await openExternalUrl(installUrl);
      }

      if (!openedExternally) {
        window.location.assign(installUrl);
      }
    } catch (err) {
      popup?.close();
      const message = getConvexErrorMessage(
        err,
        t('settings.integrations.github.connectFailed', 'Failed to start GitHub installation')
      );
      toast.error(message);
    } finally {
      setConnectingToGitHub(false);
    }
  }, [
    authedWorkspaceId,
    canManage,
    createGitHubInstallState,
    currentWorkspaceId,
    currentWorkspaceSlug,
    getConvexErrorMessage,
    t,
  ]);

  const handleToggleRepo = useCallback(
    async (repoFullName: string, enabled: boolean) => {
      if (!authedWorkspaceId) return;

      // Optimistic update
      setOptimisticToggles((prev) => ({ ...prev, [repoFullName]: enabled }));

      try {
        await setRepoEnabled({
          workspaceId: authedWorkspaceId,
          repoFullName,
          enabled,
        });
      } catch (err) {
        // Revert optimistic update
        setOptimisticToggles((prev) => {
          const next = { ...prev };
          delete next[repoFullName];
          return next;
        });
        const message = getConvexErrorMessage(err, 'Failed to update repository');
        toast.error(message);
      }
    },
    [authedWorkspaceId, getConvexErrorMessage, setRepoEnabled]
  );

  useEffect(() => {
    if (!authedWorkspaceId) return;
    if (personalAuthorizationState !== 'authorized') return;
    if (personalGithubProfile?.login) return;
    const key = `${authedWorkspaceId}:${personalGithubAccountId ?? 'unknown'}`;
    if (!claimAutomaticCommand(`github-profile-refresh:${key}`)) return;
    void refreshPersonalGitHubProfile({ workspaceId: authedWorkspaceId }).catch((error) => {
      getConvexErrorMessage(error, 'Failed to refresh GitHub profile.');
    });
  }, [
    authedWorkspaceId,
    claimAutomaticCommand,
    currentWorkspaceId,
    getConvexErrorMessage,
    personalAuthorizationState,
    personalGithubAccountId,
    personalGithubProfile,
    refreshPersonalGitHubProfile,
  ]);

  const handleTogglePersonalIdentity = useCallback(
    async (enabled: boolean) => {
      if (!authedWorkspaceId) return;
      setUpdatingPersonalPreference(true);
      try {
        await setPersonalOperationPreference({
          workspaceId: authedWorkspaceId,
          enabled,
        });
        // Cached write app tokens must not survive a personal identity toggle.
        invalidateGitHubTokensForWorkspace(authedWorkspaceId);
      } catch (err) {
        const message = getConvexErrorMessage(
          err,
          t('settings.integrations.github.personalIdentityUpdateFailed', 'Update failed')
        );
        toast.error(message);
      } finally {
        setUpdatingPersonalPreference(false);
      }
    },
    [authedWorkspaceId, getConvexErrorMessage, setPersonalOperationPreference, t]
  );

  const handleAuthorizePersonalGitHub = useCallback(async () => {
    if (!authedWorkspaceId || !canAuthorizePersonalGitHub) return;
    setAuthorizingPersonalGitHub(true);
    try {
      if (authorizeInBrowser) {
        const opened = await openExternalUrl(
          getPersonalGitHubAuthorizationUrl(currentWorkspaceSlug!)
        );
        if (!opened) {
          throw new Error(
            t('settings.integrations.github.personalIdentityAuthFailed', 'Authorization failed')
          );
        }
        setAuthorizingPersonalGitHub(false);
        return;
      }
      await authorizePersonal();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : t('settings.integrations.github.personalIdentityAuthFailed', 'Authorization failed');
      toast.error(message);
      setAuthorizingPersonalGitHub(false);
    }
  }, [
    authorizePersonal,
    authedWorkspaceId,
    authorizeInBrowser,
    canAuthorizePersonalGitHub,
    currentWorkspaceSlug,
    t,
  ]);

  return (
    <div id="github" {...stylex.props(styles.page)}>
      {/* GitHub App section: identity card + connect action. The
           "Connect" Button is a row-level child like the iOS Settings
           "Connect Account" affordance, and we surface the admin-only
           hint as the row's helper text when the user can't manage. */}
      <MobileSettingsSection title={t('settings.tabs.github')}>
        <MobileSettingsRowGroup>
          <MobileSettingsRow
            label={
              <div {...stylex.props(mobileSurface.identity)}>
                <div {...stylex.props(mobileSurface.identityTile, styles.identityTileStrong)}>
                  <Github {...stylex.props(mobileSurface.identityGlyph)} />
                </div>
                <span {...stylex.props(mobileSurface.identityLabel, styles.identityName)}>
                  GitHub App
                </span>
              </div>
            }
            helper={!canManage ? t('settings.integrations.github.adminOnlyHint') : undefined}
          >
            {canManage ? (
              <Button
                size="small"
                onClick={() => {
                  void handleConnectGitHub();
                }}
                disabled={showGitHubConnectSpinner || !workspaceAuthReady}
              >
                {showGitHubConnectSpinner ? <Spinner className="h-3.5 w-3.5" /> : null}
                {t('settings.integrations.github.connect')}
                {!showGitHubConnectSpinner ? (
                  <ArrowUpRight {...stylex.props(styles.buttonArrow)} />
                ) : null}
              </Button>
            ) : undefined}
          </MobileSettingsRow>
        </MobileSettingsRowGroup>
      </MobileSettingsSection>

      {/* Personal identity. The toggle row owns the on/off state and
           the row's helper text mirrors the desktop card's lead line.
           When enabled, the authorization status panel is appended
           below the row inside the same card so the card visually
           groups "the preference + its consequence". */}
      <MobileSettingsSection
        title={t('settings.integrations.github.personalIdentitySection', 'Personal Identity')}
      >
        <MobileSettingsRowGroup>
          <MobileSettingsRow
            label={t(
              'settings.integrations.github.personalIdentityRowLabel',
              'Act as me on GitHub'
            )}
            helper={t(
              'settings.integrations.github.personalIdentityDescription',
              'Act as you for PRs, comments, and merges.'
            )}
          >
            {updatingPersonalPreference ? (
              <Spinner className="h-4 w-4 text-muted-foreground" />
            ) : (
              <Switch
                checked={personalIdentityEnabled}
                onCheckedChange={(checked) => {
                  void handleTogglePersonalIdentity(checked);
                }}
                disabled={
                  !workspaceAuthReady ||
                  personalOperationSettings === undefined ||
                  (!canAuthorizePersonalGitHub &&
                    personalAuthorizationState !== 'authorized' &&
                    !personalIdentityEnabled)
                }
              />
            )}
          </MobileSettingsRow>
        </MobileSettingsRowGroup>
        {personalIdentityEnabled ? (
          <div {...stylex.props(styles.identityPanel)}>
            <GitHubPersonalIdentitySettingsCard
              enabled={personalIdentityEnabled}
              authorizationState={personalAuthorizationState}
              githubAccountId={personalGithubAccountId}
              profile={personalGithubProfile}
              settingsLoading={personalOperationSettings === undefined}
              updating={updatingPersonalPreference}
              authorizing={authorizingPersonalGitHub}
              workspaceReady={workspaceAuthReady}
              canAuthorize={canAuthorizePersonalGitHub}
              onToggle={(checked) => {
                void handleTogglePersonalIdentity(checked);
              }}
              onAuthorize={() => {
                void handleAuthorizePersonalGitHub();
              }}
            />
          </div>
        ) : null}
      </MobileSettingsSection>

      {/* Authorized repositories — the heading carries the enabled/
           total count chip (analogous to the desktop badge). The search
           input + repo rows live inside the same rounded card so the
           list reads as one continuous group. We drop the desktop
           ScrollArea: on mobile the outer settings layout already owns
           a scroll region, and a nested scroller would trap gestures. */}
      <MobileSettingsSection
        title={t('settings.integrations.github.authorizedReposTitle', 'Authorized Repositories')}
        actions={
          repos.length > 0 ? (
            <Badge>
              {searchQuery && filteredRepos.length !== repos.length
                ? `${filteredRepos.length} / ${repos.length}`
                : `${enabledCount} / ${repos.length}`}{' '}
              {t('settings.integrations.github.repoBadge')}
            </Badge>
          ) : undefined
        }
      >
        {repos.length > 5 ? (
          <div {...stylex.props(styles.searchBar)}>
            <div {...stylex.props(styles.searchField)}>
              <Search {...stylex.props(styles.searchIcon)} />
              <Input
                type="search"
                value={repoSearch}
                onChange={(event) => setRepoSearch(event.target.value)}
                placeholder={t('repos.search')}
                className="rounded-md border border-input-border/70 bg-input-field pl-9 shadow-none"
              />
            </div>
          </div>
        ) : null}
        {workspaceReposLoading ? (
          <div {...stylex.props(styles.notice)}>
            <Spinner className="h-4 w-4" />
            {t('settings.integrations.github.loading')}
          </div>
        ) : repos.length === 0 ? (
          <div {...stylex.props(styles.emptyNotice)}>
            {t(
              'settings.integrations.github.noAuthorizedRepos',
              'No repositories authorized yet. Install the GitHub App to get started.'
            )}
          </div>
        ) : filteredRepos.length === 0 ? (
          <div {...stylex.props(styles.emptyNotice)}>
            {t('settings.integrations.github.noRepos')}
          </div>
        ) : (
          <MobileSettingsRowGroup>
            {filteredRepos.map((repo) => (
              <MobileSettingsRow
                key={repo.repoFullName}
                className={!canManage || !workspaceAuthReady ? 'opacity-60' : undefined}
                label={
                  <div {...stylex.props(styles.repoIdentity)}>
                    <Book {...stylex.props(styles.repoIcon)} />
                    <span {...stylex.props(mobileSurface.identityLabel, styles.identityName)}>
                      {repo.repoFullName}
                    </span>
                    {repo.private && <Badge>{t('settings.integrations.github.private')}</Badge>}
                  </div>
                }
              >
                <Switch
                  checked={repo.enabled}
                  onCheckedChange={(checked) => {
                    void handleToggleRepo(repo.repoFullName, checked);
                  }}
                  disabled={!canManage || !workspaceAuthReady}
                />
              </MobileSettingsRow>
            ))}
          </MobileSettingsRowGroup>
        )}
      </MobileSettingsSection>

      <p {...stylex.props(styles.hint)}>
        {t('settings.integrations.github.missingReposHint')}{' '}
        <a
          href="https://github.com/settings/installations"
          target="_blank"
          rel="noreferrer"
          {...stylex.props(styles.hintLink)}
          onClick={(event) => {
            if (isElectronRenderer()) {
              event.preventDefault();
              void openExternalUrl('https://github.com/settings/installations');
            }
          }}
        >
          {t('settings.integrations.github.missingReposHintAction')}
          <ArrowUpRight {...stylex.props(styles.hintIcon)} />
        </a>
      </p>
    </div>
  );
}
