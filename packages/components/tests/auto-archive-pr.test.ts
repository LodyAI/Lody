// @vitest-environment jsdom

import { act, createElement, Fragment, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getSessionRoomId,
  readSessionOperationTargets,
  type SessionHistory,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import {
  CLOUD_PLATFORM_CAPABILITIES,
  createStaticStore,
  type CloudApi,
  type PlatformProvider,
} from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import { runtimeAtom, type WorkspaceRuntime } from '../src/atoms/runtime';
import { userAtom } from '../src/atoms';
import { docMetaCacheReadyAtom, sessionMetaCacheAtom } from '../src/atoms/doc-meta';
import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from '../src/atoms/workspace-context';
import { AuthenticatedWorkspaceContent } from '../src/components/authenticated-workspace-content';
import { useSessionActions, type SessionActions } from '../src/hooks/use-session-actions';
import { createSessionSendResources } from '../src/lib/session-send-resources';
import {
  createPendingSessionSends,
  type PendingSessionSend,
} from '../src/lib/session-pending-sends';
import { deliverUserTurn, writeUserTurn } from '../src/lib/session-send-delivery';
import { finalizePreparedSend } from '../src/lib/session-attachment-preparation';

const { sendIpcMock } = vi.hoisted(() => ({ sendIpcMock: vi.fn() }));
vi.mock('@/lib/auth-bootstrap', () => ({
  readBootstrappedCurrentUser: () => null,
  readStoredAuthToken: () => null,
}));
vi.mock('../src/lib/electron-ipc-client', () => ({ sendIpc: sendIpcMock }));
vi.mock('../src/hooks/use-authenticated-convex', () => ({
  useAuthenticatedConvex: () => ({ isAuthenticated: true, requestAuthRecovery: () => {} }),
}));

// Exercise the production workspace composition without unrelated visual hosts.
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  Outlet: () => null,
}));
vi.mock('../src/components/workspace-checkout-pending-dialog', () => ({
  WorkspaceCheckoutPendingDialog: () => null,
}));
vi.mock('../src/components/electron-session-completion-notifier', () => ({
  ElectronSessionCompletionNotifier: () => null,
}));
vi.mock('../src/components/electron-menu-handler', () => ({ ElectronMenuHandler: () => null }));
vi.mock('../src/components/app-commands', () => ({ AppCommands: () => null }));
vi.mock('../src/components/commands/command-palette', () => ({ CommandPalette: () => null }));

vi.mock('../src/hooks/use-visible-session-metas', async (importOriginal) => {
  const { useAtomValue: useTestAtomValue } = await import('jotai');
  const { sessionMetaCacheAtom: projectedSessionCacheAtom } = await import('../src/atoms/doc-meta');
  return {
    ...(await importOriginal<typeof import('../src/hooks/use-visible-session-metas')>()),
    useVisibleSessionMetas: () => ({
      sessions: Object.values(useTestAtomValue(projectedSessionCacheAtom)).filter(
        (session) => !session.isArchived
      ),
    }),
    useVisibleArchivedSessionMetas: () => ({
      archivedSessions: Object.values(useTestAtomValue(projectedSessionCacheAtom)).filter(
        (session) => session.isArchived
      ),
    }),
  };
});

const testPlatform: PlatformProvider = {
  kind: 'cloud',
  identity: {
    session: createStaticStore({ status: 'unauthenticated' }),
    signOut: async () => {},
  },
  workspaces: {
    state: createStaticStore({ status: 'ready', workspaces: [], activeWorkspaceId: null }),
    setActive: async () => {},
  },
  capabilities: CLOUD_PLATFORM_CAPABILITIES,
  cloudApi: {
    useQuery: () => ({ effectivePlanTier: 'plus', checkoutPending: false }),
    useMutation: () => async () => ({}),
    useAction: () => async () => undefined,
  } as CloudApi,
  sync: { mode: 'cloud' },
};

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function ActionsProbe({ onReady }: { onReady: (actions: SessionActions) => void }) {
  const actions = useSessionActions();
  useEffect(() => onReady(actions), [actions, onReady]);
  return null;
}

