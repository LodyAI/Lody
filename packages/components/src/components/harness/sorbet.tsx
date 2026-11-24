/*
 * The bridge between the drawn harness and the real Sorbet agent. Sorbet owns
 * credentials and custom providers on its machine; Lody reads them over
 * Machine RPC (`sorbet/credentials-*`, `sorbet/providers-*`) and mirrors the
 * descriptors into the harness store so every panel can render them. Secrets
 * never cross the wire — a credential here is `{ providerId, type }`, and a
 * key the user types goes through the protected authentication interaction
 * into `control.authentication.login()` on the target machine.
 *
 * What the bridge resolves, in order: which machine the page is scoped to,
 * which agent config on it is Sorbet (`cliType === 'builtin'`,
 * `agentType === 'sorbet'`, lowest id like the old Lody Agent page), whether
 * the machine speaks the control protocols, then credentials, Providers, and
 * the available model catalog from the shared Sorbet data directory.
 */
import { useAtomValue } from 'jotai';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  machineSupportsProtocolCapability,
  SORBET_PROVIDERS_CATALOG_PROTOCOL_VERSION,
  SORBET_PROVIDERS_UPDATE_PROTOCOL_VERSION,
  type AgentConfigId,
  type AgentConfigMeta,
  type MachineId,
  type MachineViewMeta,
} from '@lody/shared';

import { getAgentConfigsByMachineAtomFamily } from '@/atoms/agents';
import { localMachineIdAtom } from '@/atoms/local-probe';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useMachineFlockAgentConfigsForMachineIds } from '@/hooks/use-machine-flock-agent-configs';
import { useRefreshMachineAcpCapabilities } from '@/hooks/use-refresh-machine-acp-capabilities';

import { useHarnessDevices } from './machines';
import { harness, type EndpointProtocol, type HarnessState } from './store';

/** Where the page's reads and writes land, once resolved. */
export interface SorbetTarget {
  machineId: MachineId;
  configId: AgentConfigId;
  config: AgentConfigMeta;
}

const TargetContext = createContext<SorbetTarget | null>(null);

/** The resolved machine + Sorbet config this page manages; null when unknown. */
export const useSorbetTarget = () => useContext(TargetContext);

const isSorbetConfig = (config: Pick<AgentConfigMeta, 'cliType' | 'agentType'>) =>
  config.cliType === 'builtin' && config.agentType === 'sorbet';

/**
 * What the providers page can say about the machine's store:
 *   loading      — the first read has not answered yet
 *   ready        — credentials and endpoints are what the machine reported
 *   error        — a read failed; the drawn lists are empty, not stale
 *   unsupported  — the machine speaks neither store protocol (older daemon)
 *   no-agent     — no Sorbet config exists on this machine yet
 *   no-runtime   — the workspace runtime is gone, so nothing can be asked
 */
export type SorbetStatus =
  | 'loading'
  | 'ready'
  | 'error'
  | 'unsupported'
  | 'no-agent'
  | 'no-runtime';

/**
 * The machine this page manages is the harness's own device selection
 * (`useHarnessDevices`): the device switcher in the pane header is the one
 * source of truth, so the Providers rows and the scoped pages never disagree
 * about which machine they describe.
 */
export function useHarnessMachine() {
  const { machines, activeDevice, select, isLoading } = useHarnessDevices();
  const machineId = (activeDevice as MachineId | null) ?? null;
  const machine = machineId ? machines.get(machineId) : undefined;
  return { machines, machine, machineId, isLoading, select };
}

/**
 * Whether the machine answers the two Sorbet store protocols. The local
 * daemon uses the direct capability; anything else goes over the encrypted
 * plane, so the remote variant must be present.
 */
export function supportsSorbetStores(machine: MachineViewMeta, localMachineId: MachineId | null) {
  const local = machine.id === localMachineId;
  const supports = (capability: 'sorbetCredentials' | 'sorbetProviders') =>
    machineSupportsProtocolCapability(machine, local ? capability : `${capability}Remote`, 1);
  return (
    machineSupportsProtocolCapability(
      machine,
      local ? 'sorbetProviders' : 'sorbetProvidersRemote',
      SORBET_PROVIDERS_CATALOG_PROTOCOL_VERSION
    ) && supports('sorbetCredentials')
  );
}

/** Whether the machine can edit a stored endpoint in place (`sorbet/providers-update`). */
export function supportsSorbetEndpointEdit(
  machine: MachineViewMeta,
  localMachineId: MachineId | null
) {
  return machineSupportsProtocolCapability(
    machine,
    machine.id === localMachineId ? 'sorbetProviders' : 'sorbetProvidersRemote',
    SORBET_PROVIDERS_UPDATE_PROTOCOL_VERSION
  );
}

/** The wire name for a stored key; the harness calls the same thing `key`. */
const wireMethod = (type: string): HarnessState['credentials'][string]['method'] =>
  type === 'oauth' ? 'oauth' : type === 'local' ? 'local' : 'key';

