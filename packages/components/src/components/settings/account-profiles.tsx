import type { ReactNode } from 'react';
import { AccountProfileList } from './account-profile-list';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import type { AgentConfigId, MachineId, SessionId } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { currentWorkspaceIdAtom } from '@/atoms/workspace-context';
import { Button } from '@/ui/button';
import { ChevronDown, Loader2, UserRound } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { AcpAuthenticationPanel } from './acp-authentication-panel';
import {
  EMPTY_ACCOUNT_PROFILE_STATUS,
  getAccountProfileStatusStore,
  type AccountProfileStatusStore,
} from './account-profile-status';

type AccountTarget = {
  machineId: MachineId;
  agentType: 'codex' | 'claude';
  configId: AgentConfigId;
};

const subscribeToNoStatus = () => () => {};
const getEmptyStatus = () => EMPTY_ACCOUNT_PROFILE_STATUS;

export function useAccountProfiles(target: AccountTarget, enabled = true) {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const [operationError, setOperationError] = useState<{
    store: AccountProfileStatusStore | null;
    value: string | null;
  } | null>(null);
  const { t } = useTranslation();
  const { machineId, agentType, configId } = target;
  const store = useMemo(
    () =>
      enabled && runtime && workspaceId
        ? getAccountProfileStatusStore(runtime, { workspaceId, machineId, agentType, configId })
        : null,
    [enabled, runtime, workspaceId, machineId, agentType, configId]
  );
  const snapshot = useSyncExternalStore(
    store?.subscribe ?? subscribeToNoStatus,
    store?.getSnapshot ?? getEmptyStatus,
    getEmptyStatus
  );
  const setError = useCallback(
    (value: string | null) => setOperationError({ store, value }),
    [store]
  );
  const refresh = useCallback(async () => {
    setOperationError(null);
    await store?.refresh({ force: true });
  }, [store]);
  const refreshAfterMutation = useCallback(async () => {
    setOperationError(null);
    await store?.refresh({ invalidate: true });
  }, [store]);
  useEffect(() => {
    void store?.refresh();
  }, [store]);
  const error =
    operationError?.store === store && operationError.value !== null
      ? operationError.value
      : snapshot.error
        ? (snapshot.error.message ??
          t('agents.accounts.statusUnavailable', 'Account status is unavailable'))
        : null;
  return {
    runtime,
    workspaceId,
    profiles: snapshot.profiles,
    error,
    setError,
    loading: snapshot.loading,
    refresh,
    refreshAfterMutation,
  };
}

export function AccountProfilesPanel(
  target: AccountTarget & {
    systemDefaultAuthentication?: ReactNode;
    onBeforeStart?: () => void | Promise<void>;
  }
) {
  const { t } = useTranslation();
  const {
    runtime,
    workspaceId,
    profiles,
    error,
    setError,
    loading,
    refresh,
    refreshAfterMutation,
  } = useAccountProfiles(target);
  const [loginProfile, setLoginProfile] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const add = async () => {
    if (!runtime || !workspaceId || creating) return;
    setCreating(true);
    setError(null);
    try {
      await target.onBeforeStart?.();
      const response = await runtime.requestAccountProfiles({
        type: 'machine/account-profiles',
        workspaceId,
        machineId: target.machineId,
        cliType: 'builtin',
        agentType: target.agentType,
        configId: target.configId,
        requestId: crypto.randomUUID(),
        action: 'create',
        label: t('agents.accounts.additional', 'Account {{number}}', { number: profiles.length }),
      });
      if (!response?.success)
        throw new Error(
          response?.error ?? t('agents.accounts.createFailed', 'Could not add account')
        );
      const added = response.profiles?.find(
        (profile) =>
          profile.accountProfileId !== 'system-default' &&
          !profiles.some((existing) => existing.accountProfileId === profile.accountProfileId)
      );
      if (added) setLoginProfile(added.accountProfileId);
      await refreshAfterMutation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  };
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {t('agents.accounts.defaultHint', 'System Default follows your normal CLI login.')}
      </p>
      <AccountProfileList
        profiles={profiles}
        onSignIn={setLoginProfile}
        systemDefaultAuthentication={target.systemDefaultAuthentication}
      />
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <Button size="sm" variant="outline" disabled={loading || creating} onClick={() => void add()}>
        {t('agents.accounts.add', '+ Add account')}
      </Button>
      {error && (
        <Button size="sm" variant="ghost" onClick={() => void refresh()}>
          {t('common.retry', 'Retry')}
        </Button>
      )}
      {loginProfile && (
        <AcpAuthenticationPanel
          key={loginProfile}
          machineId={target.machineId}
          configId={target.configId}
          agentType={target.agentType}
          cliType="builtin"
          accountProfileId={loginProfile}
          onBeforeStart={target.onBeforeStart}
          compact
          onAuthenticated={async () => {
            setLoginProfile(null);
            await refreshAfterMutation();
          }}
        />
      )}
    </div>
  );
}

