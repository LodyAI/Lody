import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import type {
  ArrivalProbe,
  ElectronSorbetOAuthState,
  ImportSourceDescription,
  ImportSourceId,
  ImportSourceResult,
  SorbetConnectApiKeyInput,
  SorbetConnectCustomProviderInput,
  SorbetConnectionSource,
  SorbetConnectResult,
  SorbetImportRequest,
  SorbetStartOAuthInput,
} from '@lody/shared/electron-ipc';
import { cmdUpdateAgentConfigAtom, getAllAgentConfigAtom } from '@/atoms/agents';
import { localMachineIdAtom } from '@/atoms/local-probe';
import { useRefreshMachineAcpCapabilities } from '@/hooks/use-refresh-machine-acp-capabilities';
import { getIpcServices, onIpcEvent } from '@/lib/electron-ipc-client';

const DEFAULT_OAUTH_METHODS: ArrivalProbe['methods'] = [
  { providerId: 'anthropic', providerName: 'Claude', type: 'oauth', name: 'Claude Pro / Max' },
  { providerId: 'openai-codex', providerName: 'ChatGPT', type: 'oauth', name: 'ChatGPT Plus / Pro' },
  { providerId: 'github-copilot', providerName: 'GitHub Copilot', type: 'oauth', name: 'Copilot' },
];

export const EMPTY_ARRIVAL_PROBE: ArrivalProbe = {
  model: {
    kind: 'none',
    methods: DEFAULT_OAUTH_METHODS,
  },
  methods: DEFAULT_OAUTH_METHODS,
  connectedProviders: [],
  models: [],
};

export const IDLE_SORBET_OAUTH_STATE: ElectronSorbetOAuthState = {
  revision: 0,
  attemptId: null,
  providerId: null,
  providerName: null,
  phase: 'idle',
  authorizationUrl: null,
  userCode: null,
  modelSelector: null,
  modelName: null,
  source: null,
  error: null,
};

export type ConnectedModelPayload = {
  providerId: string;
  providerName: string;
  modelSelector: string;
  modelName: string;
  source: SorbetConnectionSource;
};

export interface SorbetOnboardingController {
  probe: ArrivalProbe | null;
  probeLoading: boolean;
  oauthState: ElectronSorbetOAuthState;
  refreshProbe: () => Promise<ArrivalProbe>;
  startOAuth: (input: SorbetStartOAuthInput) => Promise<ElectronSorbetOAuthState>;
  cancelOAuth: () => Promise<void>;
  describeImport: (source: ImportSourceId) => Promise<ImportSourceDescription>;
  runImport: (request: SorbetImportRequest) => Promise<ImportSourceResult>;
  connectApiKey: (input: SorbetConnectApiKeyInput) => Promise<SorbetConnectResult>;
  connectCustomProvider: (input: SorbetConnectCustomProviderInput) => Promise<SorbetConnectResult>;
  disconnectProvider: (providerId: string) => Promise<void>;
  applyDefaultModelSelection: (modelSelector: string) => Promise<void>;
}

const SorbetOnboardingControllerContext = createContext<SorbetOnboardingController | null>(null);

export function SorbetOnboardingControllerProvider({
  value,
  children,
}: {
  value: SorbetOnboardingController;
  children: ReactNode;
}) {
  return (
    <SorbetOnboardingControllerContext.Provider value={value}>
      {children}
    </SorbetOnboardingControllerContext.Provider>
  );
}

/**
 * Syncs the selected default model into the local machine's `sorbet`
 * (`Lody Agent`) `AgentConfigMeta` once that config is visible in the workspace.
 */
