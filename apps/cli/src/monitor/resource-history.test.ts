import { describe, expect, it } from 'vitest';
import { MachineResourceHistorySchema } from '@lody/shared';
import type { SessionId } from '@lody/shared';
import { ResourceHistory } from './resource-history';
import { ObservedProcessAttribution } from './process-tree';

const sample = (sampledAtMs: number) => ({
  sampledAtMs,
  source: 'available' as const,
  cliControlPlane: null,
  memoryKind: 'working-set-sum' as const,
  processesTruncated: false,
  sessionsTruncated: false,
  processes: [],
  sessions: [],
});

describe('resource history', () => {
  it('owns immutable cgroup and CLI metrics even without a process table', () => {
    const history = new ResourceHistory('machine', 'instance');
    const resource = {
      memoryBytes: 123,
      cpuCores: 0.5,
      cpuPercentOfMachine: 25,
      processCount: 2,
      memoryKind: 'cgroup-current' as const,
      quality: 'exact-cgroup' as const,
    };
    const cleanup = { state: 'running' as const, attemptedAtMs: 1 };
    history.append({
      ...sample(1),
      source: 'not-sampled',
      cliControlPlane: { ...resource, memoryKind: 'rss', quality: 'exact-process' },
      sessions: [
        { sessionId: 'session', parentSessionId: null, status: 'stopping', cleanup, resource },
      ],
    });
    resource.memoryBytes = 999;
    cleanup.attemptedAtMs = 999;
    const receipt = history.read(1).samples[0];
    expect(receipt?.cliControlPlane?.memoryBytes).toBe(123);
    expect(receipt?.sessions[0]?.resource.memoryBytes).toBe(123);
    expect(receipt?.sessions[0]?.cleanup?.attemptedAtMs).toBe(1);
    expect(MachineResourceHistorySchema.safeParse(history.read(1)).success).toBe(true);
  });
  it('bounds count and age and keeps observer gaps without fabricated samples', () => {
    const history = new ResourceHistory('machine', 'instance');
    for (let i = 0; i < 150; i++) history.append(sample(i));
    expect(history.read(150).samples).toHaveLength(120);
    expect(history.read(150).samples[0]?.sampledAtMs).toBe(30);
    expect(history.read(700_000).samples).toEqual([]);
  });
  it('caps process rows, returns independent copies, and distinguishes unavailable from empty', () => {
    const history = new ResourceHistory('machine', 'instance');
    history.append({
      ...sample(1),
      processes: Array.from({ length: 300 }, (_, i) => ({
        pid: i + 1,
        startedAtMs: 1,
        sessionId: null,
        memoryBytes: 1,
        cpuTimeMicros: 1,
      })),
    });
    history.append({ ...sample(2), source: 'unavailable' });
    const result = history.read(2);
    expect(result.samples[0]?.processes).toHaveLength(256);
    expect(result.samples[0]?.processesTruncated).toBe(true);
    expect(result.samples[1]?.source).toBe('unavailable');
    expect(MachineResourceHistorySchema.safeParse(result).success).toBe(true);
    result.samples.length = 0;
    expect(history.read(2).samples).toHaveLength(2);
  });
  it('does not attribute a reused root PID or its new descendants to the old session', () => {
    const attribution = new ObservedProcessAttribution();
    const roots = [{ sessionId: 'session' as SessionId, startedAtMs: 1, rootPids: [10] }];
    const root = {
      pid: 10,
      parentPid: 1,
      processGroupId: null,
      startedAtMs: 5,
      memoryBytes: 1,
      cpuTimeMicros: 1,
    };
    expect(attribution.assign([root], roots).get(10)).toBe('session');
    attribution.assign([], roots);
    const reused = { ...root, startedAtMs: 15 };
    expect(attribution.assign([reused, { ...reused, pid: 11, parentPid: 10 }], roots).size).toBe(0);
  });
});
