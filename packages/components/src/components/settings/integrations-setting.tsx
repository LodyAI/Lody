import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import {
  AlertCircle,
  Book,
  CheckCircle2,
  Github,
  ArrowUpRight,
  Loader2,
  Lock,
  Search,
} from 'lucide-react';
import { useCloudAction, useCloudMutation } from '@lody/platform/react';
import { useAtomValue } from 'jotai';
import { currentWorkspaceSlugAtom } from '@/atoms';
import { settingContainerClass } from '.';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { cn } from '@/lib/utils';
import { useAppCapability } from '@/lib/app-platform';
import { ScrollArea } from '@/ui/scroll-area';
import { Switch } from '@/ui/switch';
import { Input } from '@/ui/input';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useSettingsDataCache, type SettingsWorkspaceRepoWithStatus } from './settings-data-cache';
import { MobileIntegrationsSettings } from '@/components/mobile/mobile-integrations-settings';
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
  settingsLoading = false,
  updating = false,
  authorizing = false,
  workspaceReady = true,
  canAuthorize = true,
  onToggle,
  onAuthorize,
}: GitHubPersonalIdentitySettingsCardProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const authorizationReady = authorizationState === 'authorized';
  const avatarFallbackUrl = githubAccountId
    ? `https://avatars.githubusercontent.com/u/${githubAccountId}?v=4`
    : undefined;
  const avatarUrl = profile?.avatarUrl ?? avatarFallbackUrl;

  /* On mobile the card and its toggle row are rendered by the parent
     using `MobileSettingsRowGroup`, so this branch just produces the
     "act-as-you" details panel (only meaningful when enabled). The
     desktop branch keeps the original self-contained rounded card. */
  if (isMobile) {
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
              <p className="truncate text-[0.95rem] font-semibold tracking-tight text-foreground">
                {profile?.login
                  ? `@${profile.login}`
                  : t('settings.integrations.github.personalIdentityAuthorized', 'Connected')}
              </p>
            ) : (
              <>
                <p className="text-[0.9rem] font-medium text-foreground">
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
            variant="ghost"
            size="small"
            className="shrink-0 self-start sm:self-auto"
            onClick={onAuthorize}
            disabled={!workspaceReady || authorizing}
          >
            {authorizing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Github className="h-3.5 w-3.5" />
            )}
            {t('settings.integrations.github.personalIdentityAuthorize', 'Authorize')}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="pt-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium leading-tight text-foreground">
            {t('settings.integrations.github.personalIdentityRowLabel', 'Act as you')}
          </p>
          <p className="mt-1 text-xs leading-tight text-muted-foreground">
            {t(
              'settings.integrations.github.personalIdentityDescription',
              'Act as you for PRs, comments, and merges.'
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center">
          {updating ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <Switch
              checked={enabled}
              onCheckedChange={onToggle}
              disabled={
                !workspaceReady ||
                settingsLoading ||
                (!canAuthorize && !authorizationReady && !enabled)
              }
            />
          )}
        </div>
      </div>

      {enabled && (
        <div className="mt-3 flex flex-col gap-3 rounded-md bg-foreground/[0.035] px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            {authorizationReady && avatarUrl ? (
              <img
                src={avatarUrl}
                alt=""
                width={40}
                height={40}
                className="h-10 w-10 shrink-0 rounded-full border border-border/70 object-cover"
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
                <p className="truncate text-base font-semibold tracking-tight text-foreground">
                  {profile?.login
                    ? `@${profile.login}`
                    : t('settings.integrations.github.personalIdentityAuthorized', 'Connected')}
                </p>
              ) : (
                <>
                  <p className="text-sm font-medium text-foreground">
                    {t(
                      'settings.integrations.github.personalIdentityNeedsAuth',
                      'Authorization needed'
                    )}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
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
              variant="ghost"
              size="small"
              className="shrink-0"
              onClick={onAuthorize}
              disabled={!workspaceReady || authorizing}
            >
              {authorizing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Github className="h-3.5 w-3.5" />
              )}
              {t('settings.integrations.github.personalIdentityAuthorize', 'Authorize')}
            </Button>
          )}
        </div>
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
    <div className={settingContainerClass}>
      <div id="github" className="space-y-3">
        <div className="rounded-lg bg-foreground/[0.04] p-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/[0.15] text-primary">
                <Github className="h-[1.05rem] w-[1.05rem]" />
              </div>
              <p className="text-sm font-medium text-foreground">GitHub App</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {canManage && (
                <Button
                  variant="ghost"
                  size="small"
                  onClick={() => {
                    void handleConnectGitHub();
                  }}
                  disabled={showGitHubConnectSpinner || !workspaceAuthReady}
                >
                  {showGitHubConnectSpinner ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : null}
                  {t('settings.integrations.github.connect')}
                  {!showGitHubConnectSpinner ? <ArrowUpRight className="h-3.5 w-3.5" /> : null}
                </Button>
              )}
            </div>
          </div>
          {!canManage && (
            <div className="mt-2 text-xs text-muted-foreground">
              {t('settings.integrations.github.adminOnlyHint')}
            </div>
          )}

          <div className="mt-3 border-t border-border/50">
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
        </div>

        <div className="rounded-lg bg-foreground/[0.03] p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-semibold text-foreground">
              {t('settings.integrations.github.authorizedReposTitle', 'Authorized Repositories')}
            </span>
            {repos.length > 0 && (
              <span className="text-xs tabular-nums text-muted-foreground">
                {searchQuery && filteredRepos.length !== repos.length ? (
                  <>
                    <span className="font-medium text-foreground/80">{filteredRepos.length}</span>
                    {` / ${repos.length} ${t('settings.integrations.github.repoBadge')}`}
                  </>
                ) : (
                  <>
                    <span className="font-medium text-foreground/80">{enabledCount}</span>
                    {` / ${repos.length} ${t('settings.integrations.github.repoBadge')}`}
                  </>
                )}
              </span>
            )}
          </div>

          <div className="mt-3 space-y-2">
            {repos.length > 5 && (
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="search"
                  value={repoSearch}
                  onChange={(event) => setRepoSearch(event.target.value)}
                  placeholder={t('repos.search')}
                  className="rounded-md border-transparent bg-foreground/[0.035] pl-9 shadow-none focus-visible:border-transparent focus-visible:ring-1 focus-visible:ring-foreground/20"
                />
              </div>
            )}
            <ScrollArea
              className="rounded-lg bg-transparent"
              viewportClassName="max-h-[min(40dvh,20rem)] overflow-y-auto overflow-x-hidden overscroll-contain touch-pan-y"
              viewportStyle={{ WebkitOverflowScrolling: 'touch' }}
            >
              {workspaceReposLoading ? (
                <div className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('settings.integrations.github.loading')}
                </div>
              ) : repos.length === 0 ? (
                <div className="p-6 text-sm text-muted-foreground">
                  {t(
                    'settings.integrations.github.noAuthorizedRepos',
                    'No repositories authorized yet. Install the GitHub App to get started.'
                  )}
                </div>
              ) : filteredRepos.length === 0 ? (
                <div className="p-6 text-sm text-muted-foreground">
                  {t('settings.integrations.github.noRepos')}
                </div>
              ) : (
                <div className="space-y-px">
                  {filteredRepos.map((repo) => (
                    <div
                      key={repo.repoFullName}
                      className={cn(
                        'group flex items-center justify-between gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-hover/40',
                        (!canManage || !workspaceAuthReady) && 'opacity-60'
                      )}
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <Book className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate text-sm text-foreground/90">
                          {repo.repoFullName}
                        </span>
                        {repo.private && (
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border/60 px-1.5 py-0 text-[10px] font-medium text-muted-foreground">
                            <Lock className="h-2.5 w-2.5" />
                            {t('settings.integrations.github.private')}
                          </span>
                        )}
                      </div>
                      <Switch
                        checked={repo.enabled}
                        onCheckedChange={(checked) => {
                          void handleToggleRepo(repo.repoFullName, checked);
                        }}
                        disabled={!canManage || !workspaceAuthReady}
                      />
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
            <p className="px-1 text-[11px] leading-relaxed text-muted-foreground/80">
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
        </div>
      </div>
    </div>
  );
}