export interface SorbetActions {
  /** Logout and delete are writes on the machine; a re-read settles them. */
  disconnect: (providerId: string) => Promise<void>;
  createEndpoint: (endpoint: {
    name: string;
    protocol: EndpointProtocol;
    baseUrl: string;
  }) => Promise<string>;
  /** Name, protocol and base URL; Sorbet keeps the endpoint's models. */
  updateEndpoint: (
    providerId: string,
    endpoint: { name: string; protocol: EndpointProtocol; baseUrl: string }
  ) => Promise<void>;
  deleteEndpoint: (providerId: string) => Promise<void>;
  /** A Provider write changes the agent's advertised methods, not just the list. */
  reprobe: () => Promise<void>;
  /** Rediscovers models — every dynamic Provider, or just `providerId` — then re-reads. */
  refresh: (providerId?: string) => Promise<void>;
}

const unavailable = () => Promise.reject(new Error('Lody Agent is unavailable'));
const noopActions: SorbetActions = {
  disconnect: unavailable,
  createEndpoint: unavailable,
  updateEndpoint: unavailable,
  deleteEndpoint: unavailable,
  reprobe: unavailable,
  refresh: async () => {},
};

/**
 * Keeps `state.credentials` and `state.customs` in the harness store in step
 * with what Sorbet reports, and exposes the mutations the rows call. Mounted
 * once at the top of the surface; everything below reads the store.
 */
