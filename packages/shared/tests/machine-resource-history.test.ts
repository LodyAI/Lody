import { expect, it } from 'vitest';
import { MachineResourceHistorySchema } from '../src/machine-monitor';

const sample = {
  sampledAtMs: 1,
  source: 'unavailable',
  cliControlPlane: null,
  memoryKind: 'rss-sum',
  processesTruncated: false,
  sessionsTruncated: false,
  processes: [],
  sessions: [],
};
const receipt = {
  type: 'machine/resource-history',
  machineId: 'machine',
  instanceId: 'instance',
  collectedWhileObserved: true,
  samples: [sample],
};

it('accepts bounded observation receipts and rejects oversized arrays or raw diagnostics', () => {
  expect(MachineResourceHistorySchema.safeParse(receipt).success).toBe(true);
  expect(
    MachineResourceHistorySchema.safeParse({ ...receipt, samples: Array(121).fill(sample) }).success
  ).toBe(false);
  expect(
    MachineResourceHistorySchema.safeParse({
      ...receipt,
      samples: [{ ...sample, commandLine: 'private' }],
    }).success
  ).toBe(false);
  expect(
    MachineResourceHistorySchema.safeParse({ ...receipt, collectedWhileObserved: false }).success
  ).toBe(false);
});
