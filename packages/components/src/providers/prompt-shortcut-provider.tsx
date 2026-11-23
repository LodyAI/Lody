import { useOptionalAuthenticatedConvex } from '@/hooks/use-authenticated-convex';
import { ShortcutTokenAttempts, shortcutTokenDiagnostic } from '@/lib/shortcut-token-attempt';
import { deferredPostHog } from '@/lib/deferred-posthog';
import { useLegacyWorkspaceQueryStatus } from '@/hooks/use-workspace-feature';
import {
  useLegacyWorkspaceQuery,
  useLegacyWorkspaceMutation,
  useLegacyWorkspaceAction,
} from '@/hooks/use-legacy-workspace-query';
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useAtomValue } from 'jotai';
import type { LoroRepo } from 'loro-repo';
import type { PromptShortcutRuntime, ShortcutRuntimeSnapshot } from '@lody/shared/prompt-shortcuts';
import { getShortcutResourceStreamId } from '@lody/shared/prompt-shortcuts/access';
import { usePlatform, usePlatformSession } from '@lody/platform/react';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { cloudOperations as api } from '@/lib/cloud-api-operations';
import { scheduleIdleTask } from '@/lib/idle-task';
import { promptShortcutDatabaseName } from '@/lib/prompt-shortcut-storage';
import { useResolvedWorkspaceScope } from '@/hooks/use-resolved-workspace-scope';

const Context = createContext<{
  runtime: PromptShortcutRuntime | null;
  error?: unknown;
  retry?: () => void;
  disabled?: boolean;
}>({ runtime: null });
const DISABLED: ShortcutRuntimeSnapshot = {
  entries: [],
  pendingIds: [],
  errors: {},
  loading: false,
};
const disabledSnapshot = () => DISABLED;
const EMPTY: ShortcutRuntimeSnapshot = { entries: [], pendingIds: [], errors: {}, loading: true };
const noopSubscribe = () => () => {};
const emptySnapshot = () => EMPTY;
// StrictMode and a quick workspace return must finish the previous writer's
// durable writes before reopening the same IndexedDB as a new replica.
const closingDatabases = new Map<string, Promise<void>>();

/**
 * Hands settings an already-open runtime. Storybook renders the real Prompts page
 * through this; the product always mounts `PromptShortcutProvider`.
 */
export function PromptShortcutRuntimeProvider({
  runtime,
  children,
}: {
  runtime: PromptShortcutRuntime;
  children: ReactNode;
}) {
  return <Context.Provider value={{ runtime }}>{children}</Context.Provider>;
}

export function usePromptShortcuts() {
  const { runtime, error, retry, disabled } = useContext(Context);
  const snapshot = useSyncExternalStore(
    runtime?.subscribe ?? noopSubscribe,
    runtime?.getSnapshot ?? (disabled ? disabledSnapshot : emptySnapshot),
    disabled ? disabledSnapshot : emptySnapshot
  );
  return {
    runtime,
    ...snapshot,
    ...(error ? { loading: false, errors: { initialization: error } } : {}),
    retry: () => {
      if (runtime) void runtime.retry();
      else retry?.();
    },
  };
}

function PromptShortcutBodyPrefetcher() {
  const { runtime, entries, loading } = usePromptShortcuts();
  useEffect(() => {
    if (!runtime || loading || entries.length === 0) return undefined;
    const controller = new AbortController();
    const cancelIdle = scheduleIdleTask(() => {
      void runtime.prefetch(entries, { signal: controller.signal });
    });
    return () => {
      controller.abort();
      cancelIdle();
    };
  }, [entries, loading, runtime]);
  return null;
}

