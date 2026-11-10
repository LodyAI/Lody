import { describe, expect, it } from 'vitest';
import type { LocalProjectId, MachineId } from '@lody/shared';
import {
  filterSessionsByVisibility,
  isSessionVisibleToUser,
  isSessionEditableToUser,
  getSessionOwnerAccessReason,
  isSessionReadShared,
  resolveSessionVisibilityState,
} from '../src/lib/session-visibility';
import { getLocalProjectVisibilityKey } from '../src/lib/visible-local-project-index';

const m1 = 'machine-1' as MachineId;
const m2 = 'machine-2' as MachineId;
const p1 = 'project-1' as LocalProjectId;

describe('session visibility', () => {
  it('keeps the assigned conversation owner visible without granting machine access', () => {
    expect(
      isSessionVisibleToUser(
        {
          id: 's1',
          machineId: m1,
          userId: 'user-1',
          project: { kind: 'local' as const, localProjectId: p1 },
        },
        new Set<MachineId>(),
        new Set<string>(),
        'user-1'
      )
    ).toBe(true);
  });

  it('still hides another user local-project session when the project is not visible', () => {
    expect(
      isSessionVisibleToUser(
        {
          id: 's1',
          machineId: m1,
          userId: 'user-2',
          project: { kind: 'local' as const, localProjectId: p1 },
        },
        new Set<MachineId>([m1]),
        new Set<string>(),
        'user-1'
      )
    ).toBe(false);
  });

  it('includes owner sessions and visible shared sessions', () => {
    const sessions = [
      { id: 's-owner', machineId: m2, userId: 'user-1' },
      { id: 's-shared-machine', machineId: m1, userId: 'user-2' },
      {
        id: 's-hidden-local',
        machineId: m2,
        userId: 'user-2',
        project: { kind: 'local' as const, localProjectId: p1 },
      },
      {
        id: 's-visible-local',
        machineId: m1,
        userId: 'user-2',
        project: { kind: 'local' as const, localProjectId: p1 },
      },
    ];

    expect(
      filterSessionsByVisibility(
        sessions,
        new Set([m1]),
        new Set([getLocalProjectVisibilityKey(m1, p1)]),
        false,
        'user-1'
      ).map((item) => item.id)
    ).toEqual(['s-owner', 's-shared-machine', 's-visible-local']);
  });

  it('hides a local-project session when machine access is revoked before its project index refreshes', () => {
    const sessions = [
      { id: 's1', machineId: m1, project: { kind: 'local' as const, localProjectId: p1 } },
      { id: 's2', machineId: m2, project: { kind: 'local' as const, localProjectId: p1 } },
    ];

    expect(
      filterSessionsByVisibility(
        sessions,
        new Set(),
        new Set([getLocalProjectVisibilityKey(m1, p1)])
      )
    ).toEqual([]);
  });

  it('fails closed for unconfirmed sessions during machine visibility loading', () => {
    const sessions = [
      { id: 's1', machineId: m1, project: { kind: 'local' as const, localProjectId: p1 } },
      { id: 's2', machineId: m2 },
    ];

    expect(filterSessionsByVisibility(sessions, new Set(), new Set(), true)).toEqual([]);
  });

  it('keeps local-project sessions during loading when both access indexes already admit it', () => {
    const sessions = [
      { id: 's1', machineId: m1, project: { kind: 'local' as const, localProjectId: p1 } },
      { id: 's2', machineId: m2 },
    ];

    expect(
      filterSessionsByVisibility(
        sessions,
        new Set([m1]),
        new Set([getLocalProjectVisibilityKey(m1, p1)]),
        true
      )
    ).toEqual([{ id: 's1', machineId: m1, project: { kind: 'local', localProjectId: p1 } }]);
  });

  it('keeps a metadata owner session visible during machine visibility loading', () => {
    const sessions = [
      { id: 's-owner', machineId: m1, userId: 'user-1' },
      { id: 's-other', machineId: m2, userId: 'user-2' },
    ];

    expect(
      filterSessionsByVisibility(sessions, new Set(), new Set(), true, 'user-1').map(
        (item) => item.id
      )
    ).toEqual(['s-owner']);
  });
});

describe('owner transfer never grants machine or project access', () => {
  const session = { machineId: m1, userId: 'a', project: { kind: 'local', localProjectId: p1 } };
  const machine = { machineId: m1, ownerUserId: 'a', sharedWithTeam: false, updatedAt: 1 };
  const project = { ...machine, localProjectId: p1 };
  const key = getLocalProjectVisibilityKey(m1, p1);
  it('allows the machine owner and refuses a colleague on a private machine', () => {
    expect(
      getSessionOwnerAccessReason(session, 'a', new Map([[m1, machine]]), new Map())
    ).toBeNull();
    expect(
      getSessionOwnerAccessReason(session, 'b', new Map([[m1, machine]]), new Map([[key, project]]))
    ).toBe('machineNotShared');
  });
  it('requires both machine and local project sharing, regardless of current session owner', () => {
    const machines = new Map([[m1, { ...machine, sharedWithTeam: true }]]);
    expect(
      getSessionOwnerAccessReason(
        { ...session, userId: 'b' },
        'b',
        machines,
        new Map([[key, project]])
      )
    ).toBe('projectNotShared');
    expect(
      getSessionOwnerAccessReason(
        session,
        'b',
        machines,
        new Map([[key, { ...project, sharedWithTeam: true }]])
      )
    ).toBeNull();
    expect(getSessionOwnerAccessReason(session, 'b', new Map(), new Map())).toBe(
      'machineUnavailable'
    );
  });
});

