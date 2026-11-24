import { type PendingSessionSends } from '../src/lib/session-pending-sends';
import type { SessionAttachmentDraft } from '../src/lib/session-attachment-draft';
import { applyHistoryAction } from '../../shared/src/session-data/history-actions';
import type { HistoryAction, SessionEntry } from '@lody/shared/session-data';
import { createStore } from 'jotai';
import { vi } from 'vitest';
import { getSessionRoomId, type MachineId, type SessionId, type SessionMeta } from '@lody/shared';
import { type WorkspaceRuntime } from '../src/atoms/runtime';
import {
  editSessionRunConfigDraftAtom,
  registerSessionRunConfigDraftLeaseAtom,
  setSessionRunConfigDraftAccountAtom,
} from '../src/atoms/session-run-config-drafts';

export function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: () => void;
} {
  let resolve: (() => void) | undefined;
  let reject: (() => void) | undefined;
  const promise = new Promise<void>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = () => nextReject(new Error('stream failed'));
  });
  if (!resolve || !reject) {
    throw new Error('Failed to create deferred');
  }
  return { promise, resolve, reject };
}

export function editRunConfigDraft(
  store: ReturnType<typeof createStore>,
  sessionId: string,
  workspaceId = 'workspace-1',
  accountId = 'user-1'
) {
  store.set(setSessionRunConfigDraftAccountAtom, accountId);
  const lease = store.set(registerSessionRunConfigDraftLeaseAtom, {
    accountId,
    workspaceId,
    sessionId,
    targetKey: 'codex',
  });
  store.set(editSessionRunConfigDraftAtom, {
    lease,
    edit: { type: 'config', configId: 'fast', value: false },
  });
  return lease;
}

/** Minimal port fixture: retain the observable array used by each UI test. */
export const sessionDataOver = (history: unknown[]) => ({
  history: {
    readTurn: async (turnId: string) => {
      const turn = history.find((entry) => (entry as { id?: string }).id === turnId);
      return turn ? { state: 'ready', turn } : { state: 'missing' };
    },
    count: async () => history.length,
    readDirectory: async (start: number, end: number) =>
      (history as { id: string; role: string; status?: string }[])
        .slice(start, end)
        .map((entry) => ({
          turnId: entry.id,
          state: 'ready' as const,
          scalars: { role: entry.role, status: entry.status },
        })),
  },
  commands: {
    applyHistoryAction: async (action: HistoryAction) => {
      const result = applyHistoryAction(history as SessionEntry[], action);
      history.splice(0, history.length, ...result.turns);
      return { status: 'accepted', matched: result.matched, receipt: { kind: 'history-action' } };
    },
  },
});

export const uploadedImage = (attachment: SessionAttachmentDraft) => ({
  type: 'image' as const,
  imageId: `uploaded-${attachment.id}`,
  mimeType: attachment.mimeType,
  sizeBytes: 3,
});

export const imageDraft = (id: string): SessionAttachmentDraft => ({
  id,
  kind: 'image',
  source: new Blob(['img']),
  name: `${id}.png`,
  mimeType: 'image/png',
  lastModified: 0,
});

/** Resolves once the held-send queue satisfies `done` (explicit signal, no polling). */
export function whenPendingSends(pending: PendingSessionSends, done: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (done()) return resolve();
    const unsubscribe = pending.subscribe(() => {
      if (!done()) return;
      unsubscribe();
      resolve();
    });
  });
}

/** A conversation's held sends are all written, or its head failed (then asserted). */
export const whenSessionDrained = (pending: PendingSessionSends, sessionId: SessionId) =>
  whenPendingSends(pending, () =>
    pending.getSnapshot().every((send) => send.sessionId !== sessionId || send.error)
  );

export const whenAborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });

export function createContainmentSessions(prefix: string, isArchived: boolean) {
  const rootSession = {
    id: `${prefix}-root` as SessionId,
    machineId: `${prefix}-root-machine` as MachineId,
    isArchived,
    createdAt: '2026-08-24T00:00:00.000Z',
  } as SessionMeta;
  const tabSession = {
    id: `${prefix}-tab` as SessionId,
    machineId: rootSession.machineId,
    parentSessionId: rootSession.id,
    openedBySessionId: rootSession.id,
    isArchived,
    createdAt: '2026-08-24T00:01:00.000Z',
  } as SessionMeta;
  const openedSession = {
    id: `${prefix}-opened` as SessionId,
    machineId: `${prefix}-opened-machine` as MachineId,
    openedBySessionId: rootSession.id,
    isArchived,
    createdAt: '2026-08-24T00:02:00.000Z',
  } as SessionMeta;
  const openedFromTabSession = {
    id: `${prefix}-opened-from-tab` as SessionId,
    machineId: `${prefix}-opened-from-tab-machine` as MachineId,
    openedBySessionId: tabSession.id,
    openedByRootSessionId: rootSession.id,
    isArchived,
    createdAt: '2026-08-24T00:03:00.000Z',
  } as SessionMeta;
  const sessions = [rootSession, tabSession, openedSession, openedFromTabSession];
  return {
    rootSession,
    tabSession,
    openedSession,
    openedFromTabSession,
    sessions,
    sessionMetaCache: Object.fromEntries(
      sessions.map((session) => [getSessionRoomId(session.id), session])
    ),
  };
}

export function createSessionMetaRepo(
  sessions: readonly SessionMeta[],
  onChange?: (sessions: Record<string, SessionMeta>) => void
) {
  const docs = new Map<string, Record<string, unknown>>(
    sessions.map((session) => [getSessionRoomId(session.id), { ...session }])
  );
  const publish = () => onChange?.(Object.fromEntries(docs) as Record<string, SessionMeta>);
  const repo = {
    listDoc: async () => [...docs].map(([docId, meta]) => ({ docId, meta: { ...meta } })),
    getDocMeta: vi.fn(async (roomId: string) => ({ meta: docs.get(roomId) ?? {} })),
    upsertDocMeta: vi.fn(async (roomId: string, patch: Record<string, unknown>) => {
      docs.set(roomId, { ...(docs.get(roomId) ?? {}), ...patch });
      publish();
    }),
    deleteDoc: vi.fn(async (roomId: string) => {
      docs.delete(roomId);
      publish();
    }),
    openFlockDoc: vi.fn(async () => ({
      flock: { scan: () => [], set: vi.fn(), delete: vi.fn(), commit: vi.fn() },
      syncOnce: vi.fn(async () => undefined),
    })),
    flush: vi.fn(async () => undefined),
  } as unknown as WorkspaceRuntime['repo'];
  return {
    repo,
    getMeta: (roomId: string) => docs.get(roomId),
    getSession: (sessionId: SessionId) =>
      docs.get(getSessionRoomId(sessionId)) as SessionMeta | undefined,
    setMeta: (roomId: string, meta: Record<string, unknown>) => {
      docs.set(roomId, { ...meta });
      publish();
    },
  };
}
