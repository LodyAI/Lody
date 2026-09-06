import { z } from 'zod';
import type { MachineId, SessionId } from './ids';

export const LODY_MACHINE_MONITOR_CHANNEL = 'machine-monitor';
export const LODY_MACHINE_MONITOR_STATE_TTL_MS = 30_000;
export const LODY_MACHINE_MONITOR_OBSERVER_TTL_MS = 30_000;
export const LODY_MACHINE_MONITOR_OBSERVER_RENEW_MS = 15_000;
export const LODY_MACHINE_MONITOR_UNIX_SAMPLE_MS = 2_000;
export const LODY_MACHINE_MONITOR_MACOS_SAMPLE_MS = 5_000;
export const LODY_MACHINE_MONITOR_WINDOWS_SAMPLE_MS = 5_000;
export const LODY_MACHINE_MONITOR_STALE_MS = 10_000;

export type MachineMonitorMemoryKind =
  | 'rss'
  | 'cgroup-current'
  | 'rss-sum'
  | 'physical-footprint'
  | 'physical-footprint-sum'
  | 'working-set-sum'
  | 'mixed'
  | 'unavailable';

export type MachineMonitorMeasurementQuality =
  | 'exact-process'
  | 'exact-cgroup'
  | 'estimated-tree'
  | 'unavailable';

export type MachineMonitorSessionStatus =
  | 'initializing'
  | 'running'
  | 'waiting_permission'
  | 'finalizing'
  | 'idle'
  | 'stopping'
  | 'failed';

export type MachineMonitorResourceUsage = {
  memoryBytes: number | null;
  cpuCores: number | null;
  cpuPercentOfMachine: number | null;
  processCount: number | null;
  memoryKind: MachineMonitorMemoryKind;
  quality: MachineMonitorMeasurementQuality;
};

export type AcpSessionMonitorSnapshot = {
  sessionId: SessionId;
  parentSessionId: SessionId | null;
  agentCliType: string | null;
  agentType: string | null;
  status: MachineMonitorSessionStatus;
  lastActivityAtMs: number | null;
  startedAtMs: number | null;
  resource: MachineMonitorResourceUsage;
};

export type MachineMonitorSnapshot = {
  kind: 'snapshot';
  protocolVersion: 1;
  machineId: MachineId;
  instanceId: string;
  updatedAtMs: number;
  sampleWindowMs: number | null;
  platform: string;
  cpuLogicalCores: number;
  deviceCpuCores?: number | null;
  effectiveMemoryBytes: number;
  availableMemoryBytes: number;
  sessionAccounting: 'cgroup-v2' | 'process-tree' | 'mixed' | 'unavailable';
  cliControlPlane: MachineMonitorResourceUsage;
  sessionsAggregate: MachineMonitorResourceUsage;
  sessions: AcpSessionMonitorSnapshot[];
  sessionsTruncated: boolean;
  warnings: string[];
};

export type MachineMonitorObserverState = {
  kind: 'observer';
  protocolVersion: 1;
  machineId: MachineId;
  observerId: string;
  updatedAtMs: number;
  expiresAtMs: number;
  forceSampleAtMs: number | null;
};

export type MachineMonitorState = MachineMonitorObserverState | MachineMonitorSnapshot;
export type MachineMonitorStateMap = Record<string, MachineMonitorState>;

const finiteNonNegative = z.number().finite().nonnegative();
const nullableFiniteNonNegative = finiteNonNegative.nullable();

const MachineIdSchema = z
  .string()
  .min(1)
  .transform((value) => value as MachineId);
const SessionIdSchema = z
  .string()
  .min(1)
  .transform((value) => value as SessionId);

const MachineMonitorResourceUsageSchema = z.object({
  memoryBytes: nullableFiniteNonNegative,
  cpuCores: nullableFiniteNonNegative,
  cpuPercentOfMachine: nullableFiniteNonNegative,
  processCount: nullableFiniteNonNegative,
  memoryKind: z.enum([
    'rss',
    'cgroup-current',
    'rss-sum',
    'physical-footprint',
    'physical-footprint-sum',
    'working-set-sum',
    'mixed',
    'unavailable',
  ]),
  quality: z.enum(['exact-process', 'exact-cgroup', 'estimated-tree', 'unavailable']),
});

