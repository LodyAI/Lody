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

const resource = {
  memoryBytes: 1,
  cpuCores: 0,
  cpuPercentOfMachine: 0,
  processCount: 1,
  memoryKind: 'rss-sum',
  quality: 'estimated-tree',
};
const session = {
  sessionId: 'session',
  parentSessionId: null,
  status: 'idle',
  cleanup: null,
  resource,
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

it('rejects private fields nested in either resource object', () => {
  const populated = { ...sample, cliControlPlane: resource, sessions: [session] };
  expect(MachineResourceHistorySchema.safeParse({ ...receipt, samples: [populated] }).success).toBe(
    true
  );
  for (const modified of [
    { ...populated, cliControlPlane: { ...resource, commandLine: 'private' } },
    { ...populated, sessions: [{ ...session, resource: { ...resource, environment: 'private' } }] },
  ]) {
    expect(
      MachineResourceHistorySchema.safeParse({ ...receipt, samples: [modified] }).success
    ).toBe(false);
  }
});

it('accepts only the monitor protocol session statuses', () => {
  for (const status of [
    'initializing',
    'running',
    'waiting_permission',
    'finalizing',
    'idle',
    'stopping',
    'failed',
  ]) {
    expect(
      MachineResourceHistorySchema.safeParse({
        ...receipt,
        samples: [{ ...sample, sessions: [{ ...session, status }] }],
      }).success
    ).toBe(true);
  }
  for (const status of ['', 'unknown', 'completed']) {
    expect(
      MachineResourceHistorySchema.safeParse({
        ...receipt,
        samples: [{ ...sample, sessions: [{ ...session, status }] }],
      }).success
    ).toBe(false);
  }
});
