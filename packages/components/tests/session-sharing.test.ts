import { createSessionAccessStore } from '../src/lib/session-access-store';
import type { SessionAccessPort, SessionAccessView } from '@lody/platform';
import { describe, expect, it } from 'vitest';
import type { LocalProjectId, MachineId } from '@lody/shared';
import {
  getSessionSharingProjectKey,
  resolveSessionSharingState,
} from '../src/lib/session-sharing';
import type { MachineVisibilityAccess } from '../src/lib/visible-machine-index';
import type { LocalProjectVisibilityAccess } from '../src/lib/visible-local-project-index';

const machineId = 'machine-1' as MachineId;
const localProjectId = 'project-1' as LocalProjectId;

function machineAccess(sharedWithTeam: boolean): Map<MachineId, MachineVisibilityAccess> {
  return new Map([
    [
      machineId,
      {
        machineId,
        ownerUserId: 'user-1',
        sharedWithTeam,
        updatedAt: 1,
      },
    ],
  ]);
}

function projectAccess(sharedWithTeam: boolean): Map<string, LocalProjectVisibilityAccess> {
  return new Map([
    [
      getSessionSharingProjectKey(machineId, localProjectId),
      {
        machineId,
        localProjectId,
        ownerUserId: 'user-1',
        sharedWithTeam,
        updatedAt: 1,
      },
    ],
  ]);
}

const baseArgs = {
  currentUserId: 'user-1',
  machineName: 'Studio Mac',
  projectName: 'lody',
  isLoading: false,
};

describe('session sharing', () => {
  it('treats a non-project conversation as shared when its machine is shared', () => {
    expect(
      resolveSessionSharingState({
        ...baseArgs,
        session: { machineId },
        machineAccessByMachineId: machineAccess(true),
        localProjectAccessByKey: new Map(),
      })
    ).toMatchObject({ visibility: 'team', canManage: true, machineId });
  });

  it('explains that a private machine keeps a conversation private', () => {
    expect(
      resolveSessionSharingState({
        ...baseArgs,
        session: { machineId },
        machineAccessByMachineId: machineAccess(false),
        localProjectAccessByKey: new Map(),
      })
    ).toMatchObject({ visibility: 'private', privateReason: 'machine' });
  });

  it('requires both machine and project sharing for local-project conversations', () => {
    const session = {
      machineId,
      project: { kind: 'local', localProjectId },
    };

    expect(
      resolveSessionSharingState({
        ...baseArgs,
        session,
        machineAccessByMachineId: machineAccess(false),
        localProjectAccessByKey: projectAccess(false),
      })
    ).toMatchObject({ visibility: 'private', privateReason: 'machine-and-project' });
    expect(
      resolveSessionSharingState({
        ...baseArgs,
        session,
        machineAccessByMachineId: machineAccess(false),
        localProjectAccessByKey: projectAccess(true),
      })
    ).toMatchObject({ visibility: 'private', privateReason: 'machine' });
    expect(
      resolveSessionSharingState({
        ...baseArgs,
        session,
        machineAccessByMachineId: machineAccess(true),
        localProjectAccessByKey: projectAccess(false),
      })
    ).toMatchObject({ visibility: 'private', privateReason: 'project' });
    expect(
      resolveSessionSharingState({
        ...baseArgs,
        session,
        machineAccessByMachineId: machineAccess(true),
        localProjectAccessByKey: projectAccess(true),
      })
    ).toMatchObject({ visibility: 'team' });
  });

  it('keeps visibility unknown while authoritative access rows are loading', () => {
    expect(
      resolveSessionSharingState({
        ...baseArgs,
        isLoading: true,
        session: { machineId },
        machineAccessByMachineId: new Map(),
        localProjectAccessByKey: new Map(),
      })
    ).toMatchObject({ visibility: 'unknown', canManage: false });
  });

  it('does not treat the owner fallback as unregistered until access loading settles', () => {
    const fallbackAccess = machineAccess(false);
    fallbackAccess.set(machineId, {
      ...fallbackAccess.get(machineId)!,
      updatedAt: 0,
    });

    expect(
      resolveSessionSharingState({
        ...baseArgs,
        isLoading: true,
        session: { machineId },
        machineAccessByMachineId: fallbackAccess,
        localProjectAccessByKey: new Map(),
      })
    ).toMatchObject({ visibility: 'unknown', canManage: true });
  });

  it('does not offer sharing controls to a non-owner', () => {
    expect(
      resolveSessionSharingState({
        ...baseArgs,
        currentUserId: 'user-2',
        session: { machineId },
        machineAccessByMachineId: machineAccess(false),
        localProjectAccessByKey: new Map(),
      })
    ).toMatchObject({ visibility: 'private', canManage: false });
  });

  it('recognizes the owner-only fallback as an unregistered machine', () => {
    const fallbackAccess = machineAccess(false);
    fallbackAccess.set(machineId, {
      ...fallbackAccess.get(machineId)!,
      updatedAt: 0,
    });

    expect(
      resolveSessionSharingState({
        ...baseArgs,
        session: { machineId },
        machineAccessByMachineId: fallbackAccess,
        localProjectAccessByKey: new Map(),
      })
    ).toMatchObject({
      visibility: 'private',
      privateReason: 'machine-not-registered',
      canManage: true,
    });
  });
});

