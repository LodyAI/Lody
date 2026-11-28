import { cpus, freemem, loadavg, totalmem } from 'node:os';
import type { LodyMachinePresenceResources } from '@lody/shared';
import { readLodyDataDiskInfo } from '@/lib/machine-disk';
import { getMemoryPressureSnapshot, type MemoryPressureSnapshot } from '@/utils/memory';
import { toDeviceCpuCores, type DeviceCpuTimeSample } from './resource-snapshot';

const GIB = 1024 ** 3;
const DEFAULT_MEMORY_REFRESH_MS = 30_000;
const DEFAULT_DISK_REFRESH_MS = 60_000;

export function bytesToTenthsGiB(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.round((bytes / GIB) * 10);
}

export function readDeviceCpuSample(): { sample: DeviceCpuTimeSample; logicalCores: number } {
  const list = cpus();
  let busyMs = 0;
  let totalMs = 0;
  for (const cpu of list) {
    const { user, nice, sys, idle, irq } = cpu.times;
    const total = user + nice + sys + idle + irq;
    busyMs += total - idle;
    totalMs += total;
  }
  return {
    sample: { busyMs, totalMs },
    logicalCores: Math.max(1, list.length),
  };
}

export type MachinePresenceResourceSamplerDeps = {
  now?: () => number;
  readCpu?: () => { sample: DeviceCpuTimeSample; logicalCores: number };
  readLoadAvg1m?: () => number;
  readFallbackMemory?: () => { totalBytes: number; freeBytes: number };
  readMemoryPressure?: () => Promise<MemoryPressureSnapshot>;
  readDisk?: () => Promise<{ freeGB: number; totalGB: number } | undefined>;
  memoryRefreshMs?: number;
  diskRefreshMs?: number;
};

export class MachinePresenceResourceSampler {
  private readonly now: () => number;
  private readonly readCpu: () => { sample: DeviceCpuTimeSample; logicalCores: number };
  private readonly readLoadAvg1m: () => number;
  private readonly readFallbackMemory: () => { totalBytes: number; freeBytes: number };
  private readonly readMemoryPressure: () => Promise<MemoryPressureSnapshot>;
  private readonly readDisk: () => Promise<{ freeGB: number; totalGB: number } | undefined>;
  private readonly memoryRefreshMs: number;
  private readonly diskRefreshMs: number;

  private cpuBaseline: DeviceCpuTimeSample | null = null;
  private cachedMemory: {
    effectiveTotalBytes: number;
    availableBytes: number;
    atMs: number;
  } | null = null;
  private memoryInFlight = false;
  private cachedDisk: { df: number; dt: number; atMs: number } | null = null;
  private diskInFlight = false;

  constructor(deps: MachinePresenceResourceSamplerDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.readCpu = deps.readCpu ?? readDeviceCpuSample;
    this.readLoadAvg1m = deps.readLoadAvg1m ?? (() => loadavg()[0] ?? 0);
    this.readFallbackMemory =
      deps.readFallbackMemory ?? (() => ({ totalBytes: totalmem(), freeBytes: freemem() }));
    this.readMemoryPressure =
      deps.readMemoryPressure ?? (() => getMemoryPressureSnapshot({ force: false }));
    this.readDisk = deps.readDisk ?? (() => readLodyDataDiskInfo());
    this.memoryRefreshMs = deps.memoryRefreshMs ?? DEFAULT_MEMORY_REFRESH_MS;
    this.diskRefreshMs = deps.diskRefreshMs ?? DEFAULT_DISK_REFRESH_MS;
  }

  read(): LodyMachinePresenceResources {
    const nowMs = this.now();
    this.maybeRefreshMemory(nowMs);
    this.maybeRefreshDisk(nowMs);

    const { sample, logicalCores } = this.readCpu();
    const deviceCpuCores = toDeviceCpuCores(sample, this.cpuBaseline, logicalCores);
    this.cpuBaseline = sample;

    const cpuCoresUsed =
      deviceCpuCores !== null
        ? deviceCpuCores
        : Math.max(0, Math.min(logicalCores, this.readLoadAvg1m()));
    const cp = Math.max(0, Math.round(cpuCoresUsed * 100));

    let totalMemBytes: number;
    let usedMemBytes: number;
    if (this.cachedMemory) {
      totalMemBytes = this.cachedMemory.effectiveTotalBytes;
      usedMemBytes = Math.max(
        0,
        this.cachedMemory.effectiveTotalBytes - this.cachedMemory.availableBytes
      );
    } else {
      const fallback = this.readFallbackMemory();
      totalMemBytes = fallback.totalBytes;
      usedMemBytes = Math.max(0, fallback.totalBytes - fallback.freeBytes);
    }

    const mt = Math.max(1, bytesToTenthsGiB(totalMemBytes));
    const mu = Math.min(mt, bytesToTenthsGiB(usedMemBytes));

    return {
      cp,
      cc: logicalCores,
      mu,
      mt,
      ...(this.cachedDisk ? { df: this.cachedDisk.df, dt: this.cachedDisk.dt } : {}),
    };
  }

  private maybeRefreshMemory(nowMs: number): void {
    if (this.memoryInFlight) return;
    if (this.cachedMemory && nowMs - this.cachedMemory.atMs < this.memoryRefreshMs) return;
    this.memoryInFlight = true;
    void this.readMemoryPressure()
      .then((snapshot) => {
        if (
          Number.isFinite(snapshot.effectiveMemoryLimitBytes) &&
          snapshot.effectiveMemoryLimitBytes > 0 &&
          Number.isFinite(snapshot.availableMemoryBytes)
        ) {
          this.cachedMemory = {
            effectiveTotalBytes: snapshot.effectiveMemoryLimitBytes,
            availableBytes: Math.max(0, snapshot.availableMemoryBytes),
            atMs: this.now(),
          };
        }
      })
      .catch(() => {})
      .finally(() => {
        this.memoryInFlight = false;
      });
  }

  private maybeRefreshDisk(nowMs: number): void {
    if (this.diskInFlight) return;
    if (this.cachedDisk && nowMs - this.cachedDisk.atMs < this.diskRefreshMs) return;
    this.diskInFlight = true;
    void this.readDisk()
      .then((disk) => {
        if (!disk || !Number.isFinite(disk.totalGB) || disk.totalGB <= 0) return;
        const dt = Math.max(1, Math.round(disk.totalGB * 10));
        const df = Math.min(dt, Math.max(0, Math.round(disk.freeGB * 10)));
        this.cachedDisk = { df, dt, atMs: this.now() };
      })
      .catch(() => {})
      .finally(() => {
        this.diskInFlight = false;
      });
  }
}
