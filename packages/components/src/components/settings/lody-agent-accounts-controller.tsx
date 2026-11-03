import { useCallback, useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import type { AgentConfigId, MachineId } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { LodyAgentAccounts, type LodyAgentCredential } from './lody-agent-accounts';

export function LodyAgentAccountsController({
  machineId,
  configId,
  supported,
  refreshVersion,
}: {
  machineId: MachineId;
  configId: AgentConfigId;
  supported: boolean;
  refreshVersion: number;
}) {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const { t } = useTranslation();
  const available = supported && !!runtime;
  const [state, setState] = useState<{
    status: 'loading' | 'error' | 'unsupported' | 'ready';
    credentials: readonly LodyAgentCredential[];
    error?: string;
    removing?: string;
  }>({ status: 'loading', credentials: [] });
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    if (!available || !runtime) {
      setState({ status: 'unsupported', credentials: [] });
      return;
    }
    setState({ status: 'loading', credentials: [] });
    try {
      const result = await runtime.requestLocalSorbetCredentials(machineId, {
        method: 'sorbet/credentials-list',
        params: { configId },
      });
      if (result.type !== 'sorbet/credentials-list') throw new Error('Unexpected response');
      if (generation.current === current)
        setState({ status: 'ready', credentials: result.credentials });
    } catch {
      if (generation.current === current) setState({ status: 'error', credentials: [] });
    }
  }, [available, runtime, machineId, configId]);
  useEffect(() => {
    const generationRef = generation;
    void refresh();
    return () => {
      generationRef.current++;
    };
  }, [refresh, refreshVersion]);
  const remove = async (credential: LodyAgentCredential) => {
    if (!available || !runtime || state.removing) return;
    const current = ++generation.current;
    setState((previous) => ({ ...previous, error: undefined, removing: credential.providerId }));
    try {
      const result = await runtime.requestLocalSorbetCredentials(machineId, {
        method: 'sorbet/credentials-logout',
        params: { configId, providerId: credential.providerId },
      });
      if (result.type !== 'sorbet/credentials-logout') throw new Error('Unexpected response');
      if (generation.current === current) await refresh();
    } catch {
      if (generation.current === current)
        setState((previous) => ({
          ...previous,
          removing: undefined,
          error: t('lodyAgentAccounts.removeUnknown'),
        }));
    }
  };
  return (
    <LodyAgentAccounts
      status={available ? state.status : 'unsupported'}
      credentials={available ? state.credentials : []}
      error={state.error}
      removingProviderId={state.removing}
      onRefresh={() => void refresh()}
      onRemove={(credential) => void remove(credential)}
    />
  );
}
