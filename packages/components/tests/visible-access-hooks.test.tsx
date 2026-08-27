// @vitest-environment jsdom

import { act, createElement, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore, type Store } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getLodyMachinePresenceKey,
  getMachineRoomId,
  getServerNow,
  getSessionRoomId,
  type LodyPresenceInstanceId,
  type MachineId,
  type MachineMeta,
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
const sharedMachineProjectIndexProbeRender = vi.fn();

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
import { machineMetaCacheAtom, sessionMetaCacheAtom } from '../src/atoms/doc-meta';
import { lodyPresenceStatesAtom, setLodyPresenceNowMsAtom } from '../src/atoms/presence';
import { currentWorkspaceIdAtom } from '../src/atoms/workspace-context';
import {
  useVisibleLocalProjects,
  useVisibleLocalProjectsFromMachineIndex,
} from '../src/hooks/use-visible-local-projects';
import { useVisibleMachineMetas } from '../src/hooks/use-visible-machine-metas';
import {
  useVisibleArchivedSessionMetas,
  useVisibleSessionMetas,
} from '../src/hooks/use-visible-session-metas';
import { WorkspaceRouteTargetProvider } from '../src/providers/workspace-route-target';
import {
  resolveSessionDetailVisibilityState,
  type SessionDetailPresenceState,
} from '../src/lib/session-detail-presence';
import { TestCloudPlatformProvider } from './test-platform';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type AccessSnapshot = {
  accessKeys: string[];
  isLoading: boolean;
};

type MachineAuthorizationSnapshot = AccessSnapshot & {
  convexAuthorizedKeys: string[];
};

type SessionVisibilitySnapshot = {
  visibleSessionIds: string[];
  detailState: SessionDetailPresenceState;
  isLoading: boolean;
};

function VisibleMachineProbe({ onSnapshot }: { onSnapshot: (value: AccessSnapshot) => void }) {
  const { accessByMachineId, isLoading } = useVisibleMachineMetas({
    includeMachineFlock: false,
  });

  useEffect(() => {
    onSnapshot({ accessKeys: [...accessByMachineId.keys()], isLoading });
  }, [accessByMachineId, isLoading, onSnapshot]);

  return null;
}

function VisibleMachineAuthorizationProbe({
  onSnapshot,
}: {
  onSnapshot: (value: MachineAuthorizationSnapshot) => void;
}) {
  const { accessByMachineId, convexAuthorizedMachineIds, isLoading } = useVisibleMachineMetas({
    includeMachineFlock: false,
  });

  useEffect(() => {
    onSnapshot({
      accessKeys: [...accessByMachineId.keys()],
      convexAuthorizedKeys: [...convexAuthorizedMachineIds],
      isLoading,
    });
  }, [accessByMachineId, convexAuthorizedMachineIds, isLoading, onSnapshot]);

  return null;
}

function VisibleLocalProjectProbe({ onSnapshot }: { onSnapshot: (value: AccessSnapshot) => void }) {
  const { accessByProjectKey, isLoading } = useVisibleLocalProjects({
    includeMachineFlock: false,
  });

  useEffect(() => {
    onSnapshot({ accessKeys: [...accessByProjectKey.keys()], isLoading });
  }, [accessByProjectKey, isLoading, onSnapshot]);

  return null;
}

function SharedMachineProjectIndexProbe() {
  sharedMachineProjectIndexProbeRender();
  const machineIndex = useVisibleMachineMetas();
  useVisibleLocalProjectsFromMachineIndex(machineIndex);
  return null;
}

function VisibleSessionProbe({
  session,
  onSnapshot,
}: {
  session: SessionMeta;
  onSnapshot: (value: SessionVisibilitySnapshot) => void;
}) {
  const { sessions, visibleMachineIds, visibleLocalProjectKeys, isLoading } =
    useVisibleSessionMetas();
  const detailState = resolveSessionDetailVisibilityState({
    baseState: 'resolved',
    session,
    visibleMachineIds,
    visibleLocalProjectKeys,
    machineVisibilityLoading: isLoading,
    localProjectVisibilityLoading: false,
    currentUserId: 'viewer-user',
  });

  useEffect(() => {
    onSnapshot({
      visibleSessionIds: sessions.map((item) => item.id),
      detailState,
      isLoading,
    });
  }, [detailState, isLoading, onSnapshot, sessions]);

  return null;
}

function RouteScopedVisibilityProbe({
  onSnapshot,
}: {
  onSnapshot: (value: { activeIds: string[]; archivedIds: string[] }) => void;
}) {
  const { sessions } = useVisibleSessionMetas();
  const { archivedSessions } = useVisibleArchivedSessionMetas();

  useEffect(() => {
    onSnapshot({
      activeIds: sessions.map((session) => session.id),
      archivedIds: archivedSessions.map((session) => session.id),
    });
  }, [archivedSessions, onSnapshot, sessions]);

  return null;
}

