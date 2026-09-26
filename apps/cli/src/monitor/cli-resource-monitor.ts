import { v4 as uuidv4 } from 'uuid';
import { cpus } from 'node:os';
import {
  getServerNow,
  type AcpSessionMonitorSnapshot,
  type MachineId,
  type MachineMonitorSessionStatus,
  type MachineMonitorSnapshot,
  type SessionId,
} from '@lody/shared';
import type { SessionManager, SessionMonitorRuntimeInfo } from '@/session/session-manager';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import type { MemoryPressureSnapshotSource } from './memory-pressure-sampler';
import { aggregateProcessTreeUsage } from './process-tree';
import { logicalCpuCount, readProcessTable } from './process-table';
import {
  sumResourceUsage,
  toDeviceCpuCores,
  toResourceUsage,
  withMachineCpuPercent,
  type CumulativeResourceSample,
  type DeviceCpuTimeSample,
} from './resource-snapshot';

const MAX_SESSION_ROWS = 100;

export type SessionMonitorState = {
  status: MachineMonitorSessionStatus;
  lastActivityAtMs: number | null;
};

export type SessionMonitorStateSource = {
  getSessionMonitorState(sessionId: SessionId): SessionMonitorState;
};

type Baseline = { sampledAtMs: number; cpuTimeMicros: number };

export class CliResourceMonitor {
  private readonly instanceId = uuidv4();
  private readonly sessionBaselines = new Map<SessionId, Baseline>();
  private cliBaseline: Baseline | null = null;
  private deviceCpuBaseline: DeviceCpuTimeSample | null = null;

  constructor(
    private readonly machineId: MachineId,
    private readonly sessionManager: SessionManager,
    private readonly stateSource: SessionMonitorStateSource,
    private readonly memoryPressure: MemoryPressureSnapshotSource,
    private readonly logger: Logger
  ) {}

  async sample(): Promise<MachineMonitorSnapshot> {
    const sampledAtMs = Date.now();
    const updatedAtMs = getServerNow();
    const cpuCount = logicalCpuCount();
    const deviceCpuSample = readDeviceCpuTimeSample();
    const deviceCpuCores = toDeviceCpuCores(deviceCpuSample, this.deviceCpuBaseline, cpuCount);
    this.deviceCpuBaseline = deviceCpuSample;
    const warnings: string[] = [];
    const [sessions, memoryPressure] = await Promise.all([
      this.sessionManager.listMonitorSessions(),
      this.memoryPressure.getLatest(),
    ]);
    const processTreeSessions = sessions.filter(
      (session) => session.accounting.kind === 'process-tree'
    );
    let processTreeUsage = new Map<
      SessionId,
      {
        memoryBytes: number;
        cpuTimeMicros: number;
        processCount: number;
      }
    >();
    let processMemoryKind: 'rss-sum' | 'physical-footprint-sum' | 'working-set-sum' =
      process.platform === 'win32' ? 'working-set-sum' : 'rss-sum';
    let cliMemoryBytes = process.memoryUsage.rss();
    let cliMemoryKind: 'rss' | 'physical-footprint' = 'rss';

    if (processTreeSessions.length > 0 || process.platform === 'darwin') {
      try {
        const processTable = await readProcessTable();
        processMemoryKind = processTable.memoryKind;
        warnings.push(...processTable.warnings);
        if (processTable.memoryKind === 'physical-footprint-sum') {
          const cliProcess = processTable.entries.find((entry) => entry.pid === process.pid);
          if (cliProcess) {
            cliMemoryBytes = cliProcess.memoryBytes;
            cliMemoryKind = 'physical-footprint';
          }
        }
        processTreeUsage = aggregateProcessTreeUsage(
          processTable.entries,
          processTreeSessions.map((session) => ({
            sessionId: session.sessionId,
            rootPids: session.accounting.kind === 'process-tree' ? session.accounting.rootPids : [],
          }))
        );
      } catch (error) {
        warnings.push('process_table_unavailable');
        this.logger.debug(
          `Machine monitor process-table probe failed: ${formatErrorMessage(error)}`
        );
      }
    }

    const sessionSnapshots = sessions.map((session) =>
      this.buildSessionSnapshot({
        session,
        sampledAtMs,
        cpuCount,
        processMemoryKind,
        processTreeUsage: processTreeUsage.get(session.sessionId),
      })
    );
    const residentIds = new Set(sessionSnapshots.map((session) => session.sessionId));
    for (const pendingSessionId of this.sessionManager.listPendingMonitorSessionIds()) {
      if (residentIds.has(pendingSessionId)) continue;
      const state = this.stateSource.getSessionMonitorState(pendingSessionId);
      sessionSnapshots.push({
        sessionId: pendingSessionId,
        parentSessionId: null,
        agentCliType: null,
        agentType: null,
        status: state.status === 'idle' ? 'initializing' : state.status,
        lastActivityAtMs: state.lastActivityAtMs,
        startedAtMs: null,
        resource: unavailableResource(),
      });
    }

    sessionSnapshots.sort(compareSessions);
    const sessionsTruncated = sessionSnapshots.length > MAX_SESSION_ROWS;
    const visibleSessions = sessionSnapshots.slice(0, MAX_SESSION_ROWS);
    const sessionsAggregate = withMachineCpuPercent(
      sumResourceUsage(sessionSnapshots.map((session) => session.resource)),
      cpuCount
    );

    const cliCpuUsage = process.cpuUsage();
    const cliCpuTimeMicros = cliCpuUsage.user + cliCpuUsage.system;
    const cliWindowMs = this.cliBaseline ? sampledAtMs - this.cliBaseline.sampledAtMs : null;
    const cliControlPlane = toResourceUsage({
      current: {
        memoryBytes: cliMemoryBytes,
        cpuTimeMicros: cliCpuTimeMicros,
        processCount: 1,
        memoryKind: cliMemoryKind,
        quality: 'exact-process',
      },
      previousCpuTimeMicros: this.cliBaseline?.cpuTimeMicros ?? null,
      windowMs: cliWindowMs,
      logicalCpuCount: cpuCount,
    });
    this.cliBaseline = { sampledAtMs, cpuTimeMicros: cliCpuTimeMicros };

    const accountingKinds = new Set(
      sessions.map((session) => session.accounting.kind).filter((kind) => kind !== 'unavailable')
    );

    return {
      kind: 'snapshot',
      protocolVersion: 1,
      machineId: this.machineId,
      instanceId: this.instanceId,
      updatedAtMs,
      sampleWindowMs: cliWindowMs,
      platform: process.platform,
      cpuLogicalCores: cpuCount,
      deviceCpuCores,
      effectiveMemoryBytes: memoryPressure.effectiveMemoryLimitBytes,
      availableMemoryBytes: memoryPressure.availableMemoryBytes,
      sessionAccounting:
        accountingKinds.size > 1
          ? 'mixed'
          : accountingKinds.has('cgroup-v2')
            ? 'cgroup-v2'
            : accountingKinds.has('process-tree')
              ? 'process-tree'
              : 'unavailable',
      cliControlPlane,
      sessionsAggregate,
      sessions: visibleSessions,
      sessionsTruncated,
      warnings,
    };
  }

