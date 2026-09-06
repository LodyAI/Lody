import type { ReactNode } from 'react';
import { AccountProfileList } from './account-profile-list';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import type { AccountProfileSummary, AgentConfigId, MachineId, SessionId } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { currentWorkspaceIdAtom } from '@/atoms/workspace-context';
import { Button } from '@/ui/button';
import { AcpAuthenticationPanel } from './acp-authentication-panel';

type AccountTarget = {
  machineId: MachineId;
  agentType: 'codex' | 'claude';
  configId: AgentConfigId;
};

export function useAccountProfiles(target: AccountTarget) {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const [profileSnapshot, setProfileSnapshot] = useState<{
    key: string;
    profiles: AccountProfileSummary[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { t } = useTranslation();
  const requestStateRef = useRef({ revision: 0 });
  const { machineId, agentType, configId } = target;
  const targetKey = JSON.stringify([workspaceId, machineId, agentType, configId]);
  const profiles = profileSnapshot?.key === targetKey ? profileSnapshot.profiles : [];
  const refresh = useCallback(async () => {
    if (!runtime || !workspaceId) return;
    const requestState = requestStateRef.current;
    const requestRevision = ++requestState.revision;
    setLoading(true);
    setError(null);
    try {
      const response = await runtime.requestAccountProfiles({
        type: 'machine/account-profiles',
        workspaceId,
        machineId,
        cliType: 'builtin',
        agentType,
        configId,
        requestId: crypto.randomUUID(),
        action: 'list',
      });
      if (requestRevision !== requestState.revision) return;
      if (!response?.success)
        throw new Error(
          response?.error ?? t('agents.accounts.statusUnavailable', 'Account status is unavailable')
        );
      setProfileSnapshot({ key: targetKey, profiles: response.profiles ?? [] });
    } catch (cause) {
      if (requestRevision !== requestState.revision) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (requestRevision === requestState.revision) setLoading(false);
    }
  }, [runtime, workspaceId, machineId, agentType, configId, t, targetKey]);
  useEffect(() => {
    const requestState = requestStateRef.current;
    void refresh();
    return () => {
      requestState.revision++;
    };
  }, [refresh]);
  return { runtime, workspaceId, profiles, error, setError, loading, refresh };
}

export function AccountProfilesPanel(
  target: AccountTarget & {
    systemDefaultAuthentication?: ReactNode;
    onBeforeStart?: () => void | Promise<void>;
  }
) {
  const { t } = useTranslation();
  const { runtime, workspaceId, profiles, error, setError, loading, refresh } =
    useAccountProfiles(target);
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
      await refresh();
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
            await refresh();
          }}
        />
      )}
    </div>
  );
}

export function SessionAccountSelector(
  target: AccountTarget & { sessionId: SessionId; accountProfileId?: string; busy?: boolean }
) {
  const { t } = useTranslation();
  const { runtime, workspaceId, profiles, error, setError, loading, refresh } =
    useAccountProfiles(target);
  const [switching, setSwitching] = useState(false);
  const currentId = target.accountProfileId ?? 'system-default';
  const change = async (accountProfileId: string) => {
    if (!runtime || !workspaceId || switching || target.busy || accountProfileId === currentId)
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
          disabled={loading || switching || target.busy}
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
