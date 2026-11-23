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
import {
  promptShortcutDatabaseName,
  registerPromptShortcutDatabase,
} from '@/lib/prompt-shortcut-storage';
import { useResolvedWorkspaceScope } from '@/hooks/use-resolved-workspace-scope';

const Context = createContext<{
  runtime: PromptShortcutRuntime | null;
  error?: unknown;
  retry?: () => void;
  disabled?: boolean;
  canWrite?: boolean;
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
  const { runtime, error, retry, disabled, canWrite } = useContext(Context);
  const snapshot = useSyncExternalStore(
    runtime?.subscribe ?? noopSubscribe,
    runtime?.getSnapshot ?? (disabled ? disabledSnapshot : emptySnapshot),
    disabled ? disabledSnapshot : emptySnapshot
  );
  return {
    runtime,
    canWrite: canWrite ?? true,
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
  const encrypted = workspaceRuntime?.contentMode === 'e2ee';
  const streamsContent = workspaceRuntime?.streamsContent;
  const localDataScope = workspaceRuntime?.localDataScope;
  const waitForContentAdmission = workspaceRuntime?.waitForContentAdmission;
  const shortcutRole = workspaceRuntime?.shortcutRole;
  const canWrite =
    useSyncExternalStore(
      shortcutRole?.subscribe ?? noopSubscribe,
      shortcutRole?.get ?? (() => (encrypted ? 'read' : 'write'))
    ) === 'write';
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
    (!cloud || (!auth?.confirmedUnauthenticated && (encrypted || legacyStatus === 'allowed'))) &&
    scope.enabled &&
    scope.workspaceId === workspaceRuntime?.workspaceId
      ? scope.workspaceId
      : null;
  const revoke = useLegacyWorkspaceMutation(api.promptShortcuts.revokeShortcut);
  const grant = useLegacyWorkspaceAction(api.promptShortcuts.getStreamToken);
  const attempt = useLegacyWorkspaceAction(api.promptShortcuts.getStreamTokenV2);
  const directory = useLegacyWorkspaceQuery(
    api.promptShortcuts.listAccessibleDocuments,
    !encrypted && cloudSyncEnabled && workspaceId && userId ? { workspaceId } : 'skip'
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
    shortcutRole,
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
    shortcutRole,
  };
  const [generation, setGeneration] = useState(0);
  const [instance, setInstance] = useState<{
    runtime: PromptShortcutRuntime;
    generation: number;
    platform: typeof platform;
    cloud: boolean;
    streamsContent: typeof streamsContent;
    localDataScope: typeof localDataScope;
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
    instance.streamsContent === streamsContent &&
    instance.localDataScope === localDataScope &&
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
    if (encrypted && (!cloudSyncEnabled || !localDataScope || streamsContent?.mode !== 'protected'))
      return undefined;
    const databaseName = promptShortcutDatabaseName(
      workspaceId,
      userId,
      encrypted ? localDataScope : undefined
    );
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
      if (encrypted) await waitForContentAdmission?.();
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
            content: encrypted ? streamsContent! : { mode: 'plaintext' },
            canWrite: () => !encrypted || current.current.shortcutRole?.get() === 'write',
            repo,
            now: Date.now,
            grant: async (resource, write, force) => {
              check();
              if (encrypted && write && current.current.shortcutRole?.get() !== 'write')
                throw new Error('e2ee_shortcuts_read_only');
              if (resource.kind === 'workspace-index' || resource.kind === 'workspace-body') {
                const getWorkspaceGrant = current.current.getWorkspaceStreamsGrant;
                if (!getWorkspaceGrant) {
                  throw new Error('Workspace Streams grant provider unavailable');
                }
                const result = await getWorkspaceGrant({
                  write,
                  forceRefresh: force,
                });
                check();
                return {
                  ...result,
                  expiresIn: 300,
                  streamId: getShortcutResourceStreamId(resource),
                };
              }
              if (encrypted) throw new Error('e2ee_shortcut_legacy_forbidden');
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
              canWrite: () => !encrypted || current.current.shortcutRole?.get() === 'write',
              acquire: (resource, write) => {
                check();
                return sync.acquire(resource, write);
              },
              ...(!encrypted
                ? {
                    revokeLegacy: async (
                      entry: import('@lody/shared/prompt-shortcuts').PromptShortcutIndexEntry & {
                        visibility: 'private' | 'workspace';
                      }
                    ) => {
                      check();
                      await current.current.revoke({
                        workspaceId,
                        shortcutId: entry.id,
                        bodyDocId: entry.bodyDocId,
                        visibility: entry.visibility,
                      });
                      check();
                    },
                  }
                : {}),
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
        streamsContent,
        localDataScope,
        isActive: () => !disposed && current.current.authSessionId === authSessionId,
      });
      void owned.flush();
    })().catch((error) => {
      if (!disposed) {
        console.error('Failed to open Prompt Shortcuts', error);
        setFailure({ workspaceId, userId, generation, error });
      }
    });
    let closing: Promise<void> | undefined;
    const close = () => {
      if (closing) return closing;
      disposed = true;
      tokenAttempts.dispose();
      setInstance((value) => (value?.runtime === owned ? null : value));
      closing = opening.then(async () => {
        const results = await Promise.allSettled([owned?.dispose()]);
        await repo?.destroy();
        const failed = results.find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      });
      const barrier = closing.catch((error) => {
        console.error('Failed to close Prompt Shortcuts', error);
        closing = undefined;
      });
      closingDatabases.set(databaseName, barrier);
      void barrier.then(() => {
        if (closing) unregister();
        if (closingDatabases.get(databaseName) === barrier) closingDatabases.delete(databaseName);
      });
      return closing;
    };
    const unregister = registerPromptShortcutDatabase(databaseName, close);
    return () => {
      void close().catch(() => undefined);
    };
  }, [
    workspaceId,
    userId,
    authSessionId,
    cloudSyncEnabled,
    platform,
    generation,
    encrypted,
    streamsContent,
    localDataScope,
    waitForContentAdmission,
  ]);

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
        disabled: cloud && !encrypted && legacyStatus === 'blocked',
        canWrite,
        retry: () => setGeneration((value) => value + 1),
      }}
    >
      <PromptShortcutBodyPrefetcher />
      {children}
    </Context.Provider>
  );
}
