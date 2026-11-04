import { useCallback, useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import type { AgentConfigId, MachineId } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { LodyAgentAccounts, type LodyAgentCredential } from './lody-agent-accounts';
import {
  LodyAgentCustomProviders,
  type LodyAgentCustomProvider,
  type LodyAgentCustomProviderDraft,
} from './lody-agent-custom-providers';

type ProviderState = {
  status: 'loading' | 'error' | 'unsupported' | 'ready';
  providers: readonly LodyAgentCustomProvider[];
  error?: string;
  removing?: string;
  creating?: boolean;
};

export function LodyAgentAccountsController({
  machineId,
  configId,
  supported,
  refreshVersion,
  onProvidersChanged,
}: {
  machineId: MachineId;
  configId: AgentConfigId;
  supported: boolean;
  refreshVersion: number;
  /**
   * Re-probe the agent after a Provider definition changes. A new Provider only becomes a
   * sign-in method once the capability probe reads it, so saving one is not enough.
   */
  onProvidersChanged?: () => Promise<void>;
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
  const [providerState, setProviderState] = useState<ProviderState>({
    status: 'loading',
    providers: [],
  });
  const generation = useRef(0);
  const providerGeneration = useRef(0);

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

  const refreshProviders = useCallback(async () => {
    const current = ++providerGeneration.current;
    if (!available || !runtime) {
      setProviderState({ status: 'unsupported', providers: [] });
      return;
    }
    setProviderState((previous) => ({ ...previous, status: 'loading', providers: [] }));
    try {
      const result = await runtime.requestLocalSorbetProviders(machineId, {
        method: 'sorbet/providers-list',
        params: { configId },
      });
      if (result.type !== 'sorbet/providers-list') throw new Error('Unexpected response');
      if (providerGeneration.current === current)
        setProviderState({ status: 'ready', providers: result.providers });
    } catch {
      if (providerGeneration.current === current)
        setProviderState({ status: 'error', providers: [] });
    }
  }, [available, runtime, machineId, configId]);

  useEffect(() => {
    const generationRef = generation;
    void refresh();
    return () => {
      generationRef.current++;
    };
  }, [refresh, refreshVersion]);

  useEffect(() => {
    const generationRef = providerGeneration;
    void refreshProviders();
    return () => {
      generationRef.current++;
    };
  }, [refreshProviders, refreshVersion]);

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

  /** A Provider write changes the agent's advertised sign-in methods, not just the list. */
  const reprobeSignIn = async () => {
    if (!onProvidersChanged) return;
    try {
      await onProvidersChanged();
    } catch {
      setProviderState((previous) => ({
        ...previous,
        error: t('lodyAgentProviders.signInRefreshFailed'),
      }));
    }
  };

  const createProvider = async (draft: LodyAgentCustomProviderDraft) => {
    if (!available || !runtime || providerState.creating) return;
    const current = ++providerGeneration.current;
    setProviderState((previous) => ({ ...previous, error: undefined, creating: true }));
    try {
      const result = await runtime.requestLocalSorbetProviders(machineId, {
        method: 'sorbet/providers-create',
        params: { configId, provider: draft },
      });
      if (result.type !== 'sorbet/providers-create') throw new Error('Unexpected response');
      if (providerGeneration.current === current) {
        await refreshProviders();
        await reprobeSignIn();
      }
    } catch {
      if (providerGeneration.current === current) {
        setProviderState((previous) => ({
          ...previous,
          creating: false,
          error: t('lodyAgentProviders.createFailed'),
        }));
        return;
      }
    }
    if (providerGeneration.current === current)
      setProviderState((previous) => ({ ...previous, creating: false }));
  };

  const removeProvider = async (provider: LodyAgentCustomProvider) => {
    if (!available || !runtime || providerState.removing) return;
    const current = ++providerGeneration.current;
    setProviderState((previous) => ({
      ...previous,
      error: undefined,
      removing: provider.id,
    }));
    try {
      const result = await runtime.requestLocalSorbetProviders(machineId, {
        method: 'sorbet/providers-delete',
        params: { configId, providerId: provider.id },
      });
      if (result.type !== 'sorbet/providers-delete') throw new Error('Unexpected response');
      if (providerGeneration.current === current) {
        await refreshProviders();
        await reprobeSignIn();
      }
    } catch {
      if (providerGeneration.current === current)
        setProviderState((previous) => ({
          ...previous,
          removing: undefined,
          error: t('lodyAgentProviders.removeUnknown'),
        }));
    }
  };

  return (
    <>
      <LodyAgentAccounts
        status={available ? state.status : 'unsupported'}
        credentials={available ? state.credentials : []}
        error={state.error}
        removingProviderId={state.removing}
        onRefresh={() => void refresh()}
        onRemove={(credential) => void remove(credential)}
      />
      <LodyAgentCustomProviders
        status={available ? providerState.status : 'unsupported'}
        providers={available ? providerState.providers : []}
        error={providerState.error}
        removingProviderId={providerState.removing}
        creating={providerState.creating}
        onRefresh={() => void refreshProviders()}
        onRemove={(provider) => void removeProvider(provider)}
        onCreate={(draft) => void createProvider(draft)}
      />
    </>
  );
}
