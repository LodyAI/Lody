import { sessionMetaCacheAtom } from '../src/atoms/doc-meta';
// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStaticStore, type PlatformProvider, type SessionAccessView } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import { getSessionRoomId, type MachineId, type SessionMeta, type WorkspaceId } from '@lody/shared';
import { runtimeAtom } from '../src/atoms/runtime';
import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom, userAtom } from '../src/atoms';
import { workspaceContentModeAtom } from '../src/atoms/workspace-content-mode';
import { useSessionSharing } from '../src/hooks/use-session-sharing';
import { TEST_CLOUD_PLATFORM } from './test-platform';

const sources = vi.hoisted(() => ({ machine: null as unknown, project: null as unknown }));
vi.mock('../src/hooks/use-visible-machine-metas', () => ({
  useVisibleMachineMetas: () => sources.machine,
}));
vi.mock('../src/hooks/use-visible-local-projects', () => ({
  useVisibleLocalProjects: () => sources.project,
}));
vi.mock('../src/hooks/use-open-settings', () => ({
  useOpenSettings: () => ({ openSettings: () => {} }),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const workspaceId = 'sharing-workspace' as WorkspaceId;
const machineId = 'private-machine' as MachineId;
const session = {
  id: 'root',
  machineId,
  userId: 'assigned-teammate',
  title: 'Synthetic conversation',
} as SessionMeta;
let container: HTMLDivElement, root: Root;
let result: ReturnType<typeof useSessionSharing>;
let view: SessionAccessView;
function Probe() {
  const sharing = useSessionSharing();
  useEffect(() => {
    result = sharing;
  }, [sharing]);
  return null;
}
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  view = { machineId, readSharedSessionIds: [], canManage: true, generation: '11'.repeat(32) };
  sources.machine = {
    machines: new Map(),
    accessByMachineId: new Map([
      [machineId, { machineId, ownerUserId: 'owner', sharedWithTeam: false, updatedAt: 1 }],
    ]),
    isLoading: false,
  };
  sources.project = { projects: new Map(), accessByProjectKey: new Map(), isLoading: false };
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render(
  mode: 'plaintext' | 'e2ee',
  records: SessionMeta[] = [session],
  userId = 'owner'
) {
  const store = createStore();
  store.set(
    sessionMetaCacheAtom,
    Object.fromEntries(records.map((meta) => [getSessionRoomId(meta.id), meta]))
  );
  store.set(userAtom, { id: userId } as never);
  store.set(currentWorkspaceIdAtom, workspaceId);
  store.set(currentWorkspaceSlugAtom, 'sharing');
  store.set(runtimeAtom, {
    workspaceId,
    workspaceSlug: 'sharing',
    accountId: userId,
    contentMode: mode,
  } as never);
  store.set(workspaceContentModeAtom, {
    accountId: userId,
    workspaceId,
    workspaceSlug: 'sharing',
    descriptor: { workspaceId, contentMode: mode, contentModeVersion: 1 },
  } as never);
  const platform: PlatformProvider = {
    ...TEST_CLOUD_PLATFORM,
    identity: {
      ...TEST_CLOUD_PLATFORM.identity,
      session: createStaticStore({ status: 'authenticated', user: { id: userId } }),
    },
    workspaces: {
      ...TEST_CLOUD_PLATFORM.workspaces,
      state: createStaticStore({
        status: 'ready',
        workspaces: [
          { id: workspaceId, name: 'Sharing', slug: 'sharing', role: 'member', contentMode: mode },
        ],
        activeWorkspaceId: workspaceId,
      }),
    },
    sessionAccess: {
      list: async () => [view],
      read: async () => view,
      subscribe: () => () => {},
      set: async (input) => {
        if (!view.canManage) throw new Error('session_access_not_owned');
        if (!input.audience || input.audience === 'team')
          view = { ...view, readSharedSessionIds: input.level === 'read' ? [input.sessionId] : [] };
        else {
          const userId = input.audience.userId;
          const rows = (view.memberReadSharedSessions ?? []).filter(
            (row) => row.userId !== userId || row.sessionId !== input.sessionId
          );
          view = {
            ...view,
            memberReadSharedSessions:
              input.level === 'read' ? [...rows, { sessionId: input.sessionId, userId }] : rows,
          };
        }
        return { status: 'saved' };
      },
    },
  };
  await act(async () =>
    root.render(
      <PlatformContext.Provider value={platform}>
        <Provider store={store}>
          <Probe />
        </Provider>
      </PlatformContext.Provider>
    )
  );
}
describe.each(['plaintext', 'e2ee'] as const)('single-session sharing in %s', (mode) => {
  it('adds and removes one member independently of team access and refuses a nonowner', async () => {
    await render(mode);
    await act(async () => result.resolve(session).setMemberReadAccess!('reader', true));
    expect(result.resolve(session)).toMatchObject({
      visibility: 'private',
      memberUserIds: ['reader'],
    });
    await act(async () => result.shareWithTeam(result.resolve(session)));
    expect(view.memberReadSharedSessions).toEqual([{ sessionId: 'root', userId: 'reader' }]);
    await act(async () => result.resolve(session).setMemberReadAccess!('reader', false));
    expect(result.resolve(session)).toMatchObject({
      visibility: 'team',
      access: 'read',
      memberUserIds: [],
    });
    view = { ...view, canManage: false };
    await expect(result.resolve(session).setMemberReadAccess!('other', true)).rejects.toThrow(
      'session_access_not_owned'
    );
    expect(view.memberReadSharedSessions).toEqual([]);
  });
  it('resolves a selected reader without granting machine management', async () => {
    view = {
      ...view,
      canManage: false,
      memberReadSharedSessions: [{ sessionId: 'root', userId: 'reader' }],
    };
    await render(mode, [session], 'reader');
    expect(result.resolve(session)).toMatchObject({
      visibility: 'private',
      access: 'read',
      canManage: false,
      memberUserIds: ['reader'],
    });
  });
  it('grants and revokes read access without enabling the machine or using the session owner', async () => {
    await render(mode);
    expect(result.resolve(session)).toMatchObject({ access: 'private', canManage: true });
    await act(async () => result.shareWithTeam(result.resolve(session)));
    expect(result.resolve(session)).toMatchObject({ access: 'read', canManage: true });
    expect(view.readSharedSessionIds).toEqual(['root']);
    expect(
      (
        sources.machine as { accessByMachineId: Map<string, { sharedWithTeam: boolean }> }
      ).accessByMachineId.get(machineId)?.sharedWithTeam
    ).toBe(false);
    expect(result.resolve({ ...session, machineId: 'other-machine' as MachineId })).toMatchObject({
      access: 'private',
      canManage: false,
    });
    await act(async () => result.resolve(session).setReadAccess!(null));
    expect(result.resolve(session).access).toBe('private');
  });
  it.each(['tab', 'side-panel', 'sidebar', 'other-machine'] as const)(
    'targets a %s share according to the containment contract',
    async (kind) => {
      const child = {
        ...session,
        id: 'child',
        parentSessionId: session.id,
        ...(kind === 'tab' || kind === 'other-machine' ? {} : { childSessionPlacement: kind }),
      } as unknown as SessionMeta;
      const parent =
        kind === 'other-machine'
          ? { ...session, machineId: 'other-machine' as MachineId }
          : session;
      await render(mode, [parent, child]);
      await act(async () => result.resolve(child).setReadAccess!('read'));
      expect(view.readSharedSessionIds).toEqual([
        kind === 'tab' || kind === 'side-panel' ? session.id : child.id,
      ]);
      expect(result.resolve(child).access).toBe('read');
    }
  );
  it('refuses a non-owner even when a visible control retains its callback', async () => {
    await render(mode);
    const retained = result.resolve(session);
    view = { ...view, canManage: false };
    await expect(result.shareWithTeam(retained)).rejects.toThrow('session_access_not_owned');
    expect(view.readSharedSessionIds).toEqual([]);
  });
});
