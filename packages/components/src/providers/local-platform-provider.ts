import {
  createLocalPlatformProvider,
  createStore,
  createStaticStore,
  type MutableStore,
  type PlatformProvider,
  type PlatformSessionState,
  type ReadonlyStore,
  type WorkspaceSummary,
  type WorkspacesState,
} from '@lody/platform';
import { useStoreValue } from '@lody/platform/react';
import { isLocalAppPlatform } from '@/lib/app-platform';
import { getIpcServices } from '@/lib/electron-ipc-client';

/**
 * Renderer-side assembly of the open-source local `PlatformProvider`
 * (specs/platform-providers.md). The CLI provisions the single implicit
 * workspace (D-O14) and the Electron main process surfaces it over
 * `getIpcServices()?.localPlatform.getSnapshot()`; this module polls that bridge until
 * the CLI publishes one atomic identity/workspace snapshot. Both provider
 * stores transition together so renderer writes and CLI access checks use the
 * same durable synthetic installation identity.
 */

/** Fallback slug for workspace routes while the implicit workspace has none. */
export const LOCAL_WORKSPACE_FALLBACK_SLUG = 'local';

const IMPLICIT_WORKSPACE_POLL_INTERVAL_MS = 500;

let cachedProvider: PlatformProvider | null = null;
let cachedSessionStore: MutableStore<PlatformSessionState> | null = null;
let cachedWorkspacesStore: MutableStore<WorkspacesState> | null = null;
let snapshotPollingStarted = false;
let retrySnapshot: (() => void) | undefined;

const CLOUD_WORKSPACES_STORE: ReadonlyStore<WorkspacesState> = createStaticStore({
  status: 'loading',
} as WorkspacesState);

function startLocalPlatformSnapshotPolling(
  sessionStore: MutableStore<PlatformSessionState>,
  workspacesStore: MutableStore<WorkspacesState>
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = 1_000;
  let inFlight = false;
  let settled = false;
  const poll = async (): Promise<void> => {
    if (inFlight || settled) {
      return;
    }
    clearTimeout(timer);
    inFlight = true;
    let delay = IMPLICIT_WORKSPACE_POLL_INTERVAL_MS;
    try {
      const snapshot = await getIpcServices()?.localPlatform.getSnapshot();
      if (!snapshot) {
        return;
      }
      const workspace = snapshot.workspace;
      const summary: WorkspaceSummary = {
        id: workspace.workspaceId,
        name: workspace.name,
        slug: workspace.slug,
        role: workspace.role,
      };
      sessionStore.set({
        status: 'authenticated',
        user: { id: snapshot.userId, name: 'Local' },
      });
      workspacesStore.set({
        status: 'ready',
        workspaces: [summary],
        activeWorkspaceId: summary.id,
      });
      settled = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      workspacesStore.set({ status: 'error', message });
      delay = retryDelay;
      retryDelay = Math.min(retryDelay * 2, 30_000);
      console.error('local-platform: bootstrap snapshot failed', error);
    } finally {
      inFlight = false;
      if (!settled) timer = setTimeout(() => void poll(), delay);
    }
  };
  void poll();
  return () => void poll();
}

function getLocalWorkspacesStore(): MutableStore<WorkspacesState> {
  if (!cachedWorkspacesStore) {
    cachedWorkspacesStore = createStore<WorkspacesState>({ status: 'loading' });
  }
  return cachedWorkspacesStore;
}

function getLocalSessionStore(): MutableStore<PlatformSessionState> {
  if (!cachedSessionStore) {
    cachedSessionStore = createStore<PlatformSessionState>({ status: 'loading' });
  }
  return cachedSessionStore;
}

function ensureLocalPlatformSnapshotPolling(): void {
  if (snapshotPollingStarted) return;
  snapshotPollingStarted = true;
  const sessionStore = getLocalSessionStore();
  const workspacesStore = getLocalWorkspacesStore();
  retrySnapshot = startLocalPlatformSnapshotPolling(sessionStore, workspacesStore);
}

/** Retry only the snapshot read; concurrent callers share the active read. */
export function retryLocalPlatformSnapshot(): void {
  if (isLocalAppPlatform()) retrySnapshot?.();
}

/**
 * The one local `PlatformProvider` instance of this renderer. Only call on the
 * local platform (root route mounts `PlatformContext` behind
 * `isLocalAppPlatform()`); the first call starts the implicit-workspace poll.
 */
export function getLocalPlatformProvider(): PlatformProvider {
  if (!cachedProvider) {
    const sessionStore = getLocalSessionStore();
    const workspacesStore = getLocalWorkspacesStore();
    cachedProvider = createLocalPlatformProvider({
      session: sessionStore,
      workspaces: workspacesStore,
    });
    ensureLocalPlatformSnapshotPolling();
  }
  return cachedProvider;
}

/**
 * The implicit local workspace, or null while the CLI has not provisioned it
 * (and always null on the cloud platform, without starting any polling).
 * Usable outside `PlatformContext` — the runtime provider mounts above the
 * route tree that provides the context.
 */
export function useImplicitLocalWorkspace(): WorkspaceSummary | null {
  const state = useLocalPlatformWorkspacesState();
  return state.status === 'ready' ? (state.workspaces[0] ?? null) : null;
}

/** Bootstrap state for route-level loading/error handling. */
export function useLocalPlatformWorkspacesState(): WorkspacesState {
  if (isLocalAppPlatform()) {
    ensureLocalPlatformSnapshotPolling();
  }
  const store = isLocalAppPlatform() ? getLocalWorkspacesStore() : CLOUD_WORKSPACES_STORE;
  return useStoreValue(store);
}

/** Route slug of the implicit local workspace. */
export function getLocalWorkspaceSlug(workspace: WorkspaceSummary): string {
  return workspace.slug ?? LOCAL_WORKSPACE_FALLBACK_SLUG;
}