/** Real admission, held-send ownership and delivery over synthetic durable ports. */
function createFixture() {
  const store = createStore();
  const rootSession = {
    id: 'pr-status-root' as SessionId,
    machineId: 'machine-1',
    userId: 'user-1',
    isArchived: false,
    createdAt: '2026-08-24T00:00:00.000Z',
    pullRequests: [{ url: 'https://github.com/example/repo/pull/1', status: 'open' }],
  } as SessionMeta;
  const tabSession = {
    ...rootSession,
    id: 'pr-status-tab' as SessionId,
    parentSessionId: rootSession.id,
    openedBySessionId: rootSession.id,
    pullRequests: undefined,
  };
  const sessions: SessionMeta[] = [
    rootSession,
    tabSession,
    {
      ...rootSession,
      id: 'pr-status-opened' as SessionId,
      openedBySessionId: rootSession.id,
      pullRequests: undefined,
    },
    {
      ...rootSession,
      id: 'pr-status-opened-from-tab' as SessionId,
      openedBySessionId: tabSession.id,
      openedByRootSessionId: rootSession.id,
      pullRequests: undefined,
    },
  ];
  const docs = new Map(sessions.map((session) => [getSessionRoomId(session.id), { ...session }]));
  const publish = () => store.set(sessionMetaCacheAtom, Object.fromEntries(docs));
  const repo = {
    listDoc: async () => [...docs].map(([docId, meta]) => ({ docId, meta: { ...meta } })),
    getDocMeta: async (roomId: string) => ({ meta: docs.get(roomId) ?? {} }),
    upsertDocMeta: async (roomId: string, patch: Partial<SessionMeta>) => {
      docs.set(roomId, { ...docs.get(roomId), ...patch } as SessionMeta);
      publish();
    },
    flush: async () => {},
  } as unknown as WorkspaceRuntime['repo'];
  const history: SessionHistory[] = [];
  const control = { humanInputReceipts: {} as Record<string, { userId: string }> };
  const sessionStore = {
    getState: () => control,
    setState: (update: (draft: typeof control) => void) => update(control),
    waitUntilSynced: async () => {},
    sessionData: {
      history: {
        readTurn: async (id: string) => {
          const turn = history.find((entry) => entry.id === id);
          return turn ? { state: 'ready', turn } : { state: 'missing' };
        },
        count: async () => history.length,
        readDirectory: async (start: number, end: number) =>
          history.slice(start, end).map((turn) => ({
            turnId: turn.id,
            state: 'ready',
            scalars: { role: turn.role, status: turn.status },
          })),
      },
    },
  };
  const runtime = {
    accountId: 'user-1',
    workspaceId: 'workspace-1' as WorkspaceId,
    workspaceSlug: 'workspace-slug',
    repo,
    writer: {
      upsertDocMeta: repo.upsertDocMeta.bind(repo),
      appendSessionTurn: async (_id: string, entry: SessionHistory) => {
        history.push(entry);
        return 'direct';
      },
    },
    readSessionOperationTargets: (
      id: SessionId,
      operation: Parameters<WorkspaceRuntime['readSessionOperationTargets']>[1]
    ) => readSessionOperationTargets(repo, id, operation),
    withSessionStore: async (_id: SessionId, callback: (store: typeof sessionStore) => unknown) =>
      callback(sessionStore),
    requestSessionDispatchTurn: async () => undefined,
  } as unknown as WorkspaceRuntime;
  const resources = createSessionSendResources({
    acquire: (id) => runtime.withSessionStore(id, (doc) => doc),
    releaseRef: () => {},
  });
  Object.defineProperty(runtime, 'sendResources', { value: resources });
  const preparations: { signal: AbortSignal; finish: () => void }[] = [];
  const pending = createPendingSessionSends({
    prepare: (send, signal) =>
      new Promise<Pick<PendingSessionSend, 'entry' | 'queue' | 'attachments'>>(
        (resolve, reject) => {
          preparations.push({
            signal,
            finish: () =>
              resolve(
                finalizePreparedSend({
                  ...send,
                  attachments: send.attachments.map((attachment) => ({
                    ...attachment,
                    ready: {
                      type: 'image',
                      imageId: `uploaded-${attachment.id}`,
                      mimeType: attachment.mimeType,
                      sizeBytes: 3,
                    },
                  })),
                })
              ),
          });
          signal.addEventListener('abort', () =>
            reject(new DOMException('Attachment operation aborted', 'AbortError'))
          );
        }
      ),
    write: (send, signal) => resources.run((owned) => writeUserTurn(runtime, send, owned), signal),
    deliver: (send) => deliverUserTurn(runtime, send),
  });
  Object.defineProperty(runtime, 'pendingSends', { value: pending });
  store.set(runtimeAtom, runtime);
  store.set(userAtom, { id: 'user-1' } as never);
  store.set(docMetaCacheReadyAtom, true);
  store.set(currentWorkspaceIdAtom, runtime.workspaceId);
  store.set(currentWorkspaceSlugAtom, runtime.workspaceSlug);
  publish();
  return { store, runtime, rootSession, sessions, docs, history, preparations, pending, resources };
}