it('keeps transferred local-project history visible to the machine owner after the project is removed', () => {
  expect(
    isSessionVisibleToUser(
      { machineId: m1, userId: 'b', project: { kind: 'local', localProjectId: p1 } },
      new Set([m1]),
      new Set(),
      'a',
      new Set([m1])
    )
  ).toBe(true);
});

describe('machine-bound session read grants', () => {
  const root = { id: 'root', machineId: m1, userId: 'different-session-owner' };
  const child = { id: 'child', machineId: m1, parentSessionId: 'root' };
  const views = new Map([
    [m1, { machineId: m1, canManage: false, readSharedSessionIds: ['root'] }],
  ]);
  it('shows only the granted root and its contained tabs, without machine execution access', () => {
    const records = new Map([
      ['root', root],
      ['child', child],
    ]);
    expect(isSessionReadShared(root, views, records)).toBe(true);
    expect(isSessionReadShared(child, views, records)).toBe(true);
    expect(
      filterSessionsByVisibility(
        [root, child, { id: 'other', machineId: m1 }],
        new Set(),
        new Set(),
        false,
        'viewer',
        false,
        new Set(),
        views,
        records
      ).map((row) => row.id)
    ).toEqual(['root', 'child']);
    expect(isSessionVisibleToUser(root, new Set(), new Set(), 'viewer')).toBe(false);
  });
  it('withdraws on revocation, machine reassignment or a substituted binding', () => {
    expect(isSessionReadShared(root, new Map())).toBe(false);
    expect(isSessionReadShared({ ...root, machineId: m2 }, views)).toBe(false);
    expect(isSessionReadShared(root, new Map([[m1, { ...views.get(m1)!, machineId: m2 }]]))).toBe(
      false
    );
    expect(isSessionReadShared({ ...child, machineId: m2 }, views, new Map([['root', root]]))).toBe(
      false
    );
  });
  it('retains only assigned-owner and machine-owner visibility, not all E2EE history', () => {
    expect(
      resolveSessionVisibilityState(root, new Set(), new Set(), {
        workspaceHistoryReadable: true,
        currentUserId: root.userId,
      })
    ).toBe('visible');
    expect(
      resolveSessionVisibilityState(root, new Set(), new Set(), {
        currentUserId: 'machine-owner',
        ownedMachineIds: new Set([m1]),
      })
    ).toBe('visible');
  });
});

it('inherits read access only through a direct same-machine contained Tab or side panel', () => {
  const root = { id: 'root', machineId: m1 };
  const views = new Map([
    [m1, { machineId: m1, canManage: false, readSharedSessionIds: ['root'] }],
  ]);
  const records = new Map([['root', root]]);
  const child = { id: 'child', machineId: m1, parentSessionId: 'root' };
  expect(isSessionReadShared(child, views, records)).toBe(true);
  expect(
    isSessionReadShared({ ...child, childSessionPlacement: 'side-panel' }, views, records)
  ).toBe(true);
  expect(isSessionReadShared({ ...child, childSessionPlacement: 'sidebar' }, views, records)).toBe(
    false
  );
  expect(isSessionReadShared({ ...child, machineId: m2 }, views, records)).toBe(false);
  expect(
    isSessionReadShared({ id: 'opened', machineId: m1, openedBySessionId: 'root' }, views, records)
  ).toBe(false);
  expect(
    isSessionReadShared(child, views, new Map([['root', { ...root, parentSessionId: 'other' }]]))
  ).toBe(false);
});

it('assignment admits reading but never editing or machine access', () => {
  const assigned = { id: 'assigned', machineId: m1, userId: 'me' };
  expect(isSessionVisibleToUser(assigned, new Set(), new Set(), 'me')).toBe(true);
  expect(isSessionEditableToUser(assigned, new Set(), new Set(), 'me')).toBe(false);
  expect(isSessionEditableToUser(assigned, new Set([m1]), new Set(), 'me')).toBe(true);
});

it('limits personal read grants to that account, bound machine and contained root, then withdraws', () => {
  const root = { id: 'personal-root', machineId: m1, userId: 'someone' };
  const child = { id: 'contained', machineId: m1, parentSessionId: root.id };
  const view = {
    machineId: m1,
    canManage: false,
    readSharedSessionIds: [],
    memberReadSharedSessions: [{ sessionId: root.id, userId: 'reader' }],
  };
  const views = new Map([[m1, view]]),
    records = new Map([
      [root.id, root],
      [child.id, child],
    ]);
  const options = { currentUserId: 'reader', readSharedSessions: views, sessionsById: records };
  expect(resolveSessionVisibilityState(root, new Set(), new Set(), options)).toBe('visible');
  expect(resolveSessionVisibilityState(child, new Set(), new Set(), options)).toBe('visible');
  expect(
    resolveSessionVisibilityState(root, new Set(), new Set(), {
      ...options,
      currentUserId: 'other',
    })
  ).toBe('hidden');
  expect(
    resolveSessionVisibilityState({ ...root, machineId: m2 }, new Set(), new Set(), options)
  ).toBe('hidden');
  view.memberReadSharedSessions = [];
  expect(resolveSessionVisibilityState(root, new Set(), new Set(), options)).toBe('hidden');
});
