import { expect, it } from 'vitest';
import type { MachineId } from '@lody/shared';
import type { E2eeMachineSharingView } from '@lody/platform';
import {
  acquireEncryptedSharedMachineStore,
  createEncryptedSharedMachineStore,
} from '../src/lib/encrypted-shared-machines';

const view = (machineId: string, projects: string[] = []): E2eeMachineSharingView => ({
  machineId,
  ownerMembershipId: '11'.repeat(16),
  generation: '22'.repeat(16),
  head: { revision: 1, digest: '33'.repeat(32) },
  sharedWithTeam: true,
  projects,
  canManage: false,
  signer: null,
  needsResign: false,
});

it('bounds concurrent reads, fences stale results, drops removed candidates and stops on dispose', async () => {
  const pending: { machineId: string; settle: (value: E2eeMachineSharingView) => void }[] = [];
  let active = 0;
  let peak = 0;
  const intervals: { callback: () => void; cleared: boolean }[] = [];
  const store = createEncryptedSharedMachineStore({
    workspaceId: 'workspace',
    port: {
      readMachineSharing: (_workspaceId, machineId) =>
        new Promise((resolve) => {
          active += 1;
          peak = Math.max(peak, active);
          pending.push({
            machineId,
            settle: (value) => {
              active -= 1;
              resolve(value);
            },
          });
        }),
    },
    timers: {
      setInterval: (callback) => {
        const entry = { callback, cleared: false };
        intervals.push(entry);
        return entry;
      },
      clearInterval: (handle) => {
        (handle as (typeof intervals)[number]).cleared = true;
      },
    },
  });
  // Read settlement chains three promise steps; drain them without any timer.
  const flush = async () => {
    for (let turn = 0; turn < 8; turn++) await Promise.resolve();
  };
  const lease = Symbol('lease');
  store.setCandidates(lease, ['a', 'b', 'c'] as MachineId[]);
  expect(pending.map((read) => read.machineId)).toEqual(['a', 'b']);
  pending.shift()!.settle(view('a', ['p']));
  await flush();
  expect(peak).toBe(2);
  expect([...store.getSnapshot().keys()]).toEqual(['a']);
  // A refresh starts a newer read of `a`; the older in-flight `b` read still lands.
  intervals[0]!.callback();
  pending.shift()!.settle(view('b'));
  await flush();
  const newerA = pending.find((read) => read.machineId === 'a')!;
  newerA.settle({ ...view('a'), sharedWithTeam: false, deniedReason: 'e2ee_machine_not_shared' });
  await flush();
  expect(store.getSnapshot().has('a')).toBe(false);
  for (const read of pending.splice(0)) read.settle(view(read.machineId));
  await flush();
  // Dropping a candidate removes it immediately.
  store.setCandidates(lease, ['c'] as MachineId[]);
  expect([...store.getSnapshot().keys()]).toEqual(['c']);
  store.dispose();
  expect(intervals[0]!.cleared).toBe(true);
});

it('reads the union of live leases, and a released lease cannot rewrite it', async () => {
  const intervals: unknown[] = [];
  const create = () =>
    createEncryptedSharedMachineStore({
      workspaceId: 'workspace',
      port: { readMachineSharing: async (_workspaceId, machineId) => view(machineId) },
      timers: {
        setInterval: (callback) => {
          intervals.push(callback);
          return callback;
        },
        clearInterval: (handle) => {
          intervals.splice(intervals.indexOf(handle), 1);
        },
      },
    });
  const flush = async () => {
    for (let turn = 0; turn < 8; turn++) await Promise.resolve();
  };
  const key = { accountId: 'account', workspaceId: 'workspace' };
  const first = acquireEncryptedSharedMachineStore(key, create);
  const second = acquireEncryptedSharedMachineStore(key, create);
  expect(second.store).toBe(first.store);
  first.setCandidates(['a'] as MachineId[]);
  second.setCandidates(['b'] as MachineId[]);
  await flush();
  expect([...first.store.getSnapshot().keys()].sort()).toEqual(['a', 'b']);
  second.release();
  second.setCandidates([]);
  expect([...first.store.getSnapshot().keys()]).toEqual(['a']);
  first.release();
  expect(intervals).toEqual([]);
});
