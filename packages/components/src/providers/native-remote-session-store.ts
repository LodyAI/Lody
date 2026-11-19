import type { StorageAdapter } from 'loro-repo';
import type { SessionId } from '@lody/shared';
import {
  createRemoteControlState,
  createRemoteHistoryCommands,
  createRemoteLoroHistoryReader,
  shareObservation,
  type SessionData,
} from '@lody/shared/session-data';
import { sessionDocSchema } from '@lody/shared';
import type { SessionDocState, SessionDocStore } from '@/atoms/runtime';
import { createConversationViewFromReader } from '@/lib/conversation-view/create-conversation-view-from-reader';
import type { CreateConversationViewFromReaderOptions } from '@/lib/conversation-view/create-conversation-view-from-reader';
import { createRendererRemoteSessionPort, migrateRendererLegacyDoc } from './native-workspace-meta';

/** Every root but `history`: small, read whole, refreshed when a path below changes. */
const CONTROL_ROOTS = Object.keys(sessionDocSchema.definition).filter((root) => root !== 'history');

const unsupported = (command: string) => async (): Promise<never> => {
  throw new Error(`remote_session_command_unsupported:${command}`);
};

/**
 * A Session store whose document stays in the engine: no replica in this
 * renderer. History is read in bounded pages, the control roots as small JSON,
 * both refreshed from one changed-path observation; writes are checked JSON
 * patches committed through main.
 */
export async function createNativeRemoteSessionStore(options: {
  readonly sessionId: SessionId;
  readonly roomId: string;
  readonly workspaceId: string;
  /** This window's IndexedDB replica, imported once and never kept. */
  readonly legacyStorage: StorageAdapter;
  readonly replicaName: string;
  readonly view?: Omit<CreateConversationViewFromReaderOptions, 'sessionId'>;
}): Promise<SessionDocStore> {
  const { sessionId, roomId, workspaceId } = options;
  await migrateRendererLegacyDoc(workspaceId, options.legacyStorage, options.replicaName, roomId);
  const port = shareObservation(createRendererRemoteSessionPort(workspaceId, roomId));
  const control = createRemoteControlState<SessionDocState & Record<string, unknown>>(
    port,
    CONTROL_ROOTS,
    { session: { id: sessionId } } as SessionDocState & Record<string, unknown>
  );
  try {
    await control.ready;
  } catch (error) {
    control.close();
    throw error;
  }
  const getState = (): SessionDocState => {
    const state = control.getState();
    // A Session that never wrote its metadata root still has its identity.
    const session = (state.session ?? {}) as Record<string, unknown>;
    return {
      ...state,
      session: { ...session, id: typeof session.id === 'string' ? session.id : sessionId },
    } as SessionDocState;
  };
  const reader = createRemoteLoroHistoryReader(port);
  const commands = createRemoteHistoryCommands(port);
  const sessionData: SessionData = {
    sessionId,
    history: reader,
    commands: {
      ...commands,
      replaceEditableTail: unsupported('replaceEditableTail'),
      applyHistoryImport: unsupported('applyHistoryImport'),
    },
    snapshots: { capture: unsupported('capture'), copyFrom: unsupported('copyFrom') },
  };
  const history = createConversationViewFromReader(reader, { sessionId, ...options.view });
  const openedAt = Date.now();
  return {
    sessionId,
    roomId,
    historyBackend: 'loro',
    // Reads are served by the engine on demand: there is no replica to sync.
    firstSynced: Promise.resolve(),
    acquireSync: () => () => {},
    getSyncState: () => 'synced',
    subscribeSyncState: (listener) => {
      listener('synced');
      return () => {};
    },
    getState,
    setState: (updater) => {
      void control.update(updater as never).catch((error: unknown) => {
        console.warn(`[${sessionId}] Remote Session write failed`, error);
      });
    },
    commitState: (updater) => control.update(updater as never),
    subscribe: (listener) => control.subscribe(() => listener(getState())),
    history,
    sessionData,
    dispose: () => {
      history.dispose();
      control.close();
    },
    // Local writes are durable once their commits settle.
    waitUntilSynced: () => control.settled(),
    inspectSync: async () => ({
      transportId: 'native',
      bindingStatus: null,
      syncState: 'synced',
      openedAt,
      lastRemoteImportAt: null,
      pendingUploadProbe: null,
    }),
  };
}
