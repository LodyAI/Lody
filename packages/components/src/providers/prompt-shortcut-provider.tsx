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
import { LoroRepo } from 'loro-repo';
import { IndexedDBStorageAdaptor } from 'loro-repo/storage/indexeddb';
import {
  LocalShortcutStore,
  PromptShortcutRuntime,
  PromptShortcutSync,
  shortcutByteLength,
  type ShortcutRuntimeSnapshot,
} from '@lody/shared/prompt-shortcuts';
import {
  useCloudAction,
  useCloudMutation,
  useCloudQuery,
  usePlatform,
  usePlatformSession,
} from '@lody/platform/react';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { cloudOperations as api } from '@/lib/cloud-api-operations';
import { promptShortcutDatabaseName } from '@/lib/prompt-shortcut-storage';
import { useResolvedWorkspaceScope } from '@/hooks/use-resolved-workspace-scope';

const Context = createContext<{
  runtime: PromptShortcutRuntime | null;
  error?: unknown;
  retry?: () => void;
}>({ runtime: null });
const EMPTY: ShortcutRuntimeSnapshot = { entries: [], pendingIds: [], errors: {}, loading: true };
const noopSubscribe = () => () => {};
const emptySnapshot = () => EMPTY;
// StrictMode and a quick workspace return must finish the previous writer's
// durable writes before reopening the same IndexedDB as a new replica.
const closingDatabases = new Map<string, Promise<void>>();

export function usePromptShortcuts() {
  const { runtime, error, retry } = useContext(Context);
  const snapshot = useSyncExternalStore(
    runtime?.subscribe ?? noopSubscribe,
    runtime?.getSnapshot ?? emptySnapshot,
    emptySnapshot
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
  const workspaceId =
    scope.enabled && scope.workspaceId === workspaceRuntime?.workspaceId ? scope.workspaceId : null;
  const cloud = platform.capabilities.has('cloudAccount');
  const stage = useCloudMutation(api.promptShortcuts.stageDocument);
  const activate = useCloudMutation(api.promptShortcuts.activateDocument);
  const revoke = useCloudMutation(api.promptShortcuts.revokeShortcut);
  const grant = useCloudAction(api.promptShortcuts.getStreamToken);
  const directory = useCloudQuery(
    api.promptShortcuts.listAccessibleDocuments,
    cloud && workspaceId && userId ? { workspaceId } : 'skip'
  );
  const current = useRef({ workspaceId, userId, stage, activate, revoke, grant });
  current.current = { workspaceId, userId, stage, activate, revoke, grant };
  const [generation, setGeneration] = useState(0);
  const [instance, setInstance] = useState<{
    runtime: PromptShortcutRuntime;
    generation: number;
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
    instance.generation === generation
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
        identity.status !== 'authenticated' ||
        identity.user.id !== userId
      )
        throw new Error('Shortcut identity changed');
    };
    const opening = (async () => {
      await previousClose;
      check();
      repo = await LoroRepo.create({
        storageAdapter: new IndexedDBStorageAdaptor({
          dbName: databaseName,
        }),
      });
      check();
      const store = await LocalShortcutStore.open({ repo, workspaceId, userId });
      const sync = cloud
        ? new PromptShortcutSync({
            repo,
            now: Date.now,
            grant: async (resource, write) => {
              check();
              const result = await current.current.grant({
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
              stage: async ({ entry }) => {
                check();
                await current.current.stage({
                  workspaceId,
                  ownerUserId: userId,
                  shortcutId: entry.id,
                  bodyDocId: entry.bodyDocId,
                  visibility: entry.visibility,
                });
                check();
              },
              activate: async ({ entry, published }) => {
                check();
                await current.current.activate({
                  workspaceId,
                  bodyDocId: entry.bodyDocId,
                  previousBodyDocId: published?.bodyDocId ?? null,
                  previousRevision: published?.revision ?? null,
                  revision: entry.revision,
                  slug: entry.slug,
                  indexBytes: shortcutByteLength(JSON.stringify(entry)),
                });
                check();
              },
              revoke: async (entry) => {
                check();
                await current.current.revoke({ workspaceId, shortcutId: entry.id });
                check();
              },
              dispose: () => sync.dispose(),
            }
          : undefined
      );
      check();
      setInstance({ runtime: owned, generation });
      void owned.flush();
    })().catch((error) => {
      if (!disposed) {
        console.error('Failed to open Prompt Shortcuts', error);
        setFailure({ workspaceId, userId, generation, error });
      }
    });
    return () => {
      disposed = true;
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
  }, [workspaceId, userId, cloud, platform, generation]);

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
        retry: () => setGeneration((value) => value + 1),
      }}
    >
      {children}
    </Context.Provider>
  );
}
