import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import type { AgentConfigId, MachineId } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { FormMessage } from './form-primitives';
import {
  LodyAgentConnections,
  type LodyAgentConnectionRef,
  type LodyAgentCredential,
  type LodyAgentCustomProvider,
  type LodyAgentCustomProviderDraft,
} from './lody-agent-connections';

type ReadStatus = 'loading' | 'error' | 'ready';

type State = {
  credentials: readonly LodyAgentCredential[];
  providers: readonly LodyAgentCustomProvider[];
  credentialsStatus: ReadStatus;
  providersStatus: ReadStatus;
  /**
   * Removals whose outcome is unknown, each with the read generation current when it
   * became unknown. Only a read that started after that can say what happened.
   */
  uncertain: readonly { id: string; since: number }[];
  removing?: string;
};

const INITIAL: State = {
  credentials: [],
  providers: [],
  credentialsStatus: 'loading',
  providersStatus: 'loading',
  uncertain: [],
};

export function LodyAgentConnectionsController({
  machineId,
  configId,
  supported,
  refreshVersion,
  onProvidersChanged,
  signIn,
  endpointSignIn,
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
  /** Sign-in methods drawn inside the connections card. */
  signIn?: (providerIds: readonly string[]) => ReactNode;
  endpointSignIn?: (providerId: string) => ReactNode;
}) {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const { t } = useTranslation();
  const available = supported && !!runtime;
  const [state, setState] = useState<State>(INITIAL);
  const [signInStale, setSignInStale] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * Reads both lists and keeps whatever was shown until the new answer lands: a
   * failed read leaves the last good list in place rather than blanking it. Each list
   * starts its own agent process against one data directory, so they run in turn.
   */
  const read = useCallback(async () => {
    const current = ++generation.current;
    if (!available || !runtime) return;
    setState((previous) => ({
      ...previous,
      credentialsStatus: 'loading',
      providersStatus: 'loading',
    }));
    let credentialsRead: readonly LodyAgentCredential[] | null = null;
    try {
      const result = await runtime.requestLocalSorbetCredentials(machineId, {
        method: 'sorbet/credentials-list',
        params: { configId },
      });
      if (result.type === 'sorbet/credentials-list') credentialsRead = result.credentials;
    } catch {
      // Reported through the status below; the last good list stays.
    }
    if (generation.current !== current) return;
    let providersRead: readonly LodyAgentCustomProvider[] | null = null;
    try {
      const result = await runtime.requestLocalSorbetProviders(machineId, {
        method: 'sorbet/providers-list',
        params: { configId },
      });
      if (result.type === 'sorbet/providers-list') providersRead = result.providers;
    } catch {
      // Reported through the status below; the last good list stays.
    }
    if (generation.current !== current) return;
    setState((previous) => ({
      ...previous,
      credentials: credentialsRead ?? previous.credentials,
      providers: providersRead ?? previous.providers,
      credentialsStatus: credentialsRead ? 'ready' : 'error',
      providersStatus: providersRead ? 'ready' : 'error',
      // A complete read started after a removal became unknown settles it: the row is
      // either gone or still there. An older read cannot.
      uncertain:
        credentialsRead && providersRead
          ? previous.uncertain.filter((entry) => entry.since >= current)
          : previous.uncertain,
    }));
  }, [available, runtime, machineId, configId]);

  useEffect(() => {
    const generationRef = generation;
    void read();
    return () => {
      generationRef.current++;
    };
  }, [read, refreshVersion]);

  /** A Provider write changes the agent's advertised sign-in methods, not just the list. */
  const reprobeSignIn = async () => {
    if (!onProvidersChanged) return;
    try {
      await onProvidersChanged();
      setSignInStale(false);
    } catch {
      setSignInStale(true);
    }
  };

  const remove = async (connection: LodyAgentConnectionRef) => {
    if (!available || !runtime || state.removing) return;
    setState((previous) => ({ ...previous, removing: connection.id }));
    let outcome: 'removed' | 'unknown' = 'removed';
    try {
      if (connection.kind === 'endpoint') {
        const result = await runtime.requestLocalSorbetProviders(machineId, {
          method: 'sorbet/providers-delete',
          params: { configId, providerId: connection.id },
        });
        if (result.type !== 'sorbet/providers-delete') throw new Error('Unexpected response');
      } else {
        const result = await runtime.requestLocalSorbetCredentials(machineId, {
          method: 'sorbet/credentials-logout',
          params: { configId, providerId: connection.id },
        });
        if (result.type !== 'sorbet/credentials-logout') throw new Error('Unexpected response');
      }
    } catch {
      // An interrupted logout or delete may still have happened on the machine, so it
      // is neither retried nor reported as failed; a later read settles it.
      outcome = 'unknown';
    }
    // Reads that ran meanwhile do not own this removal: whatever happened to them, the
    // list stops being busy, and an unknown outcome is kept until a newer read answers it.
    if (!mounted.current) return;
    setState((previous) => ({
      ...previous,
      removing: undefined,
      uncertain:
        outcome === 'unknown'
          ? [
              ...previous.uncertain.filter((entry) => entry.id !== connection.id),
              { id: connection.id, since: generation.current },
            ]
          : previous.uncertain,
    }));
    if (outcome === 'unknown') return;
    await read();
    if (connection.kind === 'endpoint') await reprobeSignIn();
  };

  const create = async (draft: LodyAgentCustomProviderDraft) => {
    if (!available || !runtime) throw new Error('Lody Agent is unavailable');
    const result = await runtime.requestLocalSorbetProviders(machineId, {
      method: 'sorbet/providers-create',
      params: {
        configId,
        provider: {
          name: draft.name,
          protocol: draft.protocol,
          baseUrl: draft.baseUrl,
          models: [],
        },
      },
    });
    if (result.type !== 'sorbet/providers-create') throw new Error('Unexpected response');
    await read();
    await reprobeSignIn();
  };

  const statuses = [state.credentialsStatus, state.providersStatus];
  return (
    <>
      <LodyAgentConnections
        status={
          !available
            ? 'unsupported'
            : statuses.includes('error')
              ? 'error'
              : statuses.includes('loading')
                ? 'loading'
                : 'ready'
        }
        credentials={available ? state.credentials : []}
        providers={available ? state.providers : []}
        uncertainRemovalIds={state.uncertain.map((entry) => entry.id)}
        removingId={state.removing}
        onRetry={() => void read()}
        onRemove={(connection) => void remove(connection)}
        onCreate={create}
        signIn={signIn?.(state.providers.map((provider) => provider.id))}
        endpointSignIn={endpointSignIn}
      />
      {signInStale ? (
        <FormMessage tone="warning">{t('lodyAgentConnections.signInRefreshFailed')}</FormMessage>
      ) : null}
    </>
  );
}
