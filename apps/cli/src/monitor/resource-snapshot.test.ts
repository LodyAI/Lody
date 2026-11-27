import { describe, expect, it } from 'vitest';
import { MachinePresenceResourceSampler } from './machine-presence-resources';
import { parseCpuTimeMicros } from './process-table';
import { aggregateProcessTreeUsage } from './process-tree';
import { resolveAggregateMemoryKind, toDeviceCpuCores, toResourceUsage } from './resource-snapshot';
import type { ProcessTableEntry } from './process-table';
import type { MachineMonitorMemoryKind, SessionId } from '@lody/shared';

const sessionId = (value: string) => value as SessionId;

describe('resource snapshot helpers', () => {
  it('computes CPU cores from cumulative CPU time', () => {
    expect(
      toResourceUsage({
        current: {
          memoryBytes: 10,
          cpuTimeMicros: 5_000_000,
          processCount: 1,
          memoryKind: 'rss',
          quality: 'exact-process',
        },
        previousCpuTimeMicros: 1_000_000,
        windowMs: 2_000,
        logicalCpuCount: 8,
      })
    ).toMatchObject({ cpuCores: 2, cpuPercentOfMachine: 25 });
  });

  it('returns a warming sample when no baseline exists', () => {
    expect(
      toResourceUsage({
        current: {
          memoryBytes: 10,
          cpuTimeMicros: 5_000_000,
          processCount: 1,
          memoryKind: 'rss',
          quality: 'exact-process',
        },
        previousCpuTimeMicros: null,
        windowMs: null,
        logicalCpuCount: 8,
      }).cpuCores
    ).toBeNull();
  });

  it('normalizes device CPU time across logical cores', () => {
    expect(
      toDeviceCpuCores({ busyMs: 1_400, totalMs: 4_000 }, { busyMs: 1_000, totalMs: 2_000 }, 8)
    ).toBe(1.6);
    expect(toDeviceCpuCores({ busyMs: 1_400, totalMs: 4_000 }, null, 8)).toBeNull();
  });

  it('parses portable ps cumulative CPU formats', () => {
    expect(parseCpuTimeMicros('01:02')).toBe(62_000_000);
    expect(parseCpuTimeMicros('02:03:04.50')).toBe(7_384_500_000);
    expect(parseCpuTimeMicros('1-02:03:04')).toBe(93_784_000_000);
  });

  it('preserves compatible aggregate memory semantics and marks mixed accounting', () => {
    const resource = (memoryKind: MachineMonitorMemoryKind) => ({
      memoryBytes: 10,
      cpuCores: 0,
      cpuPercentOfMachine: 0,
      processCount: 1,
      memoryKind,
      quality: 'estimated-tree' as const,
    });
    expect(resolveAggregateMemoryKind([resource('rss'), resource('rss-sum')])).toBe('rss-sum');
    expect(
      resolveAggregateMemoryKind([
        resource('rss'),
        { ...resource('rss'), memoryKind: 'physical-footprint-sum' },
      ])
    ).toBe('mixed');
  });
});

describe('process tree attribution', () => {
  it('attributes descendants by process group and ancestry without double counting', () => {
    const entries: ProcessTableEntry[] = [
      entry(10, 1, 10, 1_000, 100, 10),
      entry(11, 10, 10, 2_000, 200, 20),
      entry(20, 1, 20, 1_000, 300, 30),
      entry(21, 20, 20, 2_000, 400, 40),
    ];
    const result = aggregateProcessTreeUsage(entries, [
      { sessionId: sessionId('a'), rootPids: [10] },
      { sessionId: sessionId('b'), rootPids: [20] },
    ]);
    expect(result.get(sessionId('a'))).toEqual({
      memoryBytes: 30,
      cpuTimeMicros: 300,
      processCount: 2,
    });
    expect(result.get(sessionId('b'))?.processCount).toBe(2);
  });

  it('rejects a reused parent PID that started after its child', () => {
    const entries = [entry(10, 1, null, 5_000, 100, 10), entry(11, 10, null, 1_000, 200, 20)];
    const result = aggregateProcessTreeUsage(entries, [
      { sessionId: sessionId('a'), rootPids: [10] },
    ]);
    expect(result.get(sessionId('a'))?.processCount).toBe(1);
  });
});

function entry(
  pid: number,
  parentPid: number,
  processGroupId: number | null,
  startedAtMs: number,
  cpuTimeMicros: number,
  memoryBytes: number
): ProcessTableEntry {
  return { pid, parentPid, processGroupId, startedAtMs, cpuTimeMicros, memoryBytes };
}

describe('MachinePresenceResourceSampler', () => {
  it('encodes multi-core CPU percent and 0.1 GiB integer memory/disk without blocking heartbeats', async () => {
    const GIB = 1024 ** 3;
    let nowMs = 10_000;
    let cpuCall = 0;
    const cpuSamples = [
      { sample: { busyMs: 1_000, totalMs: 2_000 }, logicalCores: 16 },
      { sample: { busyMs: 2_000, totalMs: 4_000 }, logicalCores: 16 },
    ];

    const sampler = new MachinePresenceResourceSampler({
      now: () => nowMs,
      readCpu: () => cpuSamples[Math.min(cpuCall++, cpuSamples.length - 1)]!,
      readLoadAvg1m: () => 3.4,
      readFallbackMemory: () => ({ totalBytes: 36 * GIB, freeBytes: 17.6 * GIB }),
      readMemoryPressure: async () => ({
        effectiveMemoryLimitBytes: 32 * GIB,
        availableMemoryBytes: 13.6 * GIB,
        source: 'os',
      }),
      readDisk: async () => ({ freeGB: 412.04, totalGB: 1024 }),
    });

    expect(sampler.read()).toEqual({
      cp: 340,
      cc: 16,
      mu: 184,
      mt: 360,
    });

    await Promise.resolve();
    await Promise.resolve();

    nowMs += 30_000;
    expect(sampler.read()).toEqual({
      cp: 800,
      cc: 16,
      mu: 184,
      mt: 320,
      df: 4120,
      dt: 10240,
    });
  });
});
