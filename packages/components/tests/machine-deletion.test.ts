import { describe, expect, it } from 'vitest';

import { type MachineId, type MachineMeta } from '@lody/shared';

import {
  canDeleteOfflineMachine,
  canManageAllMachines,
  evaluateMachineDeletion,
  prepareMachineForDeletion,
} from '../src/lib/machine-deletion';

const currentUserId = 'user-1';
const otherUserId = 'user-2';

const createMachine = (overrides: Partial<MachineMeta> = {}): MachineMeta => ({
  id: 'machine-1' as MachineId,
  name: 'Machine 1',
  cliVersion: '0.1.0',
  os: 'linux',
  sessions: [],
  ...overrides,
});

describe('machine deletion helpers', () => {
  it('allows deleting the current local machine even without owner metadata', () => {
    expect(
      canDeleteOfflineMachine({
        machine: createMachine({ id: 'machine-local' as MachineId }),
        isOnline: false,
        currentUserId,
        localMachineId: 'machine-local' as MachineId,
        canManageAllMachines: false,
      })
    ).toBe(true);
  });

  it('allows admins to delete other users offline machines', () => {
    expect(
      canDeleteOfflineMachine({
        machine: createMachine({ ownerUserId: otherUserId }),
        isOnline: false,
        currentUserId,
        localMachineId: null,
        canManageAllMachines: true,
      })
    ).toBe(true);
  });

  it('rejects deleting other users offline machines for regular members', () => {
    expect(
      canDeleteOfflineMachine({
        machine: createMachine({ ownerUserId: otherUserId }),
        isOnline: false,
        currentUserId,
        localMachineId: null,
        canManageAllMachines: false,
      })
    ).toBe(false);
  });

  it('prepares deletion checks from the latest metadata and blocks online machines', () => {
    const machineId = 'machine-1' as MachineId;

    const prepared = prepareMachineForDeletion({
      machine: createMachine({
        id: machineId,
        ownerUserId: otherUserId,
      }),
      latestMeta: {
        id: 'stale-id-from-meta' as MachineId,
        ownerUserId: currentUserId,
      },
    });

    expect(prepared.id).toBe(machineId);
    expect(prepared.ownerUserId).toBe(currentUserId);
    expect(
      evaluateMachineDeletion({
        machine: prepared,
        isOnline: true,
        currentUserId,
        localMachineId: null,
        canManageAllMachines: false,
      }).type
    ).toBe('online');
    expect(
      evaluateMachineDeletion({
        machine: prepared,
        isOnline: false,
        currentUserId,
        localMachineId: null,
        canManageAllMachines: false,
      }).type
    ).toBe('allowed');
  });
});
