import { useEffect, useRef, type ReactNode } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { LODY_PRESENCE_HEARTBEAT_MS, type MachineId, type WorkspaceId } from '@lody/shared';
import { authTokenAtom, runtimeAtom } from '@/atoms/runtime';
import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from '@/atoms';
import { clearDocMetaCacheAtom, docMetaSubscriptionAtom } from '@/atoms/doc-meta';
import {
  clearLodyPresenceStatesAtom,
  setLodyPresenceNowMsAtom,
  setLodyPresenceStatesAtom,
  setLodyPresenceSyncStateAtom,
} from '@/atoms/presence';
import {
  localAgentEnabledAtom,
  localProbeAttemptedAtom,
  localProbeEffectAtom,
  localProbeResultAtom,
} from '@/atoms/local-probe';
import {
  lodyControlConnectionStateAtom,
  runtimeInitializingAtom,
  browserOnlineAtom,
} from '@/atoms/control-connection';
import { API_BASE_URL } from '@/lib/api-base-url';
import { getCachedWorkspaceId } from '@/lib/local-storage-cache';
import { usePostHog } from '@posthog/react';
import { createWorkspaceRuntime } from './create-workspace-runtime';
import { resolveCloudPlatformRuntimePolicy } from './cloud-platform-runtime-policy';
import type { EagerSyncSurface } from './background-sync-coordinator';
import { resolveEffectiveWorkspaceId } from './resolve-effective-workspace-id';
import { useImplicitLocalWorkspace } from './local-platform-provider';
import { capturePostHogEvent } from '@/lib/posthog-analytics';
import { maybeClearLodyCacheOnBoot } from '@/lib/clear-local-cache';
import { isElectronRenderer } from '@/lib/electron';
import { isNativeAppShell } from '@/lib/native-platform';
import { usePlatform } from '@lody/platform/react';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';

const isExpectedRuntimeShutdownError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message === 'Destroyed' || error.message === 'Runtime disposed';
};

const logRuntimeOperationError = (operation: string, error: unknown): void => {
  if (isExpectedRuntimeShutdownError(error)) {
    console.info(`RuntimeProvider: ${operation} skipped during shutdown`);
    return;
  }
  console.error(`RuntimeProvider: ${operation} failed`, error);
};

const resolveRuntimeEagerSyncSurface = (): EagerSyncSurface => {
  if (isElectronRenderer()) {
    return 'desktop';
  }
  if (isNativeAppShell()) {
    return 'mobile';
  }
  return 'web';
};

