import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { AlertCircle, CheckCircle2, Github } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import { useCloudAction, useCloudMutation } from '@lody/platform/react';
import { useAtomValue } from 'jotai';
import { currentWorkspaceSlugAtom } from '@/atoms';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { useAppCapability } from '@/lib/app-platform';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from '@/lib/toast';
import { useSettingsDataCache, type SettingsWorkspaceRepoWithStatus } from './settings-data-cache';
import { MobileIntegrationsSettings } from '@/components/mobile/mobile-integrations-settings';
import { GitHubSettingsView } from './github-settings-view';
import { isElectronRenderer } from '@/lib/electron';
import { openExternalUrl } from '@/lib/native-browser';
import { useAuthClient } from '../../providers/convex-provider';
import { canRunAuthedWorkspaceQuery } from '@/lib/authed-convex-query';
import { invalidateGitHubTokensForWorkspace } from '@/lib/github-token';
import { useIsMobile } from '@/hooks/use-mobile';
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

export type GitHubPersonalIdentityAuthorizationState = 'missing' | 'authorized' | 'expired';

export type GitHubPersonalIdentityProfile = {
  login: string;
  name?: string;
  avatarUrl?: string;
  htmlUrl?: string;
};

export type GitHubPersonalIdentitySettingsCardProps = {
  enabled: boolean;
  authorizationState: GitHubPersonalIdentityAuthorizationState;
  githubAccountId?: string;
  profile?: GitHubPersonalIdentityProfile;
  settingsLoading?: boolean;
  updating?: boolean;
  authorizing?: boolean;
  workspaceReady?: boolean;
  canAuthorize?: boolean;
  onToggle: (enabled: boolean) => void;
  onAuthorize: () => void;
};

export function GitHubPersonalIdentitySettingsCard({
  enabled,
  authorizationState,
  githubAccountId,
  profile,
  authorizing = false,
  workspaceReady = true,
  canAuthorize = true,
  onAuthorize,
}: GitHubPersonalIdentitySettingsCardProps) {
  const { t } = useTranslation();
  const authorizationReady = authorizationState === 'authorized';
  const avatarFallbackUrl = githubAccountId
    ? `https://avatars.githubusercontent.com/u/${githubAccountId}?v=4`
    : undefined;
  const avatarUrl = profile?.avatarUrl ?? avatarFallbackUrl;

  /* Mobile only: the parent renders the toggle row with `MobileSettingsRowGroup`,
     so this is just the "act-as-you" details panel. Desktop draws the identity
     row itself (`GitHubSettingsView`). */
  if (!enabled) return null;
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border/40 bg-background/40 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        {authorizationReady && avatarUrl ? (
          <img
            src={avatarUrl}
            alt=""
            width={40}
            height={40}
            className="h-10 w-10 shrink-0 rounded-full border border-border/40 object-cover"
          />
        ) : (
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-foreground/[0.06] text-muted-foreground">
            {authorizationReady ? (
              <CheckCircle2 className="h-4 w-4" />
            ) : (
              <AlertCircle className="h-4 w-4" />
            )}
          </div>
        )}
        <div className="min-w-0">
          {authorizationReady ? (
            <p className="truncate text-[0.95rem] font-normal tracking-tight text-foreground">
              {profile?.login
                ? `@${profile.login}`
                : t('settings.integrations.github.personalIdentityAuthorized', 'Connected')}
            </p>
          ) : (
            <>
              <p className="text-[0.9rem] font-normal text-foreground">
                {t(
                  'settings.integrations.github.personalIdentityNeedsAuth',
                  'Authorization needed'
                )}
              </p>
              <p className="mt-0.5 truncate text-[0.78rem] text-muted-foreground">
                {t(
                  'settings.integrations.github.personalIdentityMissing',
                  'Authorize to act as you.'
                )}
              </p>
            </>
          )}
        </div>
      </div>
      {!authorizationReady && canAuthorize && (
        <Button
          size="small"
          variant="ghost"
          className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap bg-foreground/[0.06] self-start hover:bg-foreground/[0.1] sm:self-auto"
          onClick={onAuthorize}
          disabled={!workspaceReady || authorizing}
        >
          {authorizing ? <Spinner className="h-3.5 w-3.5" /> : <Github className="h-3.5 w-3.5" />}
          {t('settings.integrations.github.personalIdentityAuthorize', 'Authorize')}
        </Button>
      )}
    </div>
  );
}

/**
 * 集成设置组件
 * 用于管理第三方服务集成，如 GitHub App，支持移动端响应式布局
 */
export function IntegrationsSettingsComponent() {
  // Registry-level gating already hides the GitHub tab without the
  // 'githubIntegration' capability; safety net for deep links in local builds.
  const githubIntegrationAvailable = useAppCapability('githubIntegration');
  if (!githubIntegrationAvailable) {
    return null;
  }
  return <CloudIntegrationsSettings />;
}

function CloudIntegrationsSettings() {
  const { t } = useTranslation();
  const getConvexErrorMessage = useConvexErrorMessage();
  const isMobile = useIsMobile();
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

  // authorize() navigates away to GitHub OAuth, so the start-call promise can't
  // observe success. The OAuth round-trip lands back on this route with
  // ?githubPersonalAuth=1; clear the authorizing spinner once the workspace
  // settings query reports `authorized` for that return. Guarded by a ref to run
  // at most once per return.
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

  if (isMobile) return <MobileIntegrationsSettings />;

  return (
    <GitHubSettingsView
      key={currentWorkspaceId ?? 'none'}
      canManage={canManage}
      workspaceReady={workspaceAuthReady}
      connecting={showGitHubConnectSpinner}
      onConnect={() => {
        void handleConnectGitHub();
      }}
      identity={{
        enabled: personalIdentityEnabled,
        authorizationState: personalAuthorizationState,
        githubAccountId: personalGithubAccountId,
        profile: personalGithubProfile,
        settingsLoading: personalOperationSettings === undefined,
        updating: updatingPersonalPreference,
        authorizing: authorizingPersonalGitHub,
        workspaceReady: workspaceAuthReady,
        canAuthorize: canAuthorizePersonalGitHub,
        onToggle: (checked) => {
          void handleTogglePersonalIdentity(checked);
        },
        onAuthorize: () => {
          void handleAuthorizePersonalGitHub();
        },
      }}
      repos={repos}
      reposLoading={workspaceReposLoading}
      onToggleRepo={(repoFullName, enabled) => {
        void handleToggleRepo(repoFullName, enabled);
      }}
    />
  );
}
