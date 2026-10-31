// @vitest-environment jsdom
import { workspaceContentModeAtom } from '../src/atoms/workspace-content-mode';

import { act, createElement, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore, type Store } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getLodyMachinePresenceKey,
  getMachineRoomId,
  getServerNow,
  getSessionRoomId,
  AGENT_ROLE_VERSION,
  type AgentConfigId,
  type AgentRole,
  type AgentRoleId,
  type LocalProjectId,
  type MachineLegacyMetaFields,
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
const catalogMocks = vi.hoisted(() => ({ roles: [] as unknown[], synced: false }));
vi.mock('../src/hooks/use-workspace-catalog', () => ({ useWorkspaceCatalog: () => catalogMocks }));

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
import { runtimeAtom, type WorkspaceRuntime } from '../src/atoms/runtime';
import { useWorkspaceAgentRoles } from '../src/hooks/use-workspace-agent-roles';
import { machineMetaCacheAtom, sessionMetaCacheAtom } from '../src/atoms/doc-meta';
import { lodyPresenceStatesAtom, setLodyPresenceNowMsAtom } from '../src/atoms/presence';
import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from '../src/atoms/workspace-context';
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
import { TEST_CLOUD_PLATFORM, TestCloudPlatformProvider } from './test-platform';
import { PlatformContext } from '@lody/platform/react';
import type { PlatformProvider } from '@lody/platform';
import { notifyE2eeLedgerChanged } from '../src/providers/e2ee-runtime-notifications';
import { ENCRYPTED_SHARED_MACHINE_REFRESH_MS } from '../src/lib/encrypted-shared-machines';
import { withoutEncryptedSharedMachines } from '../src/lib/visible-machine-index';

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

