import { LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION } from '@lody/shared';
import { jsonValueEqual } from './json-value-equal';
import { warnCodeCollab, describeCodeCollabError } from './code-collab-debug';
import type { LocalLoroDataPlaneConnection } from '@lody/shared/local-loro-transport';
import type {
  CodeCollabFileIndexLoadState,
  CodeCollabFileIndexResource,
} from './code-collab-file-index-cache';

type Resource = CodeCollabFileIndexResource & { dispose(): Promise<void> };

/** Read-only JSON projection. No Flock/Repo acquisition or renderer persistence. */
export function openNativeCodeCollabFileIndexResource(options: {
  readonly connection: LocalLoroDataPlaneConnection;
  readonly workspaceId: string;
  readonly ownerSessionId: string;
  readonly onFailure: () => void;
}): Promise<Resource | null> {
  const { connection, workspaceId, ownerSessionId } = options;
  const peerId = `native-file-index:${crypto.randomUUID()}`;
  const resourceKey = {};
  const listeners = new Set<() => void>();
  let state: CodeCollabFileIndexLoadState = { status: 'loading' };
  let connected = false;
  let disposed = false;
  let requestId = '';
  let revision = 0;
  let native = false;
  let trustedSeed: Extract<CodeCollabFileIndexLoadState, { status: 'ready' }> | undefined;
  let admitted = true;
  let terminal = false;
  let settled = false;
  let resolve!: (resource: Resource | null) => void;
  let reject!: (error: unknown) => void;
  const opened = new Promise<Resource | null>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const publish = (next: CodeCollabFileIndexLoadState) => {
    if (disposed) return;
    state = next;
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        warnCodeCollab('native file-index listener failed', {
          error: describeCodeCollabError(error),
        });
      }
    }
  };
  const fail = (error: unknown, transient = false, terminalError = false) => {
    terminal ||= terminalError;
    options.onFailure();
    if (transient && admitted) publish(trustedSeed ?? { status: 'error', error });
    else {
      trustedSeed = undefined;
      admitted = false;
      publish({ status: 'error', error });
    }
    if (!settled) {
      settled = true;
      clearTimeout(timer);
      reject(error);
      cleanup();
    }
  };
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    unsubscribeMessage();
    unsubscribeStatus();
    listeners.clear();
    if (connected && requestId)
      connection.send({
        type: 'detach',
        protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
        workspaceId,
        peerId,
      });
  };
  const resource: Resource = {
    backend: 'native',
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    seed(fileIndex, updatedAtMs) {
      if (!admitted || !connected || disposed) return;
      if (state.status === 'ready' && jsonValueEqual(state.snapshot.fileIndex, fileIndex)) {
        // Matching filesystem rows confirm the projection without discarding
        // the native generation siblings used to invalidate diff caches.
        trustedSeed = state;
        return;
      }
      // This is the current binding's validated filesystem RPC response. It may
      // arrive after an older native cache frame; it is never renderer storage.
      trustedSeed = {
        status: 'ready',
        snapshot: { resourceKey, fileIndex, updatedAtMs, revision: ++revision },
      };
      publish(trustedSeed);
    },
    async dispose() {
      cleanup();
    },
  };
  // Bound negotiation only. A missing native capability is an explicit legacy
  // reply; timeout/disconnect never authorizes a fallback writer or cloud route.
  const timer = setTimeout(
    () => fail(new Error('Local file-index observation timed out.')),
    10_000
  );
  const unsubscribeMessage = connection.onMessage((message) => {
    if (message.type === 'pong') {
      if (disposed || !connected || requestId) return;
      if (message.nativeFileIndexSnapshots !== true) {
        if (native) return fail(new Error('Local file-index capability changed.'));
        settled = true;
        clearTimeout(timer);
        resolve(null);
        cleanup();
        return;
      }
      requestId = crypto.randomUUID();
      connection.send({
        type: 'file-index-observe',
        protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
        workspaceId,
        peerId,
        requestId,
        ownerSessionId,
      });
      return;
    }
    if (
      disposed ||
      !connected ||
      !('workspaceId' in message) ||
      message.workspaceId !== workspaceId ||
      !('peerId' in message) ||
      message.peerId !== peerId ||
      !('requestId' in message) ||
      message.requestId !== requestId
    )
      return;
    if (message.type === 'file-index-observed') {
      if (message.ownerSessionId !== ownerSessionId) return;
      if (message.backend === 'legacy') {
        if (native) return fail(new Error('Local file-index ownership changed.'));
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(null);
          cleanup();
        }
        return;
      }
      native = true;
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(resource);
      }
    } else if (message.type === 'file-index-snapshot' && native && !terminal) {
      if (message.ownerSessionId !== ownerSessionId) return;
      if (message.state.status === 'ready') {
        if (
          state.status === 'ready' &&
          jsonValueEqual(state.snapshot.fileIndex, message.state.fileIndex) &&
          jsonValueEqual(state.snapshot.generations, message.state.generations)
        )
          return;
        const next: Extract<CodeCollabFileIndexLoadState, { status: 'ready' }> = {
          status: 'ready',
          snapshot: {
            resourceKey,
            fileIndex: message.state.fileIndex,
            generations: message.state.generations,
            updatedAtMs: message.state.updatedAtMs,
            revision: ++revision,
          },
        };
        trustedSeed =
          trustedSeed && jsonValueEqual(trustedSeed.snapshot.fileIndex, next.snapshot.fileIndex)
            ? next
            : undefined;
        publish(next);
      } else if (message.state.status === 'loading') {
        publish(trustedSeed ?? { status: 'loading' });
      } else
        fail(
          new Error(`Local file-index unavailable: ${message.state.code}`),
          message.state.code === 'native_file_index_unavailable',
          message.state.code === 'access_denied' || message.state.code === 'retired'
        );
    } else if (message.type === 'error') {
      fail(
        new Error(`Local file-index observation rejected: ${message.code}`),
        false,
        message.code === 'access_denied' || message.code === 'retired'
      );
    }
  });
  let unsubscribeStatus = () => {};
  const changeStatus = (next: boolean) => {
    if (disposed || connected === next) return;
    connected = next;
    trustedSeed = undefined;
    admitted = next;
    if (next) terminal = false;
    publish({ status: 'loading' });
    requestId = '';
    if (next) {
      connection.send({ type: 'ping', protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION });
    }
  };
  unsubscribeStatus = connection.onStatusChange(changeStatus);
  if (disposed) unsubscribeStatus();
  changeStatus(connection.isConnected());
  return opened;
}