export function SessionAccountSelector(
  target: AccountTarget & {
    sessionId: SessionId;
    accountProfileId?: string;
    busy?: boolean;
    enabled?: boolean;
  }
) {
  const { t } = useTranslation();
  const { runtime, workspaceId, profiles, error, setError, loading, refresh } = useAccountProfiles(
    target,
    target.enabled
  );
  const [switching, setSwitching] = useState(false);
  const currentId = target.accountProfileId ?? 'system-default';
  const currentProfile = profiles.find((profile) => profile.accountProfileId === currentId);
  const currentLabel =
    currentId === 'system-default'
      ? t('agents.accounts.systemDefault', 'System Default')
      : (currentProfile?.label ?? t('agents.accounts.unavailable', 'Unavailable account'));
  const disabled = target.enabled === false || loading || switching || target.busy;
  const accountLabel = t('agents.accounts.account', 'Account');
  const change = async (accountProfileId: string) => {
    if (
      !runtime ||
      !workspaceId ||
      target.enabled === false ||
      switching ||
      target.busy ||
      accountProfileId === currentId
    )
      return;
    setSwitching(true);
    setError(null);
    try {
      const response = await runtime.requestSessionAccountSwitch({
        type: 'session/account-switch',
        workspaceId,
        machineId: target.machineId,
        sessionId: target.sessionId,
        requestId: crypto.randomUUID(),
        accountProfileId,
      });
      if (!response?.success)
        throw new Error(
          response?.error ?? t('agents.accounts.switchFailed', 'Could not switch account')
        );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSwitching(false);
    }
  };
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1 text-xs">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 min-w-0 max-w-full gap-1.5 rounded-md border border-border/60 bg-background px-2 text-xs font-normal text-muted-foreground hover:bg-hover hover:text-foreground"
            aria-label={`${accountLabel}: ${currentLabel}`}
            aria-busy={loading || switching}
            title={
              target.busy
                ? t(
                    'agents.accounts.busyHint',
                    'Accounts can be switched when the session is idle.'
                  )
                : currentProfile?.identity
            }
            disabled={disabled}
          >
            {loading || switching ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
            ) : (
              <UserRound className="size-3.5 shrink-0" aria-hidden="true" />
            )}
            <span className="truncate">{currentLabel}</span>
            <ChevronDown className="size-3 shrink-0 text-muted-foreground/70" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          sideOffset={6}
          aria-label={accountLabel}
          className="w-[min(19rem,calc(100vw-1rem))] min-w-0"
        >
          <div className="flex items-center justify-between gap-3 px-3 py-2">
            <span className="text-xs font-medium">{accountLabel}</span>
            <span className="text-xs text-muted-foreground">
              {target.agentType === 'codex' ? 'Codex' : 'Claude'}
            </span>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup value={currentId} onValueChange={(value) => void change(value)}>
            {!currentProfile && (
              <DropdownMenuRadioItem value={currentId} disabled className="py-2">
                <span className="min-w-0 break-words text-xs">{currentLabel}</span>
              </DropdownMenuRadioItem>
            )}
            {profiles.map((profile) => {
              const label =
                profile.accountProfileId === 'system-default'
                  ? t('agents.accounts.systemDefault', 'System Default')
                  : profile.label;
              return (
                <DropdownMenuRadioItem
                  key={profile.accountProfileId}
                  value={profile.accountProfileId}
                  disabled={disabled}
                  textValue={`${label} ${profile.identity ?? ''}`}
                  className="items-start py-2 [&>span:first-child]:top-2.5"
                >
                  <span className="min-w-0 flex-1 space-y-0.5">
                    <span className="block break-words text-xs font-medium leading-4">{label}</span>
                    {profile.identity && (
                      <span className="block break-all text-xs leading-4 text-muted-foreground">
                        {profile.identity}
                      </span>
                    )}
                    <span className="block text-[11px] leading-4 text-muted-foreground">
                      {profile.status === 'authenticated'
                        ? t('agents.accounts.authenticated', 'Signed in')
                        : profile.status === 'unauthenticated'
                          ? t('agents.accounts.unauthenticated', 'Sign-in required')
                          : t('agents.accounts.unknown', 'Status unavailable')}
                    </span>
                  </span>
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {switching && (
        <span role="status">{t('agents.accounts.switching', 'Switching account…')}</span>
      )}
      {error && (
        <>
          <span role="alert" className="text-destructive">
            {error}
          </span>
          <Button size="sm" variant="ghost" onClick={() => void refresh()}>
            {t('common.retry', 'Retry')}
          </Button>
        </>
      )}
    </div>
  );
}