export const MachineResourceHistorySchema = z
  .object({
    type: z.literal('machine/resource-history'),
    machineId: z.string().min(1),
    instanceId: z.string().min(1),
    collectedWhileObserved: z.literal(true),
    samples: z
      .array(
        z
          .object({
            sampledAtMs: z.number().finite().nonnegative(),
            source: z.enum(['available', 'unavailable', 'not-sampled']),
            cliControlPlane: MachineMonitorResourceUsageSchema.nullable(),
            memoryKind: z.enum(['rss-sum', 'physical-footprint-sum', 'working-set-sum']),
            processesTruncated: z.boolean(),
            sessionsTruncated: z.boolean(),
            processes: z
              .array(
                z
                  .object({
                    pid: z.number().int().positive(),
                    startedAtMs: z.number().finite().nonnegative(),
                    sessionId: z.string().nullable(),
                    memoryBytes: z.number().finite().nonnegative(),
                    cpuTimeMicros: z.number().finite().nonnegative(),
                  })
                  .strict()
              )
              .max(256),
            sessions: z
              .array(
                z
                  .object({
                    sessionId: z.string(),
                    parentSessionId: z.string().nullable(),
                    status: z.string(),
                    cleanup: z
                      .object({
                        state: z.enum(['running', 'failed', 'completed']),
                        attemptedAtMs: z.number().finite().nonnegative(),
                      })
                      .strict()
                      .nullable(),
                    resource: MachineMonitorResourceUsageSchema,
                  })
                  .strict()
              )
              .max(100),
          })
          .strict()
      )
      .max(120),
  })
  .strict();

export type MachineResourceHistory = z.infer<typeof MachineResourceHistorySchema>;

const AcpSessionMonitorSnapshotSchema = z.object({
  sessionId: SessionIdSchema,
  parentSessionId: SessionIdSchema.nullable(),
  agentCliType: z.string().nullable(),
  agentType: z.string().nullable(),
  status: z.enum([
    'initializing',
    'running',
    'waiting_permission',
    'finalizing',
    'idle',
    'stopping',
    'failed',
  ]),
  lastActivityAtMs: nullableFiniteNonNegative,
  startedAtMs: nullableFiniteNonNegative,
  resource: MachineMonitorResourceUsageSchema,
});

export const MachineMonitorObserverStateSchema = z.object({
  kind: z.literal('observer'),
  protocolVersion: z.literal(1),
  machineId: MachineIdSchema,
  observerId: z.string().min(1).max(256),
  updatedAtMs: finiteNonNegative,
  expiresAtMs: finiteNonNegative,
  forceSampleAtMs: nullableFiniteNonNegative,
});

export const MachineMonitorSnapshotSchema = z.object({
  kind: z.literal('snapshot'),
  protocolVersion: z.literal(1),
  machineId: MachineIdSchema,
  instanceId: z.string().min(1).max(256),
  updatedAtMs: finiteNonNegative,
  sampleWindowMs: nullableFiniteNonNegative,
  platform: z.string().min(1),
  cpuLogicalCores: z.number().int().positive(),
  deviceCpuCores: nullableFiniteNonNegative.optional(),
  effectiveMemoryBytes: finiteNonNegative,
  availableMemoryBytes: finiteNonNegative,
  sessionAccounting: z.enum(['cgroup-v2', 'process-tree', 'mixed', 'unavailable']),
  cliControlPlane: MachineMonitorResourceUsageSchema,
  sessionsAggregate: MachineMonitorResourceUsageSchema,
  sessions: z.array(AcpSessionMonitorSnapshotSchema).max(100),
  sessionsTruncated: z.boolean(),
  warnings: z.array(z.string().max(256)).max(20),
});

export const MachineMonitorStateSchema = z.discriminatedUnion('kind', [
  MachineMonitorObserverStateSchema,
  MachineMonitorSnapshotSchema,
]);

export const getMachineMonitorObserverKey = (machineId: MachineId, observerId: string): string =>
  `observer:${encodeURIComponent(machineId)}:${encodeURIComponent(observerId)}`;

export const getMachineMonitorSnapshotKey = (machineId: MachineId, instanceId: string): string =>
  `snapshot:${encodeURIComponent(machineId)}:${encodeURIComponent(instanceId)}`;

export const toLodyMachineMonitorStreamUrl = (durableStreamUrl: string): string => {
  const url = new URL(durableStreamUrl);
  url.searchParams.set('ephemeral', LODY_MACHINE_MONITOR_CHANNEL);
  return url.toString();
};

export const parseMachineMonitorStates = (
  states: Record<string, unknown>
): MachineMonitorStateMap => {
  const parsed: MachineMonitorStateMap = {};
  for (const [key, value] of Object.entries(states)) {
    const result = MachineMonitorStateSchema.safeParse(value);
    if (!result.success) continue;
    parsed[key] = result.data;
  }
  return parsed;
};

export const findLatestMachineMonitorSnapshot = (
  states: MachineMonitorStateMap,
  machineId: MachineId
): MachineMonitorSnapshot | null => {
  let latest: MachineMonitorSnapshot | null = null;
  for (const state of Object.values(states)) {
    if (state.kind !== 'snapshot' || state.machineId !== machineId) continue;
    if (!latest || state.updatedAtMs > latest.updatedAtMs) latest = state;
  }
  return latest;
};
