import { describe, expect, it } from 'vitest';
import { type MachineId, type MachineMeta } from '@lody/shared';
import { sortMachineMetas, toMachineListEntry } from './machine';

const createMachine = (overrides: Partial<MachineMeta> = {}): MachineMeta => ({
  id: 'machine-id',
  name: 'Machine',
  cliVersion: '0.0.0',
  os: 'linux',
  sessions: [],
  ...overrides,
});

describe('machine command helpers', () => {
  it('separates a machine missing from a joined presence room from an unavailable room', () => {
    const machine = createMachine({ id: 'machine-1' });

    // A joined room that simply lacks the entry is real evidence the machine is down.
    const absent = toMachineListEntry(machine, { online: new Set<MachineId>(), synced: true });
    expect(absent.online).toBe(false);
    expect(absent.onlineStatus).toBe('offline');

    const present = toMachineListEntry(machine, {
      online: new Set<MachineId>(['machine-1' as MachineId]),
      synced: true,
    });
    expect(present.online).toBe(true);
    expect(present.onlineStatus).toBe('online');

    // Without a joined room and a fresh heartbeat, nothing proved the machine up or down.
    // `online` stays false, but a --json consumer reading stdout must still be able to
    // tell that apart from a confident offline: the distinction used to exist only in a
    // stderr warning.
    const unavailable = toMachineListEntry(machine, {
      online: new Set<MachineId>(),
      synced: false,
    });
    expect(unavailable.online).toBe(false);
    expect(unavailable.onlineStatus).toBe('unknown');

    // A heartbeat received before the room left 'joined' (a live-read recycle or a
    // failed local POST) still proves the machine up.
    const recycling = toMachineListEntry(machine, {
      online: new Set<MachineId>(['machine-1' as MachineId]),
      synced: false,
    });
    expect(recycling.onlineStatus).toBe('online');
  });

  it('sorts machines by presence-online state, current machine, then name', () => {
    const machines = [
      createMachine({ id: 'machine-2', name: 'Beta' }),
      createMachine({ id: 'machine-3', name: 'Gamma' }),
      createMachine({ id: 'machine-1', name: 'Alpha' }),
    ];
    const onlineMachineIds = new Set<MachineId>([
      'machine-1' as MachineId,
      'machine-3' as MachineId,
    ]);

    expect(
      sortMachineMetas(machines, onlineMachineIds, 'machine-1').map((machine) => machine.id)
    ).toEqual(['machine-1', 'machine-3', 'machine-2']);
  });
});