function useSyncLocalSorbetDefaultModel() {
  const localMachineId = useAtomValue(localMachineIdAtom);
  const allConfigs = useAtomValue(getAllAgentConfigAtom);
  const updateConfig = useSetAtom(cmdUpdateAgentConfigAtom);
  const refreshCapabilities = useRefreshMachineAcpCapabilities();

  const localSorbetConfig = useMemo(() => {
    const candidates = allConfigs
      .filter((cfg) => cfg.cliType === 'builtin' && cfg.agentType === 'sorbet')
      .sort((a, b) => a.id.localeCompare(b.id));
    if (localMachineId) {
      return candidates.find((cfg) => cfg.machineId === localMachineId) ?? candidates[0] ?? null;
    }
    return candidates[0] ?? null;
  }, [allConfigs, localMachineId]);

  return useCallback(
    async (modelSelector: string) => {
      if (!modelSelector || !localSorbetConfig) return;
      const existingValues = localSorbetConfig.sessionDefaults?.configOptionValues ?? {};
      const nextConfigOptionValues = {
        ...existingValues,
        model: modelSelector,
        ...(existingValues.permission_mode ? {} : { permission_mode: 'ask' }),
      };
      try {
        await updateConfig({
          ...localSorbetConfig,
          sessionDefaults: {
            ...localSorbetConfig.sessionDefaults,
            configOptionValues: nextConfigOptionValues,
          },
        });
        void refreshCapabilities({
          machineId: localSorbetConfig.machineId,
          configId: localSorbetConfig.id,
        }).catch(() => undefined);
      } catch {
        // Non-blocking during early onboarding before workspace runtime is live.
      }
    },
    [localSorbetConfig, refreshCapabilities, updateConfig]
  );
}

