// @vitest-environment jsdom

import { act, createElement, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore, type Store } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getSessionRoomId,
  type MachineId,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import { getFunctionName } from 'convex/server';

const queryMocks = vi.hoisted(() => ({
  machineRows: undefined as unknown,
  localProjectRows: undefined as unknown,
  useQuery: vi.fn(),
}));

const machineFlockMocks = vi.hoisted(() => {
  const emptyState = {
    rowsByMachineId: new Map(),
    remoteSyncedMachineIds: new Set(),
  };
  return {
    useMachineFlockRowsByMachineIdsState: vi.fn(() => emptyState),
  };
});

vi.mock('../src/hooks/use-authenticated-convex', () => ({
  useAuthenticatedConvex: () => ({ isAuthenticated: true, isLoading: false }),
}));

vi.mock('../src/hooks/use-recoverable-convex-query', () => ({
  usePublicConvexQuery: () => undefined,
  useRecoverableConvexQuery: (...args: unknown[]) => queryMocks.useQuery(...args),
}));

vi.mock('@/hooks/use-machine-flock-rows', () => machineFlockMocks);
vi.mock('../src/hooks/use-machine-flock-rows', () => machineFlockMocks);

import { userAtom } from '../src/atoms';
import { sessionMetaCacheAtom } from '../src/atoms/doc-meta';
import { currentWorkspaceIdAtom } from '../src/atoms/workspace-context';
import { useSessionMentionItems } from '../src/components/mentions/mention-session-source';
import { TestCloudPlatformProvider } from './test-platform';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function MentionItemsProbe({
  currentSessionId,
  onSnapshot,
}: {
  currentSessionId?: string | null;
  onSnapshot: (value: string[]) => void;
}) {
  const items = useSessionMentionItems(currentSessionId);
  useEffect(() => {
    onSnapshot(items.map((item) => item.sessionId));
  }, [items, onSnapshot]);
  return null;
}

function cachedSession(over: Partial<SessionMeta> & { id: string }): SessionMeta {
  return {
    machineId: 'own-machine' as MachineId,
    createdAt: '2026-08-01T00:00:00.000Z',
    userId: 'viewer-user',
    status: { type: 'idle' },
    cliType: 'builtin',
    agentType: 'codex',
    ...over,
  } as SessionMeta;
}

describe('useSessionMentionItems', () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;
  let store: Store;
  let snapshot: string[] | undefined;

  beforeEach(() => {
    snapshot = undefined;
    queryMocks.machineRows = [];
    queryMocks.localProjectRows = [];
    queryMocks.useQuery.mockReset();
    queryMocks.useQuery.mockImplementation((query) => {
      const queryName = getFunctionName(query as Parameters<typeof getFunctionName>[0]);
      if (queryName === 'machines:listVisibleMachines') return queryMocks.machineRows;
      if (queryName === 'localProjects:listVisibleLocalProjects') {
        return queryMocks.localProjectRows;
      }
      throw new Error(`Unexpected Convex query: ${queryName}`);
    });
    store = createStore();
    store.set(userAtom, {
      id: 'viewer-user',
      name: 'Viewer',
      email: 'viewer@example.com',
    });
    store.set(currentWorkspaceIdAtom, 'workspace-mentions' as WorkspaceId);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    root = undefined;
    container?.remove();
    container = undefined;
    vi.clearAllMocks();
  });

  async function mount(node: ReactNode) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <TestCloudPlatformProvider>
          <Provider store={store}>{node}</Provider>
        </TestCloudPlatformProvider>
      );
      await Promise.resolve();
    });
  }

  it('offers child sessions, not just sidebar rows', async () => {
    // The sidebar-row projection (`sessionListAtom`) deliberately hides child
    // tabs; the mention source must read the child-inclusive one, because a
    // review/task child session is exactly what a user points an agent at.
    const parent = cachedSession({
      id: 'parent-session',
      title: 'parent',
      lastMessageAt: 10,
    });
    const child = cachedSession({
      id: 'child-session',
      title: 'child review',
      lastMessageAt: 20,
      parentSessionId: 'parent-session' as SessionId,
    });
    const archived = cachedSession({
      id: 'archived-session',
      title: 'archived',
      lastMessageAt: 30,
      isArchived: true,
    });
    store.set(sessionMetaCacheAtom, {
      [getSessionRoomId(parent.id)]: parent,
      [getSessionRoomId(child.id)]: child,
      [getSessionRoomId(archived.id)]: archived,
    });

    await mount(
      createElement(MentionItemsProbe, {
        currentSessionId: null,
        onSnapshot: (value) => {
          snapshot = value;
        },
      })
    );

    // Recency-ordered: child first, parent second; archived stays excluded.
    expect(snapshot).toEqual(['child-session', 'parent-session']);
  });

  it('builds the items once for every composer surface of a conversation', async () => {
    const one = cachedSession({ id: 'one-session', title: 'one', lastMessageAt: 20 });
    const two = cachedSession({ id: 'two-session', title: 'two', lastMessageAt: 10 });
    store.set(sessionMetaCacheAtom, {
      [getSessionRoomId(one.id)]: one,
      [getSessionRoomId(two.id)]: two,
    });
    const seen: unknown[] = [];
    function Surface() {
      const items = useSessionMentionItems('one-session');
      seen.push(items);
      return null;
    }

    // Input area, composer and mention textarea each read the items.
    await mount(createElement('div', null, createElement(Surface), createElement(Surface)));
    const settled = seen.slice(-2);
    expect(settled[0]).toBe(settled[1]);

    // A session-list change is a new list: the surfaces move to fresh items together.
    await act(async () => {
      store.set(sessionMetaCacheAtom, {
        [getSessionRoomId(one.id)]: one,
        [getSessionRoomId(two.id)]: { ...two, title: 'renamed' },
      });
    });
    const latest = seen.slice(-2);
    expect(latest[0]).toBe(latest[1]);
    expect(latest[0]).not.toBe(settled[0]);
  });

  it('still drops the session the composer belongs to', async () => {
    const current = cachedSession({ id: 'current-session', title: 'current', lastMessageAt: 20 });
    const other = cachedSession({ id: 'other-session', title: 'other', lastMessageAt: 10 });
    store.set(sessionMetaCacheAtom, {
      [getSessionRoomId(current.id)]: current,
      [getSessionRoomId(other.id)]: other,
    });

    await mount(
      createElement(MentionItemsProbe, {
        currentSessionId: 'current-session',
        onSnapshot: (value) => {
          snapshot = value;
        },
      })
    );

    expect(snapshot).toEqual(['other-session']);
  });
});
