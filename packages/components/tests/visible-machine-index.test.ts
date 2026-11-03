import { describe, expect, it } from 'vitest';
import type { MachineId, MachineViewMeta } from '@lody/shared';
import {
  buildVisibleMachineIndex,
  type MachineVisibilityAccess,
} from '../src/lib/visible-machine-index';

const m1 = 'machine-1' as MachineId;
const m2 = 'machine-2' as MachineId;
const m3 = 'machine-3' as MachineId;

function machine(id: MachineId, overrides?: Partial<MachineViewMeta>): MachineViewMeta {
  return {
    id,
    name: `name-${id}`,
    cliVersion: '0.0.0',
    os: 'linux',
    sessions: [],
    raceLimits: {},
    ...overrides,
  };
}

function row(
  overrides: Partial<MachineVisibilityAccess> & { machineId: string }
): MachineVisibilityAccess {
  return {
    ownerUserId: 'user-1',
    sharedWithTeam: false,
    updatedAt: 1,
    ...overrides,
  };
}

describe('buildVisibleMachineIndex', () => {
  it('still applies the privacy filter while loading', () => {
    // Regression: passing raw Loro machines through during load leaked
    // teammates' unshared machines on settings-page refresh. During load we
    // only synthesize access for the current user's own machines; shared
    // teammate machines appear once `convexAccessRows` resolves.
    const rawMachines = new Map<MachineId, MachineViewMeta>([
      [m1, machine(m1, { ownerUserId: 'user-1' })],
      [m2, machine(m2, { ownerUserId: 'user-other' })],
    ]);
    const result = buildVisibleMachineIndex({
      rawMachines,
      convexAccessRows: [],
      currentUserId: 'user-1',
      isLoading: true,
    });

    expect(result.isLoading).toBe(true);
    expect(result.machines.has(m1)).toBe(true);
    expect(result.machines.has(m2)).toBe(false);
    expect(result.accessByMachineId.get(m1)?.ownerUserId).toBe('user-1');
  });

  it('synthesizes an own+private access entry for an unregistered own machine', () => {
    // BC-2026-04-16-MACHINE-VISIBILITY-OWNER-FALLBACK: old CLI never wrote a
    // workspaceMachines row, but Loro still knows ownerUserId.
    const rawMachines = new Map<MachineId, MachineViewMeta>([
      [m1, machine(m1, { ownerUserId: 'user-1', lastSeen: 123 })],
    ]);
    const result = buildVisibleMachineIndex({
      rawMachines,
      convexAccessRows: [],
      currentUserId: 'user-1',
      isLoading: false,
    });

    expect(result.machines.has(m1)).toBe(true);
    expect(result.accessByMachineId.get(m1)).toEqual({
      machineId: m1,
      ownerUserId: 'user-1',
      sharedWithTeam: false,
      updatedAt: 0,
    });
  });

  it('keeps shared team machines from Convex even when not owned by current user', () => {
    const rawMachines = new Map<MachineId, MachineViewMeta>([
      [m1, machine(m1, { ownerUserId: 'user-other' })],
    ]);
    const result = buildVisibleMachineIndex({
      rawMachines,
      convexAccessRows: [row({ machineId: m1, ownerUserId: 'user-other', sharedWithTeam: true })],
      currentUserId: 'user-1',
      isLoading: false,
    });

    expect(result.machines.has(m1)).toBe(true);
  });

  it('uses the latest access row instead of treating duplicate rows as co-owners', () => {
    const rawMachines = new Map<MachineId, MachineViewMeta>([
      [m1, machine(m1, { ownerUserId: 'user-other' })],
    ]);
    const result = buildVisibleMachineIndex({
      rawMachines,
      convexAccessRows: [
        row({ machineId: m1, ownerUserId: 'user-other', sharedWithTeam: true, updatedAt: 42 }),
        row({ machineId: m1, ownerUserId: 'user-1', sharedWithTeam: false, updatedAt: 1 }),
      ],
      currentUserId: 'user-1',
      isLoading: false,
    });

    expect(result.accessByMachineId.get(m1)).toEqual({
      machineId: m1,
      ownerUserId: 'user-other',
      sharedWithTeam: true,
      updatedAt: 42,
    });
    expect(result.machines.get(m1)?.ownerUserId).toBe('user-other');
  });

  it('ignores access rows whose machine is not in the local Loro cache', () => {
    const rawMachines = new Map<MachineId, MachineViewMeta>();
    const result = buildVisibleMachineIndex({
      rawMachines,
      convexAccessRows: [row({ machineId: m3, ownerUserId: 'user-1' })],
      currentUserId: 'user-1',
      isLoading: false,
    });

    // Machine metadata isn't synced locally yet — skip it instead of rendering
    // a blank entry. The access row is still reachable via accessByMachineId.
    expect(result.machines.size).toBe(0);
    expect(result.accessByMachineId.has(m3)).toBe(true);
  });

  it('does not synthesize when current user is unknown', () => {
    const rawMachines = new Map<MachineId, MachineViewMeta>([
      [m1, machine(m1, { ownerUserId: 'user-1' })],
    ]);
    const result = buildVisibleMachineIndex({
      rawMachines,
      convexAccessRows: [],
      currentUserId: null,
      isLoading: false,
    });

    expect(result.machines.size).toBe(0);
  });

  it('does not synthesize when MachineViewMeta.ownerUserId is undefined', () => {
    // Pre-PR-#1060 machines have no ownerUserId field — we cannot claim them
    // for the current user, so they stay hidden until the CLI restarts.
    const rawMachines = new Map<MachineId, MachineViewMeta>([[m1, machine(m1)]]);
    const result = buildVisibleMachineIndex({
      rawMachines,
      convexAccessRows: [],
      currentUserId: 'user-1',
      isLoading: false,
    });

    expect(result.machines.size).toBe(0);
    expect(result.accessByMachineId.size).toBe(0);
  });
});
