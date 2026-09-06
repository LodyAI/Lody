import type { ReactNode } from 'react';
import { AccountProfileList } from './account-profile-list';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import type { AgentConfigId, MachineId, SessionId } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { currentWorkspaceIdAtom } from '@/atoms/workspace-context';
import { Button } from '@/ui/button';
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
    <div className="flex flex-wrap items-center gap-2 px-3 py-1 text-xs">
      <label>
        {t('agents.accounts.account', 'Account')}{' '}
        <select
          className="rounded border bg-input-field px-2 py-1"
          aria-label={t('agents.accounts.account', 'Account')}
          value={currentId}
          disabled={target.enabled === false || loading || switching || target.busy}
          onChange={(event) => void change(event.target.value)}
        >
          {!profiles.some((profile) => profile.accountProfileId === currentId) && (
            <option value={currentId}>
              {currentId === 'system-default'
                ? t('agents.accounts.systemDefault', 'System Default')
                : t('agents.accounts.unavailable', 'Unavailable account')}
            </option>
          )}
          {profiles.map((profile) => (
            <option key={profile.accountProfileId} value={profile.accountProfileId}>
              {profile.accountProfileId === 'system-default'
                ? t('agents.accounts.systemDefault', 'System Default')
                : profile.label}
              {profile.identity ? ` — ${profile.identity}` : ''}
            </option>
          ))}
        </select>
      </label>
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