function OfflineVisibilityProbe({
  onSnapshot,
}: {
  onSnapshot: (value: {
    machines: string[];
    projects: string[];
    sessions: string[];
    archived: string[];
    roles: string[];
    isLoading: boolean;
  }) => void;
}) {
  const machines = useVisibleMachineMetas({ includeMachineFlock: false });
  const projects = useVisibleLocalProjects({ includeMachineFlock: false });
  const sessions = useVisibleSessionMetas();
  const archived = useVisibleArchivedSessionMetas();
  const { roles } = useWorkspaceAgentRoles();
  useEffect(() => {
    onSnapshot({
      machines: [...machines.machines.keys()],
      projects: [...projects.projects.keys()],
      sessions: sessions.sessions.map((session) => session.id),
      archived: archived.archivedSessions.map((session) => session.id),
      roles: roles.map((role) => role.id),
      isLoading: machines.isLoading || projects.isLoading || sessions.isLoading,
    });
  }, [machines, projects, sessions, archived, roles, onSnapshot]);
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
    store.set(currentWorkspaceSlugAtom, workspaceId);
    store.set(currentWorkspaceIdAtom, workspaceId as WorkspaceId);
    const accountId = store.get(userAtom)?.id;
    if (accountId)
      store.set(workspaceContentModeAtom, {
        accountId,
        workspaceId,
        workspaceSlug: workspaceId,
        descriptor: { workspaceId, contentMode: 'plaintext', contentModeVersion: 1 },
      });
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
    catalogMocks.roles = [];
    catalogMocks.synced = false;
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

  for (const scenario of [
    {
      name: 'retains E2EE owner data after the renderer auth snapshot has expired',
      mode: 'e2ee',
      userId: null,
      runtimeWorkspace: 'offline-workspace',
      visible: true,
    },
    {
      name: 'keeps ordinary workspace filtering unchanged without a renderer user',
      mode: 'plaintext',
      userId: null,
      runtimeWorkspace: 'offline-workspace',
      visible: false,
    },
    {
      name: 'preserves ordinary owner visibility with a current renderer user',
      mode: 'plaintext',
      userId: 'viewer-user',
      runtimeWorkspace: 'offline-workspace',
      visible: true,
    },
    {
      name: 'fails closed when the logged-in user differs from the E2EE owner',
      mode: 'e2ee',
      userId: 'different-user',
      runtimeWorkspace: 'offline-workspace',
      visible: false,
    },
    {
      name: 'does not borrow the identity of another workspace runtime',
      mode: 'e2ee',
      userId: null,
      runtimeWorkspace: 'other-workspace',
      visible: false,
    },
  ] as const) {
    it(scenario.name, async () => {
      queryMocks.machineRows = undefined;
      queryMocks.localProjectRows = undefined;
      store.set(
        userAtom,
        scenario.userId ? { id: scenario.userId, name: 'Other', email: 'other@example.test' } : null
      );
      store.set(runtimeAtom, {
        workspaceId: scenario.runtimeWorkspace as WorkspaceId,
        workspaceSlug: scenario.runtimeWorkspace,
        contentMode: scenario.mode,
        accountId: 'viewer-user',
      } as WorkspaceRuntime);
      const machineId = 'shared-machine' as MachineId;
      const projectId = 'offline-project' as LocalProjectId;
      const machine: MachineMeta & MachineLegacyMetaFields = {
        id: machineId,
        name: 'Cached owner machine',
        ownerUserId: 'viewer-user',
        cliVersion: '0.1.0',
        os: 'linux',
        sessions: [],
        localProjects: {
          [projectId]: {
            id: projectId,
            name: 'Cached project',
            rootPath: '/synthetic/project',
            createdAtMs: 1,
          },
        },
      };
      store.set(machineMetaCacheAtom, { [getMachineRoomId(machineId)]: machine });
      const session = {
        ...createCachedSession('viewer-user'),
        project: { kind: 'local' as const, localProjectId: projectId },
      };
      const archived = { ...session, id: 'archived-offline' as SessionId, isArchived: true };
      store.set(sessionMetaCacheAtom, {
        [getSessionRoomId(session.id)]: session,
        [getSessionRoomId(archived.id)]: archived,
      });
      const privateRole: AgentRole = {
        v: AGENT_ROLE_VERSION,
        id: 'offline-role' as AgentRoleId,
        name: 'Cached private role',
        ownerUserId: 'viewer-user',
        visibility: 'private',
        machineId,
        agentConfigId: 'offline-config' as AgentConfigId,
        runConfig: {},
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      };
      catalogMocks.roles = [
        privateRole,
        { ...privateRole, id: 'other-private-role' as AgentRoleId, ownerUserId: 'teammate' },
      ];
      let snapshot:
        | Parameters<Parameters<typeof OfflineVisibilityProbe>[0]['onSnapshot']>[0]
        | undefined;
      await mount(
        'offline-workspace',
        createElement(OfflineVisibilityProbe, {
          onSnapshot: (value) => {
            snapshot = value;
          },
        })
      );
      expect(snapshot).toEqual({
        machines: scenario.visible ? [machineId] : [],
        projects: scenario.visible ? [`${machineId}:${projectId}`] : [],
        sessions: scenario.visible ? [session.id] : [],
        archived: scenario.visible ? [archived.id] : [],
        roles: scenario.visible ? [privateRole.id] : [],
        isLoading: scenario.mode !== 'e2ee' || scenario.runtimeWorkspace !== 'offline-workspace',
      });
    });
  }
});

