import { describe, expect, it } from 'vitest';
import type { LocalProjectId, MachineId } from '@lody/shared';
import { filterSessionsByVisibility, isSessionVisibleToUser } from '../src/lib/session-visibility';
import { getLocalProjectVisibilityKey } from '../src/lib/visible-local-project-index';

const m1 = 'machine-1' as MachineId;
const m2 = 'machine-2' as MachineId;
const p1 = 'project-1' as LocalProjectId;

describe('session visibility', () => {
  it('keeps the current user local-project session visible without project access rows', () => {
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

  it('keeps local-project sessions when the project is visible but the machine is not', () => {
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
    ).toEqual([{ id: 's1', machineId: m1, project: { kind: 'local', localProjectId: p1 } }]);
  });

  it('fails closed for unconfirmed sessions during machine visibility loading', () => {
    const sessions = [
      { id: 's1', machineId: m1, project: { kind: 'local' as const, localProjectId: p1 } },
      { id: 's2', machineId: m2 },
    ];

    expect(filterSessionsByVisibility(sessions, new Set(), new Set(), true)).toEqual([]);
  });

  it('keeps local-project sessions during loading when the project key is already visible', () => {
    const sessions = [
      { id: 's1', machineId: m1, project: { kind: 'local' as const, localProjectId: p1 } },
      { id: 's2', machineId: m2 },
    ];

    expect(
      filterSessionsByVisibility(
        sessions,
        new Set(),
        new Set([getLocalProjectVisibilityKey(m1, p1)]),
        true
      )
    ).toEqual([{ id: 's1', machineId: m1, project: { kind: 'local', localProjectId: p1 } }]);
  });

  it('keeps the current user session visible during machine visibility loading', () => {
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