function createCachedSession(userId: string): SessionMeta {
  return {
    id: 'cached-session' as SessionId,
    machineId: 'shared-machine' as MachineId,
    createdAt: '2026-07-19T00:00:00.000Z',
    userId,
    status: { type: 'idle' },
    cliType: 'builtin',
    agentType: 'codex',
  };
}

describe('visible access hooks', () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;
  let store: Store;
  let sessionSnapshot: SessionVisibilitySnapshot | undefined;

  async function render(node: ReactNode) {
    await act(async () => {
      root?.render(
        <TestCloudPlatformProvider>
          <Provider store={store}>{node}</Provider>
        </TestCloudPlatformProvider>
      );
    });
  }

  async function mount(workspaceId: string, node: ReactNode) {
    store.set(currentWorkspaceIdAtom, workspaceId as WorkspaceId);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await render(node);
  }

  function cacheSession(session: SessionMeta) {
    store.set(sessionMetaCacheAtom, {
      [getSessionRoomId(session.id)]: session,
    });
  }

  function sessionProbe(session: SessionMeta) {
    return createElement(VisibleSessionProbe, {
      session,
      onSnapshot: (value) => {
        sessionSnapshot = value;
      },
    });
  }

  function expectSessionSnapshot(
    visibleSessionIds: string[],
    detailState: SessionDetailPresenceState,
    isLoading: boolean
  ) {
    expect(sessionSnapshot).toEqual({ visibleSessionIds, detailState, isLoading });
  }

  async function unmount() {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    root = undefined;
    container?.remove();
    container = undefined;
  }

  beforeEach(() => {
    sessionSnapshot = undefined;
    queryMocks.machineRows = undefined;
    queryMocks.localProjectRows = [];
    queryMocks.useQuery.mockReset();
    queryMocks.useQuery.mockImplementation((query) => {
      const queryName = getFunctionName(query as Parameters<typeof getFunctionName>[0]);
      if (queryName === 'machines:listVisibleMachines') {
        return queryMocks.machineRows;
      }
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
  });

  afterEach(async () => {
    await unmount();
    vi.clearAllMocks();
  });

  it('fails closed for active and archived sessions while a new route scope is not ready', async () => {
    queryMocks.machineRows = [
      {
        machineId: 'shared-machine',
        ownerUserId: 'viewer-user',
        sharedWithTeam: false,
        updatedAt: 1,
      },
    ];
    const activeSession = createCachedSession('viewer-user');
    const archivedSession = {
      ...createCachedSession('viewer-user'),
      id: 'archived-session' as SessionId,
      isArchived: true,
    };
    cacheSession(activeSession);
    store.set(sessionMetaCacheAtom, {
      [getSessionRoomId(activeSession.id)]: activeSession,
      [getSessionRoomId(archivedSession.id)]: archivedSession,
    });
    let snapshot: { activeIds: string[]; archivedIds: string[] } | undefined;

    await mount(
      'workspace-a',
      createElement(
        WorkspaceRouteTargetProvider,
        { slug: 'workspace-b' },
        createElement(RouteScopedVisibilityProbe, {
          onSnapshot: (value) => {
            snapshot = value;
          },
        })
      )
    );

    expect(snapshot).toEqual({ activeIds: [], archivedIds: [] });
    const queryArgs = queryMocks.useQuery.mock.calls.map(([, args]) => args);
    expect(queryArgs.length).toBeGreaterThan(0);
    expect(queryArgs.every((args) => args === 'skip')).toBe(true);
    expect(machineFlockMocks.useMachineFlockRowsByMachineIdsState).toHaveBeenCalledWith([], {
      families: expect.any(Array),
      syncRemote: false,
      remoteMachineIds: [],
    });
  });

  it('does not reuse machine access rows while a later mount is loading', async () => {
    queryMocks.machineRows = [
      {
        machineId: 'shared-machine',
        ownerUserId: 'owner-user',
        sharedWithTeam: true,
        updatedAt: 1,
      },
    ];
    let snapshot: AccessSnapshot | undefined;

    await mount(
      'workspace-machine-cache',
      createElement(VisibleMachineProbe, {
        onSnapshot: (value) => {
          snapshot = value;
        },
      })
    );
    expect(snapshot).toEqual({ accessKeys: ['shared-machine'], isLoading: false });

    await unmount();
    queryMocks.machineRows = undefined;
    await mount(
      'workspace-machine-cache',
      createElement(VisibleMachineProbe, {
        onSnapshot: (value) => {
          snapshot = value;
        },
      })
    );

    expect(snapshot).toEqual({ accessKeys: [], isLoading: true });
  });

  it('keeps the local owner fallback out of the Convex-authorized machine set', async () => {
    const machineId = 'owner-fallback-machine' as MachineId;
    store.set(machineMetaCacheAtom, {
      [getMachineRoomId(machineId)]: {
        id: machineId,
        name: 'Owner fallback',
        ownerUserId: 'viewer-user',
        cliVersion: '0.1.0',
        os: 'linux',
        sessions: [],
      },
    });
    queryMocks.machineRows = [];
    let snapshot: MachineAuthorizationSnapshot | undefined;

    await mount(
      'workspace-owner-fallback',
      createElement(VisibleMachineAuthorizationProbe, {
        onSnapshot: (value) => {
          snapshot = value;
        },
      })
    );

    expect(snapshot).toEqual({
      accessKeys: [machineId],
      convexAuthorizedKeys: [],
      isLoading: false,
    });
  });

  it('does not reuse local-project access rows while a later mount is loading', async () => {
    queryMocks.machineRows = [
      {
        machineId: 'shared-machine',
        ownerUserId: 'owner-user',
        sharedWithTeam: true,
        updatedAt: 1,
      },
    ];
    queryMocks.localProjectRows = [
      {
        machineId: 'shared-machine',
        localProjectId: 'shared-project',
        ownerUserId: 'owner-user',
        sharedWithTeam: true,
        updatedAt: 1,
      },
    ];
    let snapshot: AccessSnapshot | undefined;

    await mount(
      'workspace-project-cache',
      createElement(VisibleLocalProjectProbe, {
        onSnapshot: (value) => {
          snapshot = value;
        },
      })
    );
    expect(snapshot).toEqual({
      accessKeys: ['shared-machine:shared-project'],
      isLoading: false,
    });

    await unmount();
    queryMocks.localProjectRows = undefined;
    await mount(
      'workspace-project-cache',
      createElement(VisibleLocalProjectProbe, {
        onSnapshot: (value) => {
          snapshot = value;
        },
      })
    );

    expect(snapshot).toEqual({ accessKeys: [], isLoading: true });
  });

  it('reuses one machine index and only joins online machine flocks', async () => {
    const now = getServerNow();
    const onlineMachineId = 'online-machine' as MachineId;
    const offlineMachineId = 'offline-machine' as MachineId;
    const instanceId = 'online-instance' as LodyPresenceInstanceId;
    const createMachine = (id: MachineId, name: string): MachineMeta => ({
      id,
      name,
      cliVersion: '0.1.0',
      os: 'linux',
      sessions: [],
      raceLimits: {},
    });
    store.set(machineMetaCacheAtom, {
      [getMachineRoomId(onlineMachineId)]: createMachine(onlineMachineId, 'Online'),
      [getMachineRoomId(offlineMachineId)]: createMachine(offlineMachineId, 'Offline'),
    });
    store.set(setLodyPresenceNowMsAtom, now);
    store.set(lodyPresenceStatesAtom, {
      [getLodyMachinePresenceKey(onlineMachineId, instanceId)]: {
        kind: 'machine',
        machineId: onlineMachineId,
        instanceId,
        updatedAt: now,
      },
    });
    queryMocks.machineRows = [onlineMachineId, offlineMachineId].map((machineId) => ({
      machineId,
      ownerUserId: 'viewer-user',
      sharedWithTeam: false,
      updatedAt: 1,
    }));

    await mount('workspace-shared-index', createElement(SharedMachineProjectIndexProbe));

    expect(machineFlockMocks.useMachineFlockRowsByMachineIdsState).toHaveBeenCalledTimes(
      sharedMachineProjectIndexProbeRender.mock.calls.length
    );
    const [machineIds, options] =
      machineFlockMocks.useMachineFlockRowsByMachineIdsState.mock.calls.at(-1) as [
        MachineId[],
        { remoteMachineIds: MachineId[] },
      ];
    expect(new Set(machineIds)).toEqual(new Set([onlineMachineId, offlineMachineId]));
    expect(options.remoteMachineIds).toEqual([onlineMachineId]);
  });

  it('hides a cached teammate session and keeps detail loading after sharing is revoked', async () => {
    const session = createCachedSession('owner-user');
    cacheSession(session);
    queryMocks.machineRows = [
      {
        machineId: 'shared-machine',
        ownerUserId: 'owner-user',
        sharedWithTeam: true,
        updatedAt: 1,
      },
    ];

    await mount('workspace-revoked-share', sessionProbe(session));
    expectSessionSnapshot(['cached-session'], 'resolved', false);

    await unmount();
    queryMocks.machineRows = undefined;
    await mount('workspace-revoked-share', sessionProbe(session));

    expectSessionSnapshot([], 'loading', true);
  });

  it('keeps a newly shared cached session pending until the access row arrives', async () => {
    const session = createCachedSession('owner-user');
    cacheSession(session);

    await mount('workspace-new-share', sessionProbe(session));
    expectSessionSnapshot([], 'loading', true);

    queryMocks.machineRows = [
      {
        machineId: 'shared-machine',
        ownerUserId: 'owner-user',
        sharedWithTeam: true,
        updatedAt: 2,
      },
    ];
    await render(sessionProbe(session));

    expectSessionSnapshot(['cached-session'], 'resolved', false);
  });

  it('keeps the current user cached session visible while access is loading', async () => {
    const session = createCachedSession('viewer-user');
    cacheSession(session);

    await mount('workspace-owner-session', sessionProbe(session));

    expectSessionSnapshot(['cached-session'], 'resolved', true);
  });
});
