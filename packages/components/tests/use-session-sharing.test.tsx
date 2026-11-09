// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStaticStore, type PlatformProvider, type SessionAccessView } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import type { MachineId, SessionMeta, WorkspaceId } from '@lody/shared';
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
async function render(mode: 'plaintext' | 'e2ee') {
  const store = createStore();
  store.set(userAtom, { id: 'owner' } as never);
  store.set(currentWorkspaceIdAtom, workspaceId);
  store.set(currentWorkspaceSlugAtom, 'sharing');
  store.set(runtimeAtom, {
    workspaceId,
    workspaceSlug: 'sharing',
    accountId: 'owner',
    contentMode: mode,
  } as never);
  store.set(workspaceContentModeAtom, {
    accountId: 'owner',
    workspaceId,
    workspaceSlug: 'sharing',
    descriptor: { workspaceId, contentMode: mode, contentModeVersion: 1 },
  } as never);
  const platform: PlatformProvider = {
    ...TEST_CLOUD_PLATFORM,
    identity: {
      ...TEST_CLOUD_PLATFORM.identity,
      session: createStaticStore({ status: 'authenticated', user: { id: 'owner' } }),
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
        view = { ...view, readSharedSessionIds: input.level === 'read' ? [input.sessionId] : [] };
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
  it('refuses a non-owner even when a visible control retains its callback', async () => {
    await render(mode);
    const retained = result.resolve(session);
    view = { ...view, canManage: false };
    await expect(result.shareWithTeam(retained)).rejects.toThrow('session_access_not_owned');
    expect(view.readSharedSessionIds).toEqual([]);
  });
});