export function useDefaultSorbetOnboardingController(): SorbetOnboardingController {
  const [probe, setProbe] = useState<ArrivalProbe | null>(null);
  const [probeLoading, setProbeLoading] = useState<boolean>(true);
  const [oauthState, setOauthState] = useState<ElectronSorbetOAuthState>(IDLE_SORBET_OAUTH_STATE);
  const applyDefaultModelSelection = useSyncLocalSorbetDefaultModel();

  const refreshProbe = useCallback(async (forceRefresh = true): Promise<ArrivalProbe> => {
    const ipc = getIpcServices()?.onboardingSorbet;
    if (!ipc) {
      setProbe(EMPTY_ARRIVAL_PROBE);
      setProbeLoading(false);
      return EMPTY_ARRIVAL_PROBE;
    }
    try {
      const next = await ipc.probeArrival({ forceRefresh });
      // Ensure OAuth methods fallback gracefully if Sorbet catalog returned none.
      const normalized: ArrivalProbe =
        next.methods.some((m) => m.type === 'oauth')
          ? next
          : {
              ...next,
              methods: [...DEFAULT_OAUTH_METHODS, ...next.methods],
              model:
                next.model.kind === 'none'
                  ? { kind: 'none', methods: DEFAULT_OAUTH_METHODS }
                  : next.model,
            };
      setProbe(normalized);
      setProbeLoading(false);
      return normalized;
    } catch {
      setProbe((prev) => prev ?? EMPTY_ARRIVAL_PROBE);
      setProbeLoading(false);
      return EMPTY_ARRIVAL_PROBE;
    }
  }, []);

  useEffect(() => {
    void refreshProbe(false);
  }, [refreshProbe]);

  useEffect(() => {
    const ipc = getIpcServices()?.onboardingSorbet;
    if (!ipc) return undefined;
    let cancelled = false;
    void Promise.resolve(ipc.getAuthState())
      .then((initialState) => {
        if (!cancelled && initialState) {
          setOauthState(initialState);
        }
      })
      .catch(() => undefined);

    const unsubscribe = onIpcEvent('onboardingSorbet.authState', (nextState) => {
      setOauthState(nextState);
      if (nextState.phase === 'authenticated') {
        if (nextState.modelSelector) {
          void applyDefaultModelSelection(nextState.modelSelector);
        }
        void refreshProbe(true);
      }
    });

    // Re-probe when returning from external browser in case OAuth finished across reload.
    const handleFocus = () => {
      void refreshProbe(true);
    };
    window.addEventListener('focus', handleFocus);

    return () => {
      cancelled = true;
      unsubscribe();
      window.removeEventListener('focus', handleFocus);
    };
  }, [applyDefaultModelSelection, refreshProbe]);

  const startOAuth = useCallback(
    async (input: SorbetStartOAuthInput): Promise<ElectronSorbetOAuthState> => {
      const ipc = getIpcServices()?.onboardingSorbet;
      if (!ipc) {
        return oauthState;
      }
      const state = await ipc.startOAuth(input);
      setOauthState(state);
      return state;
    },
    [oauthState]
  );

  const cancelOAuth = useCallback(async () => {
    const ipc = getIpcServices()?.onboardingSorbet;
    if (!ipc) {
      setOauthState(IDLE_SORBET_OAUTH_STATE);
      return;
    }
    const state = await ipc.cancelOAuth();
    setOauthState(state);
  }, []);

  const describeImport = useCallback(
    async (source: ImportSourceId): Promise<ImportSourceDescription> => {
      const ipc = getIpcServices()?.onboardingSorbet;
      if (!ipc) {
        const isMac =
          typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);
        return {
          source,
          systemPromptKind: source === 'claude-code' && isMac ? 'macos-keychain' : 'none',
        };
      }
      return await ipc.describeImport(source);
    },
    []
  );

  const runImport = useCallback(
    async (request: SorbetImportRequest): Promise<ImportSourceResult> => {
      const ipc = getIpcServices()?.onboardingSorbet;
      if (!ipc) {
        return { status: 'not_found', source: request.source };
      }
      const result = await ipc.runImport(request);
      if (result.status === 'imported') {
        if (result.modelSelector) {
          await applyDefaultModelSelection(result.modelSelector);
        }
        void refreshProbe(true);
      }
      return result;
    },
    [applyDefaultModelSelection, refreshProbe]
  );

  const connectApiKey = useCallback(
    async (input: SorbetConnectApiKeyInput): Promise<SorbetConnectResult> => {
      const ipc = getIpcServices()?.onboardingSorbet;
      if (!ipc) {
        return { ok: false, code: 'unknown' };
      }
      const result = await ipc.connectApiKey(input);
      if (result.ok) {
        if (result.modelSelector) {
          await applyDefaultModelSelection(result.modelSelector);
        }
        void refreshProbe(true);
      }
      return result;
    },
    [applyDefaultModelSelection, refreshProbe]
  );

  const connectCustomProvider = useCallback(
    async (input: SorbetConnectCustomProviderInput): Promise<SorbetConnectResult> => {
      const ipc = getIpcServices()?.onboardingSorbet;
      if (!ipc) {
        return { ok: false, code: 'unknown' };
      }
      const result = await ipc.connectCustomProvider(input);
      if (result.ok) {
        if (result.modelSelector) {
          await applyDefaultModelSelection(result.modelSelector);
        }
        void refreshProbe(true);
      }
      return result;
    },
    [applyDefaultModelSelection, refreshProbe]
  );

  const disconnectProvider = useCallback(
    async (providerId: string): Promise<void> => {
      const ipc = getIpcServices()?.onboardingSorbet;
      if (!ipc) return;
      await ipc.disconnectProvider(providerId);
      await refreshProbe(true);
    },
    [refreshProbe]
  );

  return useMemo(
    () => ({
      probe,
      probeLoading,
      oauthState,
      refreshProbe: () => refreshProbe(true),
      startOAuth,
      cancelOAuth,
      describeImport,
      runImport,
      connectApiKey,
      connectCustomProvider,
      disconnectProvider,
      applyDefaultModelSelection,
    }),
    [
      applyDefaultModelSelection,
      cancelOAuth,
      connectApiKey,
      connectCustomProvider,
      describeImport,
      disconnectProvider,
      oauthState,
      probe,
      probeLoading,
      refreshProbe,
      runImport,
      startOAuth,
    ]
  );
}

export function useSorbetOnboardingController(): SorbetOnboardingController {
  const inherited = useContext(SorbetOnboardingControllerContext);
  const fallback = useDefaultSorbetOnboardingController();
  return inherited ?? fallback;
}
