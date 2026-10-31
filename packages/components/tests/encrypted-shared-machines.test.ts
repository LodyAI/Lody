import { expect, it } from 'vitest';
import type { MachineId } from '@lody/shared';
import type { E2eeMachineSharingView } from '@lody/platform';
import { createEncryptedSharedMachineStore } from '../src/lib/encrypted-shared-machines';

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
  store.setCandidates(['a', 'b', 'c'] as MachineId[]);
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
  store.setCandidates(['c'] as MachineId[]);
  expect([...store.getSnapshot().keys()]).toEqual(['c']);
  store.dispose();
  expect(intervals[0]!.cleared).toBe(true);
});