/** Mounted once by MainLayout, not once per settings panel/composer. */
export function PromptShortcutProvider({
  children,
  enabled,
}: {
  children: ReactNode;
  enabled: boolean;
}) {
  const platform = usePlatform();
  const session = usePlatformSession();
  const workspaceRuntime = useAtomValue(activeWorkspaceRuntimeAtom);

  const scope = useResolvedWorkspaceScope({ enabled });
  const userId = session.status === 'authenticated' ? session.user.id : null;
  const cloud = platform.capabilities.has('cloudAccount');
  const cloudSyncEnabled = cloud && workspaceRuntime?.cloudStreamsEnabled !== false;
  const legacyStatus = useLegacyWorkspaceQueryStatus(scope.workspaceId);
  const auth = useOptionalAuthenticatedConvex();
  const tokenSession = useRef({ userId, id: auth?.authSessionId ?? null });
  // A userless/refetching auth response is not another login or a new outage.
  if (tokenSession.current.userId !== userId || auth?.confirmedUnauthenticated)
    tokenSession.current = { userId, id: auth?.authSessionId ?? null };
  else if (auth?.authSessionId) tokenSession.current.id = auth.authSessionId;
  const authSessionId = tokenSession.current.id;
  const workspaceId =
    (!cloud || (!auth?.confirmedUnauthenticated && legacyStatus === 'allowed')) &&
    scope.enabled &&
    scope.workspaceId === workspaceRuntime?.workspaceId
      ? scope.workspaceId
      : null;
  const revoke = useLegacyWorkspaceMutation(api.promptShortcuts.revokeShortcut);
  const grant = useLegacyWorkspaceAction(api.promptShortcuts.getStreamToken);
  const attempt = useLegacyWorkspaceAction(api.promptShortcuts.getStreamTokenV2);
  const directory = useLegacyWorkspaceQuery(
    api.promptShortcuts.listAccessibleDocuments,
    cloudSyncEnabled && workspaceId && userId ? { workspaceId } : 'skip'
  );
  const current = useRef({
    workspaceId,
    userId,
    revoke,
    grant,
    attempt,
    auth,
    authSessionId,
    getWorkspaceStreamsGrant: workspaceRuntime?.getWorkspaceStreamsGrant,
  });
  current.current = {
    workspaceId,
    userId,
    revoke,
    grant,
    attempt,
    auth,
    authSessionId,
    getWorkspaceStreamsGrant: workspaceRuntime?.getWorkspaceStreamsGrant,
  };
  const [generation, setGeneration] = useState(0);
  const [instance, setInstance] = useState<{
    runtime: PromptShortcutRuntime;
    generation: number;
    platform: typeof platform;
    cloud: boolean;
    isActive: () => boolean;
  } | null>(null);
  const [failure, setFailure] = useState<{
    workspaceId: string;
    userId: string;
    generation: number;
    error: unknown;
  } | null>(null);
  // Render-time identity fencing: never show the old account/workspace for one effect tick.
  const runtime =
    instance?.runtime.workspaceId === workspaceId &&
    instance.runtime.userId === userId &&
    instance.generation === generation &&
    instance.platform === platform &&
    instance.cloud === cloudSyncEnabled &&
    instance.isActive()
      ? instance.runtime
      : null;
  const initializationError =
    failure?.workspaceId === workspaceId &&
    failure.userId === userId &&
    failure.generation === generation
      ? failure.error
      : undefined;

  useEffect(() => {
    if (!workspaceId || !userId) return undefined;
    let disposed = false;
    let owned: PromptShortcutRuntime | undefined;
    let repo: LoroRepo | undefined;
    const databaseName = promptShortcutDatabaseName(workspaceId, userId);
    const previousClose = closingDatabases.get(databaseName);
    const check = () => {
      const identity = platform.identity.session.get();
      if (
        disposed ||
        current.current.workspaceId !== workspaceId ||
        current.current.userId !== userId ||
        current.current.authSessionId !== authSessionId ||
        identity.status !== 'authenticated' ||
        identity.user.id !== userId
      )
        throw new Error('Shortcut identity changed');
    };
    const tokenAttempts = new ShortcutTokenAttempts({
      attempt: (request) => current.current.attempt(request),
      legacy: (request) => current.current.grant(request),
      active: () => {
        const identity = platform.identity.session.get();
        return (
          !disposed &&
          current.current.workspaceId === workspaceId &&
          current.current.userId === userId &&
          current.current.authSessionId === authSessionId &&
          identity.status === 'authenticated' &&
          identity.user.id === userId
        );
      },
      authRejected: () => current.current.auth?.requestAuthRecovery(),
      report: (failure) => {
        const diagnostic = shortcutTokenDiagnostic(failure);
        deferredPostHog.captureException(diagnostic.error, diagnostic.properties);
      },
    });
    const opening = (async () => {
      await previousClose;
      check();
      // This provider file is statically reachable from the boot chunk (the
      // mention textarea imports usePromptShortcuts), so loro-repo and the
      // shortcut Streams stack load only once a workspace/user pair actually
      // needs the shortcut store.
      const [{ LoroRepo }, { IndexedDBStorageAdaptor }, shortcuts] = await Promise.all([
        import('loro-repo'),
        import('loro-repo/storage/indexeddb'),
        import('@lody/shared/prompt-shortcuts'),
      ]);
      const { LocalShortcutStore, PromptShortcutRuntime, PromptShortcutSync } = shortcuts;
      check();
      repo = await LoroRepo.create({
        storageAdapter: new IndexedDBStorageAdaptor({
          dbName: databaseName,
        }),
      });
      check();
      const store = await LocalShortcutStore.open({ repo, workspaceId, userId });
      const sync = cloudSyncEnabled
        ? new PromptShortcutSync({
            content: { mode: 'plaintext' },
            repo,
            now: Date.now,
            grant: async (resource, write, force) => {
              check();
              if (resource.kind === 'workspace-index' || resource.kind === 'workspace-body') {
                const getWorkspaceGrant = current.current.getWorkspaceStreamsGrant;
                if (!getWorkspaceGrant) {
                  throw new Error('Workspace Streams grant provider unavailable');
                }
                const { token, gatewayBaseUrl } = await getWorkspaceGrant({
                  forceRefresh: force,
                });
                check();
                return {
                  token,
                  gatewayBaseUrl,
                  expiresIn: 300,
                  streamId: getShortcutResourceStreamId(resource),
                };
              }
              const result = await tokenAttempts.grant({
                workspaceId,
                write,
                target:
                  resource.kind === 'body'
                    ? resource
                    : {
                        kind: 'index',
                        ownerUserId: resource.domain.ownerUserId,
                        visibility: resource.domain.visibility,
                      },
              });
              check();
              return result;
            },
          })
        : undefined;
      owned = new PromptShortcutRuntime(
        store,
        sync
          ? {
              acquire: (resource, write) => {
                check();
                return sync.acquire(resource, write);
              },
              revokeLegacy: async (entry) => {
                check();
                await current.current.revoke({
                  workspaceId,
                  shortcutId: entry.id,
                  bodyDocId: entry.bodyDocId,
                  visibility: entry.visibility,
                });
                check();
              },
              dispose: () => sync.dispose(),
            }
          : undefined
      );
      check();
      setInstance({
        runtime: owned,
        generation,
        platform,
        cloud: cloudSyncEnabled,
        isActive: () => !disposed && current.current.authSessionId === authSessionId,
      });
      void owned.flush();
    })().catch((error) => {
      if (!disposed) {
        console.error('Failed to open Prompt Shortcuts', error);
        setFailure({ workspaceId, userId, generation, error });
      }
    });
    return () => {
      disposed = true;
      tokenAttempts.dispose();
      // Identity can return before the replacement finishes opening. Retire this
      // effect's instance immediately, even while its durable close is pending.
      setInstance((value) => (value?.runtime === owned ? null : value));
      // Close a late initialization as well; no leaked IndexedDB/Streams leases.
      const closing = opening
        .then(async () => {
          await owned?.dispose();
          await repo?.destroy();
        })
        .catch((error) => console.error('Failed to close Prompt Shortcuts', error));
      closingDatabases.set(databaseName, closing);
      void closing.then(() => {
        if (closingDatabases.get(databaseName) === closing) closingDatabases.delete(databaseName);
      });
    };
  }, [workspaceId, userId, authSessionId, cloudSyncEnabled, platform, generation]);

  useEffect(() => {
    if (runtime && directory) void runtime.setDirectory(directory);
  }, [runtime, directory]);
  useEffect(() => {
    if (!runtime) return undefined;
    const retry = () => {
      void runtime.flush();
      if (directory) void runtime.setDirectory(directory);
    };
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [runtime, directory]);
  return (
    <Context.Provider
      value={{
        runtime,
        error: initializationError,
        disabled: cloud && legacyStatus === 'blocked',
        retry: () => setGeneration((value) => value + 1),
      }}
    >
      <PromptShortcutBodyPrefetcher />
      {children}
    </Context.Provider>
  );
}