describe('encrypted shared machine visibility', () => {
  const workspaceId = 'encrypted-team' as WorkspaceId;
  const member = 'member-user';
  const owner = 'owner-user';
  type View = import('@lody/platform').E2eeMachineSharingView;
  const view = (machineId: string, overrides: Partial<View> = {}): View => ({
    machineId,
    ownerMembershipId: '11'.repeat(16),
    generation: '22'.repeat(16),
    head: { revision: 1, digest: '33'.repeat(32) },
    sharedWithTeam: true,
    projects: ['shared-project'],
    canManage: false,
    signer: '44'.repeat(32),
    needsResign: false,
    ...overrides,
  });
  const machine = (id: string, ownerUserId: string): MachineMeta & MachineLegacyMetaFields => ({
    id: id as MachineId,
    name: id,
    ownerUserId,
    cliVersion: '0.1.0',
    os: 'linux',
    sessions: [],
    localProjects: Object.fromEntries(
      ['shared-project', 'private-project'].map((projectId) => [
        projectId,
        { id: projectId, name: projectId, rootPath: `/synthetic/${projectId}`, createdAtMs: 1 },
      ])
    ) as MachineMeta['localProjects'],
  });

  let container: HTMLDivElement;
  let root: Root;
  let store: Store;
  let views: Map<string, View | Error>;
  let reads: string[];
  let snapshot: { machines: string[]; projects: string[]; managed?: string[] } | undefined;

  let renderTree: (node: ReactNode) => Promise<void>;
  const consumer: Record<string, string[]> = {};
  function Consumer({ name, enabled }: { name: string; enabled: boolean }) {
    const index = useVisibleMachineMetas({ includeMachineFlock: false, enabled });
    useEffect(() => {
      consumer[name] = [...index.machines.keys()].sort();
    }, [index, name]);
    return null;
  }
  function Probe() {
    const machines = useVisibleMachineMetas({ includeMachineFlock: false });
    const projects = useVisibleLocalProjectsFromMachineIndex(machines);
    useEffect(() => {
      snapshot = {
        machines: [...machines.machines.keys()].sort(),
        projects: [...projects.projects.keys()].sort(),
        managed: [...withoutEncryptedSharedMachines(machines.machines, machines).keys()].sort(),
      };
    }, [machines, projects]);
    return null;
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    store = createStore();
    views = new Map();
    reads = [];
    snapshot = undefined;
    queryMocks.machineRows = undefined;
    queryMocks.localProjectRows = undefined;
    store.set(userAtom, { id: member, name: 'Member', email: 'member@example.test' });
    store.set(currentWorkspaceSlugAtom, workspaceId);
    store.set(currentWorkspaceIdAtom, workspaceId);
    store.set(workspaceContentModeAtom, {
      accountId: member,
      workspaceId,
      workspaceSlug: workspaceId,
      descriptor: { workspaceId, contentMode: 'e2ee', contentModeVersion: 1 },
    } as never);
    store.set(runtimeAtom, {
      workspaceId,
      workspaceSlug: workspaceId,
      contentMode: 'e2ee',
      accountId: member,
    } as WorkspaceRuntime);
    store.set(machineMetaCacheAtom, {
      [getMachineRoomId('own-machine' as MachineId)]: machine('own-machine', member),
      [getMachineRoomId('shared-machine' as MachineId)]: machine('shared-machine', owner),
      [getMachineRoomId('private-machine' as MachineId)]: machine('private-machine', owner),
      [getMachineRoomId('failing-machine' as MachineId)]: machine('failing-machine', owner),
    });
    views.set('shared-machine', view('shared-machine'));
    views.set(
      'private-machine',
      view('private-machine', { sharedWithTeam: false, deniedReason: 'e2ee_machine_not_shared' })
    );
    views.set('failing-machine', new Error('e2ee_sharing_unavailable'));
    const platform = {
      ...TEST_CLOUD_PLATFORM,
      e2eeWorkspaces: {
        ...TEST_CLOUD_PLATFORM.e2eeWorkspaces,
        runtime: {
          readMachineSharing: async (id: string, machineId: string) => {
            // Reads for another workspace are recorded apart and never share its views.
            reads.push(id === workspaceId ? machineId : `${id}/${machineId}`);
            const value = views.get(id === workspaceId ? machineId : `${id}/${machineId}`);
            if (!value || value instanceof Error) throw value ?? new Error('missing');
            return value;
          },
        },
      },
    } as unknown as PlatformProvider;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    renderTree = (node) =>
      act(async () => {
        root.render(
          <PlatformContext.Provider value={platform}>
            <Provider store={store}>{node}</Provider>
          </PlatformContext.Provider>
        );
      });
    await renderTree(<Probe />);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('shows another member machine and its signed shared projects only when the verified view allows it', async () => {
    // Selection and execution only: automatic catalog writers and machine-RPC surfaces
    // (migration, bug reports, memory settings) never see the shared encrypted machine.
    expect(snapshot?.managed).toEqual(['own-machine']);
    expect(snapshot).toMatchObject({
      machines: ['own-machine', 'shared-machine'],
      projects: [
        'own-machine:private-project',
        'own-machine:shared-project',
        'shared-machine:shared-project',
      ],
    });
    // Own machines are never read through the sharing port.
    expect(reads.sort()).toEqual(['failing-machine', 'private-machine', 'shared-machine']);
  });

  it('removes a withdrawn machine on the next ledger change and on the bounded refresh', async () => {
    views.set(
      'shared-machine',
      view('shared-machine', { sharedWithTeam: false, deniedReason: 'e2ee_machine_not_shared' })
    );
    await act(async () => notifyE2eeLedgerChanged(member, workspaceId));
    expect(snapshot?.machines).toEqual(['own-machine']);
    views.set('shared-machine', view('shared-machine'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ENCRYPTED_SHARED_MACHINE_REFRESH_MS);
    });
    expect(snapshot?.machines).toEqual(['own-machine', 'shared-machine']);
    // A read failure removes access immediately rather than keeping the old grant.
    views.set('shared-machine', new Error('e2ee_sharing_unavailable'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ENCRYPTED_SHARED_MACHINE_REFRESH_MS);
    });
    expect(snapshot?.machines).toEqual(['own-machine']);
  });

  it('hides a shared machine from a Guest, whom core denies', async () => {
    views.set(
      'shared-machine',
      view('shared-machine', { deniedReason: 'e2ee_machine_not_shared' })
    );
    await act(async () => notifyE2eeLedgerChanged(member, workspaceId));
    expect(snapshot).toMatchObject({
      machines: ['own-machine'],
      projects: ['own-machine:private-project', 'own-machine:shared-project'],
    });
  });

  it("keeps a consumer's shared machines when another consumer of the same store is disabled", async () => {
    await renderTree(
      <>
        <Consumer name="a" enabled />
        <Consumer name="b" enabled />
      </>
    );
    expect(consumer.a).toEqual(['own-machine', 'shared-machine']);
    await renderTree(
      <>
        <Consumer name="a" enabled />
        <Consumer name="b" enabled={false} />
      </>
    );
    expect(consumer.a).toEqual(['own-machine', 'shared-machine']);
    // The remaining consumer still refreshes: withdrawal is observed on the interval.
    views.set(
      'shared-machine',
      view('shared-machine', { sharedWithTeam: false, deniedReason: 'e2ee_machine_not_shared' })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ENCRYPTED_SHARED_MACHINE_REFRESH_MS);
    });
    expect(consumer.a).toEqual(['own-machine']);
  });

  it('stops reading once every consumer is disabled', async () => {
    await renderTree(<Consumer name="a" enabled={false} />);
    reads.length = 0;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ENCRYPTED_SHARED_MACHINE_REFRESH_MS * 2);
    });
    await act(async () => notifyE2eeLedgerChanged(member, workspaceId));
    expect(reads).toEqual([]);
    expect(consumer.a).toEqual([]);
  });

  it('does not carry shared machines across a workspace switch', async () => {
    const other = 'encrypted-other' as WorkspaceId;
    await act(async () => {
      store.set(currentWorkspaceSlugAtom, other);
      store.set(currentWorkspaceIdAtom, other);
      store.set(workspaceContentModeAtom, {
        accountId: member,
        workspaceId: other,
        workspaceSlug: other,
        descriptor: { workspaceId: other, contentMode: 'e2ee', contentModeVersion: 1 },
      } as never);
      store.set(runtimeAtom, {
        workspaceId: other,
        workspaceSlug: other,
        contentMode: 'e2ee',
        accountId: member,
      } as WorkspaceRuntime);
    });
    expect(snapshot?.machines).toEqual(['own-machine']);
    expect(reads).toContain(`${other}/shared-machine`);
  });
});