export function RuntimeProvider({ children }: { children: ReactNode }) {
  const platform = usePlatform();
  // Use workspaceSlug for runtime initialization (available immediately from URL)
  // Use workspaceId for WebSocket connections (requires server response)
  const workspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const localProbeResult = useAtomValue(localProbeResultAtom);
  const localProbeAttempted = useAtomValue(localProbeAttemptedAtom);
  const localAgentEnabled = useAtomValue(localAgentEnabledAtom);
  const token = useAtomValue(authTokenAtom);
  const runtime = useAtomValue(runtimeAtom);
  const setRuntime = useSetAtom(runtimeAtom);
  const setControlConnectionState = useSetAtom(lodyControlConnectionStateAtom);
  const setRuntimeInitializing = useSetAtom(runtimeInitializingAtom);
  const setBrowserOnline = useSetAtom(browserOnlineAtom);
  useAtomValue(docMetaSubscriptionAtom);
  useAtomValue(localProbeEffectAtom);
  const clearDocMetaCache = useSetAtom(clearDocMetaCacheAtom);
  const clearPresenceStates = useSetAtom(clearLodyPresenceStatesAtom);
  const setPresenceStates = useSetAtom(setLodyPresenceStatesAtom);
  const setPresenceNowMs = useSetAtom(setLodyPresenceNowMsAtom);
  const setPresenceSyncState = useSetAtom(setLodyPresenceSyncStateAtom);
  const visibleMachineIndex = useVisibleMachineMetas({
    includeMachineFlock: false,
    syncMachineFlock: false,
  });
  const authorizedMachineIdsRef = useRef<{
    machineIds: ReadonlySet<MachineId>;
    workspaceId: WorkspaceId;
  } | null>(null);
  authorizedMachineIdsRef.current =
    visibleMachineIndex.isLoading || !workspaceId
      ? null
      : {
          workspaceId,
          machineIds: new Set(visibleMachineIndex.convexAuthorizedMachineIds),
        };

  // Routed to PostHog via the runtime's onAnalyticsEvent. Kept in a ref so the
  // (slug/id-keyed) init effect does not re-run when the PostHog client identity changes.
  const postHog = usePostHog();
  const postHogRef = useRef(postHog);
  postHogRef.current = postHog;
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const prevWorkspaceSlugRef = useRef<string | null>(null);
  const prevWorkspaceIdRef = useRef<WorkspaceId | null>(null);

  // Local (open-source) platform: the effective workspace id is the CLI's
  // implicit workspace — no cached/server id arbitration, no auth involved.
  const isLocalPlatform = platform.sync.mode === 'local';
  const telemetryEnabled = platform.capabilities.has('telemetry');
  const implicitLocalWorkspace = useImplicitLocalWorkspace();
  const { ready: localAgentRuntimeReady } = resolveCloudPlatformRuntimePolicy({
    electron: isElectronRenderer(),
    localAgentEnabled,
  });

  // Compute effective workspaceId:
  // - Prefer cached id for the current slug (offline-first, avoids stale auth ids during transitions)
  // - Otherwise, use server/auth id only if it is not stale.
  // This is computed outside effect so it's stable across renders.
  const cachedId = workspaceSlug
    ? (getCachedWorkspaceId(workspaceSlug) as WorkspaceId | null)
    : null;
  const effectiveWorkspaceId = isLocalPlatform
    ? workspaceSlug
      ? ((implicitLocalWorkspace?.id as WorkspaceId | undefined) ?? null)
      : null
    : resolveEffectiveWorkspaceId({
        workspaceSlug,
        cachedWorkspaceId: cachedId,
        serverWorkspaceId: workspaceId,
        prevWorkspaceSlug: prevWorkspaceSlugRef.current,
        prevServerWorkspaceId: prevWorkspaceIdRef.current,
      });
  const effectiveWorkspaceIdSource = isLocalPlatform
    ? effectiveWorkspaceId
      ? 'local-platform'
      : 'pending'
    : effectiveWorkspaceId && cachedId === effectiveWorkspaceId
      ? 'cache'
      : effectiveWorkspaceId && workspaceId === effectiveWorkspaceId
        ? 'server'
        : effectiveWorkspaceId
          ? 'previous'
          : 'pending';
  const workspaceIdResolutionLogRef = useRef({
    cachedWorkspaceId: cachedId,
    serverWorkspaceId: workspaceId,
    workspaceIdSource: effectiveWorkspaceIdSource,
  });
  workspaceIdResolutionLogRef.current = {
    cachedWorkspaceId: cachedId,
    serverWorkspaceId: workspaceId,
    workspaceIdSource: effectiveWorkspaceIdSource,
  };

  useEffect(() => {
    prevWorkspaceSlugRef.current = workspaceSlug;
    prevWorkspaceIdRef.current = workspaceId;
  }, [workspaceId, workspaceSlug]);

  useEffect(() => {
    console.info('RuntimeProvider: workspace id resolution', {
      workspaceSlug,
      cachedWorkspaceId: cachedId,
      serverWorkspaceId: workspaceId,
      effectiveWorkspaceId,
      source: effectiveWorkspaceIdSource,
    });
  }, [cachedId, effectiveWorkspaceId, effectiveWorkspaceIdSource, workspaceId, workspaceSlug]);

  useEffect(() => {
    if (!workspaceSlug || typeof window === 'undefined') {
      return undefined;
    }
    const id = window.setInterval(() => {
      setPresenceNowMs();
    }, LODY_PRESENCE_HEARTBEAT_MS);
    return () => {
      window.clearInterval(id);
    };
  }, [setPresenceNowMs, workspaceSlug]);

  // Initialize runtime when we have a workspaceId (either from cache or server).
  // - If cached id exists for this slug: initialize immediately (offline-first)
  // - Otherwise: wait for server to respond with workspaceId
  useEffect(() => {
    if (!workspaceSlug) {
      console.info('RuntimeProvider: clear runtime due to missing workspaceSlug');
      setRuntime(null);
      setControlConnectionState('idle');
      setRuntimeInitializing(false);
      clearDocMetaCache();
      clearPresenceStates();
      return undefined;
    }

    // Enter a new initialization cycle for this workspace.
    setRuntimeInitializing(true);

    // The Electron main-process setting decides whether cloud desktop uses a
    // dual local-first runtime or a cloud-only control runtime. Wait for that
    // first snapshot so a persisted opt-out never opens the local socket even
    // briefly and never flashes a false reconnecting state.
    if (platform.sync.mode === 'dual' && !localAgentRuntimeReady) {
      setControlConnectionState('idle');
      return undefined;
    }

    // Need workspaceId to initialize (either from cache or server)
    // Keep runtimeInitializing=true while waiting for workspaceId
    if (!effectiveWorkspaceId) {
      const { cachedWorkspaceId, serverWorkspaceId } = workspaceIdResolutionLogRef.current;
      console.info('RuntimeProvider: waiting for workspace id before runtime initialization', {
        workspaceSlug,
        cachedWorkspaceId,
        serverWorkspaceId,
      });
      return undefined;
    }

    let disposed = false;
    let workspaceRuntime: Awaited<ReturnType<typeof createWorkspaceRuntime>> | null = null;
    // Logging-only workspace id resolution inputs intentionally stay out of
    // this effect's dependency list. A cached id can create the runtime before
    // the server id arrives; server-id arrival must not tear down that runtime.
    const { workspaceIdSource } = workspaceIdResolutionLogRef.current;
    setControlConnectionState('idle');

    void (async () => {
      try {
        // If the user requested a cache clear before the last reload, delete all
        // lody* IndexedDB + Cache Storage now — before the runtime opens the repo
        // DB, while nothing holds those databases open. No-op on normal boots.
        await maybeClearLodyCacheOnBoot([
          `lody-loro-repo-db-${effectiveWorkspaceId}`,
          `lody-loro-stream-cursors-${effectiveWorkspaceId}`,
        ]);
        if (disposed) {
          return;
        }
        const eagerSyncSurface = resolveRuntimeEagerSyncSurface();
        console.info('RuntimeProvider: creating workspace runtime', {
          workspaceSlug,
          workspaceId: effectiveWorkspaceId,
          workspaceIdSource,
          eagerSyncSurface,
        });
        workspaceRuntime = await createWorkspaceRuntime({
          workspaceSlug,
          workspaceId: effectiveWorkspaceId,
          apiBaseUrl: API_BASE_URL,
          eagerSyncSurface,
          // Platform assembly is the only authority for room topology. Do not
          // re-probe Electron or cloud configuration inside the runtime.
          syncMode: platform.sync.mode,
          getAuthorizedMachineIds: () => {
            const snapshot = authorizedMachineIdsRef.current;
            return snapshot?.workspaceId === effectiveWorkspaceId ? snapshot.machineIds : null;
          },
          ...(telemetryEnabled
            ? {
                onAnalyticsEvent: (event: {
                  name: string;
                  properties?: Record<string, unknown>;
                }) => {
                  capturePostHogEvent(postHogRef.current, event.name, event.properties);
                },
              }
            : {}),
          onControlConnectionStateChange: (state) => {
            if (disposed) {
              return;
            }
            if (state === 'idle' || state === 'connecting' || state === 'syncing') {
              setControlConnectionState(state);
              return;
            }
            if (state === 'online') {
              setControlConnectionState('online');
              setRuntimeInitializing(false);
              return;
            }
            setControlConnectionState(state);
            setRuntimeInitializing(false);
          },
          onPresenceSnapshot: (states) => {
            if (disposed) {
              return;
            }
            setPresenceStates(states);
          },
          onPresenceSyncStateChange: (state) => {
            if (disposed) {
              return;
            }
            setPresenceSyncState(state);
          },
        });
        if (disposed) {
          try {
            await workspaceRuntime.dispose();
          } catch (error) {
            logRuntimeOperationError('dispose after late initialization', error);
          }
          return;
        }
        setRuntime(workspaceRuntime);
        // Local runtime (IndexedDB-backed Loro repo) is ready — unblock UI
        // rendering immediately. WebSocket sync state is tracked separately
        // via lodyControlConnectionStateAtom.
        setRuntimeInitializing(false);
        const initialAuthToken = tokenRef.current;
        if (initialAuthToken) {
          void workspaceRuntime.setAuthToken(initialAuthToken).catch((error: unknown) => {
            logRuntimeOperationError('start remote sync after local repo ready', error);
          });
        }
        console.info('RuntimeProvider: workspace runtime local repo ready', {
          workspaceSlug,
          workspaceId: effectiveWorkspaceId,
          workspaceIdSource,
        });
      } catch (error) {
        logRuntimeOperationError('runtime initialization', error);
        if (disposed) {
          return;
        }
        setRuntime(null);
        setControlConnectionState('error');
        setRuntimeInitializing(false);
      }
    })();

    return () => {
      console.info('RuntimeProvider: cleanup runtime', {
        workspaceSlug,
      });
      disposed = true;
      setRuntime(null);
      setControlConnectionState('idle');
      // Reset to true for next initialization cycle
      setRuntimeInitializing(true);
      clearDocMetaCache();
      clearPresenceStates();
      if (workspaceRuntime) {
        void workspaceRuntime.dispose().catch((error: unknown) => {
          logRuntimeOperationError('cleanup dispose', error);
        });
      }
    };
  }, [
    clearDocMetaCache,
    clearPresenceStates,
    isLocalPlatform,
    platform.sync.mode,
    setControlConnectionState,
    setRuntimeInitializing,
    setRuntime,
    setPresenceStates,
    setPresenceSyncState,
    telemetryEnabled,
    workspaceSlug,
    effectiveWorkspaceId,
    localAgentRuntimeReady,
  ]);

  useEffect(() => {
    if (!runtime) {
      setControlConnectionState('idle');
      return;
    }
    if (!token) {
      setControlConnectionState('idle');
      void runtime.setAuthToken(null).catch((error: unknown) => {
        logRuntimeOperationError('clear auth token', error);
      });
      return;
    }
    void runtime.setAuthToken(token).catch((error: unknown) => {
      logRuntimeOperationError('set auth token', error);
    });
  }, [runtime, setControlConnectionState, token]);

  useEffect(() => {
    if (!runtime || !localProbeAttempted) {
      return;
    }
    runtime.setLocalMachineId((localProbeResult?.machineId ?? null) as MachineId | null);
  }, [localProbeAttempted, localProbeResult?.machineId, runtime]);

  // Listen for browser online/offline events and update the browserOnlineAtom
  useEffect(() => {
    const handleOnline = () => setBrowserOnline(true);
    const handleOffline = () => setBrowserOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [setBrowserOnline]);

  return children;
}