describe('PR status does not archive sessions', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let fixture: ReturnType<typeof createFixture> | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    fixture?.pending.dispose();
    await fixture?.resources.dispose();
    fixture = undefined;
    container?.remove();
    container = undefined;
    sendIpcMock.mockClear();
    localStorage.removeItem('lody-auto-archive-on-pr-merged');
    localStorage.removeItem('lody-auto-archive-on-pr-closed');
  });

  const userInput = (text: string) =>
    ({
      role: 'user',
      userId: 'user-1',
      items: [{ type: 'text', text }],
      timestamp: '2026-09-29T00:00:00.000Z',
      status: 'pending',
      read: false,
      finished: true,
      inputConfig: {
        prompt: text,
        inputBlocks: [{ type: 'text', text }],
        cliType: 'builtin',
        agentType: 'codex',
      },
    }) as unknown as Parameters<SessionActions['addSessionHistory']>[1];

  it.each(['merged', 'closed'] as const)(
    'keeps sessions and held sends active when a PR becomes %s with legacy auto-archive preferences enabled',
    async (status) => {
      localStorage.setItem('lody-auto-archive-on-pr-merged', 'true');
      localStorage.setItem('lody-auto-archive-on-pr-closed', 'true');
      const test = createFixture();
      fixture = test;
      let actions: SessionActions | undefined;
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      await act(async () =>
        root?.render(
          createElement(
            PlatformContext.Provider,
            { value: testPlatform },
            createElement(
              Provider,
              { store: test.store },
              createElement(
                Fragment,
                null,
                createElement(ActionsProbe, {
                  onReady: (next) => {
                    actions = next;
                  },
                }),
                createElement(AuthenticatedWorkspaceContent)
              )
            )
          )
        )
      );
      if (!actions) throw new Error('Session actions were not initialized');
      const held = await actions.addSessionHistory(test.rootSession.id, userInput('continue'), {
        dispatch: true,
        attachments: [
          {
            id: 'pr-status-attachment',
            kind: 'image',
            source: new Blob(['img']),
            name: 'pr-status.png',
            mimeType: 'image/png',
            lastModified: 0,
          },
        ],
      });
      const pr = { url: test.rootSession.pullRequests![0]!.url, status };
      await act(async () => {
        await test.runtime.writer.upsertDocMeta(getSessionRoomId(test.rootSession.id), {
          pullRequests: [pr],
        });
      });
      expect(test.docs.get(getSessionRoomId(test.rootSession.id))?.pullRequests).toEqual([pr]);
      for (const session of test.sessions) {
        expect(test.docs.get(getSessionRoomId(session.id))?.isArchived).toBe(false);
      }
      expect(test.pending.getSnapshot().map((send) => send.id)).toEqual([held.id]);
      expect(test.preparations[0].signal.aborted).toBe(false);
      const drained = new Promise<void>((resolve) => {
        const release = test.pending.subscribe(() => {
          if (test.pending.getSnapshot().some((send) => !send.error)) return;
          release();
          resolve();
        });
      });
      test.preparations[0].finish();
      await drained;
      expect(test.history.map((turn) => turn.id)).toContain(held.id);
      expect(test.docs.get(getSessionRoomId(test.rootSession.id))?.latestUserMsgId).toBe(held.id);
      expect(sendIpcMock.mock.calls).toEqual([]);
    }
  );
});
