import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { Badge } from '@/ui/badge';
import { ArrowUpRight, Book, Github, Loader2, Search } from 'lucide-react';
import { useCloudAction, useCloudMutation } from '@lody/platform/react';
import { useAtomValue } from 'jotai';
import { currentWorkspaceSlugAtom } from '@/atoms';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { cn } from '@/lib/utils';
import { useAppCapability } from '@/lib/app-platform';
import { Switch } from '@/ui/switch';
import { Input } from '@/ui/input';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
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
import { useAuthClient } from '../../providers/convex-provider';
import { canRunAuthedWorkspaceQuery } from '@/lib/authed-convex-query';
import { invalidateGitHubTokensForWorkspace } from '@/lib/github-token';
import { GitHubPersonalIdentitySettingsCard } from '@/components/settings/integrations-setting';
import { isNativeAppShell } from '@/lib/native-platform';
import { useAuthenticatedConvex } from '@/hooks/use-authenticated-convex';
import { useCloudQuery } from '@lody/platform/react';
import { useConvexErrorMessage } from '@/hooks/use-convex-error-message';

type GithubSocialAuthOptions = {
  provider: 'github';
  callbackURL: string;
};

type AuthClientWithPersonalGithubAuth = {
  linkSocial?: (options: GithubSocialAuthOptions) => Promise<unknown>;
  signIn: {
    social: (options: GithubSocialAuthOptions) => Promise<unknown>;
  };
};

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
  const authClient = useAuthClient() as unknown as AuthClientWithPersonalGithubAuth;
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
  const workspaceAuthPending =
    Boolean(currentWorkspaceId) && (isConvexAuthLoading || !isConvexAuthenticated);
  const canAuthorizePersonalGitHub = !isElectronRenderer() && !isNativeAppShell();

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

  // The authorize action navigates away to GitHub OAuth, so the start-call
  // promise can't observe success. The OAuth round-trip returns to this route
  // with ?githubPersonalAuth=1; clear the authorizing spinner once the settings
  // query reports `authorized`. See integrations-setting.tsx for the desktop
  // counterpart and rationale.
  const personalAuthSucceededAtRef = useRef<string | null>(null);
  useEffect(() => {
    if (!authedWorkspaceId) return;
    if (personalAuthorizationState !== 'authorized') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('githubPersonalAuth') !== '1') return;
    const dedupeKey = `${authedWorkspaceId}:${personalGithubAccountId ?? 'unknown'}`;
    if (personalAuthSucceededAtRef.current === dedupeKey) return;
    personalAuthSucceededAtRef.current = dedupeKey;
    setAuthorizingPersonalGitHub(false);
  }, [authedWorkspaceId, personalAuthorizationState, personalGithubAccountId]);

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
    const callbackUrl = new URL(window.location.href);
    callbackUrl.searchParams.set('githubPersonalAuth', '1');
    const callbackURL = `${callbackUrl.pathname}${callbackUrl.search}${callbackUrl.hash}`;

    setAuthorizingPersonalGitHub(true);
    try {
      if (typeof authClient.linkSocial === 'function') {
        await authClient.linkSocial({ provider: 'github', callbackURL });
      } else {
        await authClient.signIn.social({ provider: 'github', callbackURL });
      }
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : t('settings.integrations.github.personalIdentityAuthFailed', 'Authorization failed');
      toast.error(message);
      setAuthorizingPersonalGitHub(false);
    }
  }, [authClient, authedWorkspaceId, canAuthorizePersonalGitHub, t]);

  return (
    <div id="github" className="flex flex-col pb-6 pt-1">
      {/* GitHub App section: identity card + connect action. The
           "Connect" Button is a row-level child like the iOS Settings
           "Connect Account" affordance, and we surface the admin-only
           hint as the row's helper text when the user can't manage. */}
      <MobileSettingsSection title={t('settings.tabs.github')}>
        <MobileSettingsRowGroup>
          <MobileSettingsRow
            label={
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/[0.15] text-primary">
                  <Github className="h-[1.05rem] w-[1.05rem]" />
                </div>
                <span className="truncate text-[0.95rem] font-medium text-foreground">
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
                {showGitHubConnectSpinner ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                {t('settings.integrations.github.connect')}
                {!showGitHubConnectSpinner ? <ArrowUpRight className="h-3.5 w-3.5" /> : null}
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
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
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
          <div className="border-t border-border px-3 py-3">
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
            <Badge variant="outline" className="text-[11px]">
              {searchQuery && filteredRepos.length !== repos.length
                ? `${filteredRepos.length} / ${repos.length}`
                : `${enabledCount} / ${repos.length}`}{' '}
              {t('settings.integrations.github.repoBadge')}
            </Badge>
          ) : undefined
        }
      >
        {repos.length > 5 ? (
          <div className="border-b border-border px-3 py-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
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
          <div className="flex items-center justify-center gap-2 px-4 py-6 text-[0.9rem] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('settings.integrations.github.loading')}
          </div>
        ) : repos.length === 0 ? (
          <div className="px-4 py-6 text-[0.9rem] text-muted-foreground">
            {t(
              'settings.integrations.github.noAuthorizedRepos',
              'No repositories authorized yet. Install the GitHub App to get started.'
            )}
          </div>
        ) : filteredRepos.length === 0 ? (
          <div className="px-4 py-6 text-[0.9rem] text-muted-foreground">
            {t('settings.integrations.github.noRepos')}
          </div>
        ) : (
          <MobileSettingsRowGroup>
            {filteredRepos.map((repo) => (
              <MobileSettingsRow
                key={repo.repoFullName}
                className={cn((!canManage || !workspaceAuthReady) && 'opacity-60')}
                label={
                  <div className="flex min-w-0 items-center gap-2">
                    <Book className="h-4 w-4 shrink-0 opacity-70" />
                    <span className="truncate text-[0.95rem] font-medium text-foreground">
                      {repo.repoFullName}
                    </span>
                    {repo.private && (
                      <Badge variant="outline" className="px-1 py-0 text-[10px]">
                        {t('settings.integrations.github.private')}
                      </Badge>
                    )}
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

      <p className="mx-5 mt-2 text-[0.78rem] leading-relaxed text-muted-foreground/80">
        {t('settings.integrations.github.missingReposHint')}{' '}
        <a
          href="https://github.com/settings/installations"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-0.5 text-foreground/80 underline-offset-2 hover:underline"
          onClick={(event) => {
            if (isElectronRenderer()) {
              event.preventDefault();
              void openExternalUrl('https://github.com/settings/installations');
            }
          }}
        >
          {t('settings.integrations.github.missingReposHintAction')}
          <ArrowUpRight className="h-3 w-3" />
        </a>
      </p>
    </div>
  );
}