export function SorbetBridge({ children }: { children: ReactNode }) {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const localMachineId = useAtomValue(localMachineIdAtom);
  const { machines, machine, machineId, isLoading } = useHarnessMachine();
  const machineIds = useMemo(() => [...machines.keys()], [machines]);
  useMachineFlockAgentConfigsForMachineIds(machineIds);
  const configs = useAtomValue(getAgentConfigsByMachineAtomFamily(machineId ?? undefined));
  const refreshCapabilities = useRefreshMachineAcpCapabilities();
  // Bumping this after a sign-in or a mutation re-reads both lists.
  const [version, setVersion] = useState(0);
  const generation = useRef(0);

  const config = useMemo(
    () => configs.filter(isSorbetConfig).sort((a, b) => a.id.localeCompare(b.id))[0],
    [configs]
  );
  const target: SorbetTarget | null =
    machineId && config ? { machineId, configId: config.id, config } : null;
  const supported = !!machine && supportsSorbetStores(machine, localMachineId);

  useEffect(() => {
    const current = ++generation.current;
    // First decide what the rows can even be told, then read — in that order,
    // so a machine switch never leaves a stale list painted as current.
    const empty = {
      credentials: {} as HarnessState['credentials'],
      customs: [] as HarnessState['customs'],
      models: [] as HarnessState['models'],
    };
    if (isLoading) {
      harness.applyRemote({ ...empty, status: 'loading' });
      return;
    }
    if (!machine || !supported) {
      harness.applyRemote({ ...empty, status: 'unsupported' });
      return;
    }
    if (!target) {
      harness.applyRemote({ ...empty, status: 'no-agent' });
      return;
    }
    if (!runtime) {
      harness.applyRemote({ ...empty, status: 'no-runtime' });
      return;
    }
    harness.applyRemote({ ...empty, status: 'loading' });
    void (async () => {
      // Keep the related control reads ordered so the surface commits one
      // coherent generation after a machine switch.
      let credentials: HarnessState['credentials'] | null = null;
      try {
        const result = await runtime.requestLocalSorbetCredentials(target.machineId, {
          method: 'sorbet/credentials-list',
          params: { configId: target.configId },
        });
        if (result.type === 'sorbet/credentials-list') {
          credentials = {};
          for (const credential of result.credentials) {
            credentials[credential.providerId] = {
              provider: credential.providerId,
              // The wire name is `api_key`; anything that is not oauth or
              // local is a stored secret, so the row can say "API key".
              method: wireMethod(credential.type),
              account:
                credential.type === 'oauth'
                  ? 'Signed in'
                  : credential.type === 'local'
                    ? 'Local'
                    : 'API key',
              addedAt: Date.now(),
            };
          }
        }
      } catch {
        // The read failed; the status below reports it.
      }
      if (generation.current !== current) return;
      let customs: HarnessState['customs'] | null = null;
      try {
        const result = await runtime.requestLocalSorbetProviders(target.machineId, {
          method: 'sorbet/providers-list',
          params: { configId: target.configId },
        });
        if (result.type === 'sorbet/providers-list') {
          customs = result.providers.map((provider) => ({
            id: provider.id,
            name: provider.name,
            protocol: provider.protocol as EndpointProtocol,
            baseUrl: provider.baseUrl,
            models: provider.models.map((model) => ({ id: model.id, name: model.name })),
          }));
        }
      } catch {
        // Same: reported through status, not by blanking the page.
      }
      if (generation.current !== current) return;
      let models: HarnessState['models'] | null = null;
      try {
        const result = await runtime.requestLocalSorbetProviders(target.machineId, {
          method: 'sorbet/models-list',
          params: { configId: target.configId },
        });
        if (result.type === 'sorbet/models-list') models = result.models;
      } catch {
        // Model catalog failures are surfaced with the rest of the control read.
      }
      if (generation.current !== current) return;
      harness.applyRemote({
        // A list that failed to read shows nothing rather than stale
        // connections: rows would offer actions on records that may be gone.
        credentials: credentials ?? {},
        customs: customs ?? [],
        models: models ?? [],
        status: credentials && customs && models ? 'ready' : 'error',
      });
    })();
    return () => {
      generation.current++;
    };
  }, [runtime, target?.machineId, target?.configId, supported, isLoading, version]);

  const reread = useCallback(() => setVersion((value) => value + 1), []);

  const machineIdRef = target?.machineId;
  const configIdRef = target?.configId;
  const reprobe = useCallback(async () => {
    if (!runtime || !machineIdRef || !configIdRef) return;
    const response = await refreshCapabilities({ machineId: machineIdRef, configId: configIdRef });
    // A Provider without credentials makes the agent ask for sign-in: that
    // is the expected next step after adding an endpoint, not a failure.
    if (!response.success && !response.authRequired) {
      throw new Error(response.error ?? 'Capability refresh failed');
    }
  }, [runtime, machineIdRef, configIdRef, refreshCapabilities]);
  const actions = useMemo<SorbetActions>(() => {
    if (!runtime || !machineIdRef || !configIdRef) return noopActions;
    const machineId = machineIdRef;
    const configId = configIdRef;
    return {
      disconnect: async (providerId) => {
        try {
          await runtime.requestLocalSorbetCredentials(machineId, {
            method: 'sorbet/credentials-logout',
            params: { configId, providerId },
          });
        } finally {
          // An interrupted logout may still have happened on the machine; a
          // re-read settles the row either way.
          reread();
        }
      },
      createEndpoint: async (endpoint) => {
        const result = await runtime.requestLocalSorbetProviders(machineId, {
          method: 'sorbet/providers-create',
          params: { configId, provider: { ...endpoint, models: [] } },
        });
        if (result.type !== 'sorbet/providers-create') throw new Error('Unexpected response');
        reread();
        return result.provider.id;
      },
      updateEndpoint: async (providerId, endpoint) => {
        try {
          const result = await runtime.requestLocalSorbetProviders(machineId, {
            method: 'sorbet/providers-update',
            params: { configId, providerId, provider: endpoint },
          });
          if (result.type !== 'sorbet/providers-update') throw new Error('Unexpected response');
        } finally {
          reread();
        }
      },
      deleteEndpoint: async (providerId) => {
        let deleted = false;
        try {
          await runtime.requestLocalSorbetProviders(machineId, {
            method: 'sorbet/providers-delete',
            params: { configId, providerId },
          });
          deleted = true;
        } finally {
          // Same uncertainty as logout: the delete may have landed.
          reread();
        }
        // Removing a Provider removes its advertised sign-in method too, so the
        // capability probe runs again — a stale method would offer sign-in to
        // an endpoint that no longer exists.
        if (deleted) {
          try {
            await reprobe();
          } catch {
            // The list is right; the method simply lands on the next probe.
          }
        }
      },
      reprobe,
      refresh: async (providerId) => {
        try {
          await runtime.requestLocalSorbetProviders(machineId, {
            method: 'sorbet/providers-refresh',
            params: providerId ? { configId, providerId } : { configId },
          });
        } finally {
          reread();
        }
      },
    };
  }, [runtime, machineIdRef, configIdRef, reread, reprobe]);

  // Rows call the actions through this ref so an in-flight click never holds a
  // stale machineId after a machine switch.
  useEffect(() => {
    currentActions.current = actions;
    return () => {
      if (currentActions.current === actions) currentActions.current = noopActions;
    };
  }, [actions]);

  return <TargetContext.Provider value={target}>{children}</TargetContext.Provider>;
}

const currentActions: { current: SorbetActions } = { current: noopActions };

/** The resolved RPC actions; safe to call from any row's event handler. */
export const sorbet: SorbetActions = {
  disconnect: (providerId) => currentActions.current.disconnect(providerId),
  createEndpoint: (endpoint) => currentActions.current.createEndpoint(endpoint),
  updateEndpoint: (providerId, endpoint) =>
    currentActions.current.updateEndpoint(providerId, endpoint),
  deleteEndpoint: (providerId) => currentActions.current.deleteEndpoint(providerId),
  reprobe: () => currentActions.current.reprobe(),
  refresh: (providerId) => currentActions.current.refresh(providerId),
};