describe('live authoritative session access', () => {
  it('removes revoked grants and ignores a delayed older read after a version notification', async () => {
    let notify = () => {};
    let rows: SessionAccessView[] = [
      { machineId, readSharedSessionIds: ['root'], canManage: false },
    ];
    let completeRead!: (view: SessionAccessView) => void;
    const port: SessionAccessPort = {
      list: async () => rows,
      read: () =>
        new Promise((resolve) => {
          completeRead = resolve;
        }),
      set: async () => ({ status: 'saved' }),
      subscribe: (_workspace, invalidate) => {
        notify = invalidate;
        return () => {
          notify = () => {};
        };
      },
    };
    const store = createSessionAccessStore(port, 'workspace');
    await store.refresh();
    expect(store.getSnapshot().views.get(machineId)?.readSharedSessionIds).toEqual(['root']);
    const oldRead = store.read(machineId);
    rows = [{ machineId, readSharedSessionIds: [], canManage: false }];
    notify();
    await store.refresh();
    completeRead({ machineId, readSharedSessionIds: ['root'], canManage: false });
    await expect(oldRead).rejects.toThrow('session_access_superseded');
    expect(store.getSnapshot().views.get(machineId)?.readSharedSessionIds).toEqual([]);
    store.dispose();
    rows = [{ machineId, readSharedSessionIds: ['root'], canManage: false }];
    notify();
    expect(store.getSnapshot().views.get(machineId)?.readSharedSessionIds).toEqual([]);
  });
});

it('keeps unrelated revocations when a deep-link read finishes during a workspace refresh', async () => {
  const other = 'machine-other';
  let finishList!: (rows: SessionAccessView[]) => void;
  let finishRead!: (row: SessionAccessView) => void;
  let deferred = false;
  const initial = [
    { machineId, canManage: false, readSharedSessionIds: ['root'] },
    { machineId: other, canManage: false, readSharedSessionIds: ['other-root'] },
  ];
  const port: SessionAccessPort = {
    list: () =>
      deferred
        ? new Promise((resolve) => {
            finishList = resolve;
          })
        : Promise.resolve(initial),
    read: () =>
      new Promise((resolve) => {
        finishRead = resolve;
      }),
    set: async () => ({ status: 'saved' }),
    subscribe: () => () => {},
  };
  const store = createSessionAccessStore(port, 'workspace');
  await store.refresh();
  deferred = true;
  const refresh = store.refresh();
  const read = store.read(machineId);
  finishRead({ machineId, canManage: false, readSharedSessionIds: ['fresh-root'] });
  await read;
  finishList([]);
  await refresh;
  expect(store.getSnapshot().views.get(machineId)?.readSharedSessionIds).toEqual(['fresh-root']);
  expect(store.getSnapshot().views.has(other)).toBe(false);
  store.dispose();
});

it('contains a rejected live subscription and retries it before publishing grants', async () => {
  let ready = false;
  const port: SessionAccessPort = {
    subscribe: () => {
      if (!ready) throw new Error('account transition');
      return () => {};
    },
    list: async () => [{ machineId, canManage: false, readSharedSessionIds: ['root'] }],
    read: async () => ({ machineId, canManage: false, readSharedSessionIds: ['root'] }),
    set: async () => ({ status: 'saved' }),
  };
  const store = createSessionAccessStore(port, 'workspace');
  await store.refresh();
  expect(store.getSnapshot().views.size).toBe(0);
  ready = true;
  await store.refresh();
  expect(store.getSnapshot().views.get(machineId)?.readSharedSessionIds).toEqual(['root']);
  store.dispose();
});