  private buildSessionSnapshot(args: {
    session: SessionMonitorRuntimeInfo;
    sampledAtMs: number;
    cpuCount: number;
    processMemoryKind: 'rss-sum' | 'physical-footprint-sum' | 'working-set-sum';
    processTreeUsage:
      | { memoryBytes: number; cpuTimeMicros: number; processCount: number }
      | undefined;
  }): AcpSessionMonitorSnapshot {
    const { session } = args;
    let current: CumulativeResourceSample;
    if (session.accounting.kind === 'cgroup-v2') {
      current = {
        memoryBytes: session.accounting.memoryBytes,
        cpuTimeMicros: session.accounting.cpuTimeMicros,
        processCount: session.accounting.processCount,
        memoryKind: 'cgroup-current',
        quality: 'exact-cgroup',
      };
    } else if (session.accounting.kind === 'process-tree' && args.processTreeUsage) {
      current = {
        ...args.processTreeUsage,
        memoryKind: args.processMemoryKind,
        quality: 'estimated-tree',
      };
    } else {
      current = {
        memoryBytes: null,
        cpuTimeMicros: null,
        processCount: null,
        memoryKind: 'unavailable',
        quality: 'unavailable',
      };
    }
    const baseline = this.sessionBaselines.get(session.sessionId);
    const resource = toResourceUsage({
      current,
      previousCpuTimeMicros: baseline?.cpuTimeMicros ?? null,
      windowMs: baseline ? args.sampledAtMs - baseline.sampledAtMs : null,
      logicalCpuCount: args.cpuCount,
    });
    if (current.cpuTimeMicros !== null) {
      this.sessionBaselines.set(session.sessionId, {
        sampledAtMs: args.sampledAtMs,
        cpuTimeMicros: current.cpuTimeMicros,
      });
    } else {
      this.sessionBaselines.delete(session.sessionId);
    }
    const state = this.stateSource.getSessionMonitorState(session.sessionId);
    return {
      sessionId: session.sessionId,
      parentSessionId: session.parentSessionId,
      agentCliType: session.agentCliType,
      agentType: session.agentType,
      status:
        session.runtimeStatus === 'failed'
          ? 'failed'
          : session.runtimeStatus === 'stopping'
            ? 'stopping'
            : state.status,
      lastActivityAtMs: state.lastActivityAtMs,
      startedAtMs: session.startedAtMs,
      resource,
    };
  }
}

function readDeviceCpuTimeSample(): DeviceCpuTimeSample {
  let idleMs = 0;
  let totalMs = 0;
  for (const cpu of cpus()) {
    idleMs += cpu.times.idle;
    totalMs += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { busyMs: Math.max(0, totalMs - idleMs), totalMs };
}

function unavailableResource() {
  return {
    memoryBytes: null,
    cpuCores: null,
    cpuPercentOfMachine: null,
    processCount: null,
    memoryKind: 'unavailable' as const,
    quality: 'unavailable' as const,
  };
}

const statusPriority: Record<MachineMonitorSessionStatus, number> = {
  waiting_permission: 0,
  running: 1,
  initializing: 1,
  finalizing: 1,
  idle: 2,
  failed: 3,
  stopping: 3,
};

function compareSessions(a: AcpSessionMonitorSnapshot, b: AcpSessionMonitorSnapshot): number {
  const statusOrder = statusPriority[a.status] - statusPriority[b.status];
  if (statusOrder !== 0) return statusOrder;
  const memoryOrder = (b.resource.memoryBytes ?? -1) - (a.resource.memoryBytes ?? -1);
  if (memoryOrder !== 0) return memoryOrder;
  return (b.lastActivityAtMs ?? 0) - (a.lastActivityAtMs ?? 0);
}
