import { toShared } from '@/platform/process-options';
import { readFileSync } from 'fs';
import os from 'os';

import { READ_ONLY_ABANDON_POLICY } from '@lody/shared/node/process';

import { runCommandTextLegacy } from '@lody/shared/node/process';

const DARWIN_MEMORY_PROBE_TIMEOUT_MS = 1_000;

/**
 * `powershell.exe` + CIM is not a one-second operation. A cold `-NoProfile` start alone is
 * routinely 300-900ms, and the CIM queries add more on a loaded machine — which is precisely
 * the machine this probe exists to measure. The old 1s budget made the Windows probe time out
 * exactly when it mattered, silently dropping every commit number.
 *
 * The cost is bounded in practice: `MemoryPressureSampler` dedupes in-flight probes, and the
 * hot path can only reach this after a cheap cached read already suggested pressure.
 */
const WINDOWS_MEMORY_PROBE_TIMEOUT_MS = 5_000;

/**
 * How long a Windows commit reading may be reused.
 *
 * Every probe is a `powershell.exe` spawn — tens of MB of working set and a CPU spike, to read
 * a handful of numbers. At the monitor's 5s cadence that is ~17k process launches a day on an
 * idle daemon, which is an absurd way to measure memory. Physical availability stays fresh on
 * every sample (`os.freemem()` is a syscall), and commit charge does not move fast enough for
 * 30s of staleness to matter for RECLAIM decisions. Anything about to REFUSE a turn forces a
 * fresh probe — see `getMemoryPressureSnapshot({ force: true })`.
 */
const WINDOWS_MEMORY_CACHE_TTL_MS = 30_000;

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

export interface WindowsMemoryStatus {
  commitLimitBytes: number;
  committedBytes: number;
  /** `CommitLimit - CommitCharge` as it stands right now. */
  availableCommitBytes: number;
  /**
   * What the page file can still add to the commit limit. `0` means the ceiling really is
   * fixed — paging disabled, or every page file already at its maximum / out of disk.
   *
   * `null` means UNDETERMINED, which is not the same as zero: a refusal requires positive
   * evidence that the limit cannot move, so an unreadable page file or volume must fail open.
   */
  commitGrowthBytes: number | null;
  /**
   * `availableCommitBytes + commitGrowthBytes`: the actual distance to an allocation failure.
   * Absent when growth is undetermined, which is what makes the admission check fail open.
   */
  effectiveAvailableCommitBytes?: number;
}

/** Page file configuration, as reported by CIM. Sizes already converted to bytes. */
export interface WindowsPageFileConfig {
  /** `Win32_ComputerSystem.AutomaticManagedPagefile`: Windows sizes the page files itself. */
  automaticManagedPagefile: boolean;
  /** `Win32_PageFileUsage`: the page files that exist, with their CURRENT size. */
  pageFiles: Array<{ name: string; allocatedBytes: number }>;
  /**
   * `Win32_PageFileSetting`: explicit sizing. Deliberately EMPTY on a stock machine — the class
   * reports nothing at all while `AutomaticManagedPagefile` is set, which is the default.
   */
  pageFileSettings: Array<{ name: string; maximumBytes: number }>;
  /** `Win32_LogicalDisk` fixed volumes. Both terms bound page file growth. */
  volumes: Array<{ name: string; freeBytes: number; sizeBytes: number }>;
}

/**
 * macOS kernel memory pressure level (`kern.memorystatus_vm_pressure_level`),
 * mapped 1:1 onto `dispatch_source_memorypressure_flags_t`.
 *
 * XNU derives this from a single ratio: pages occupied by the compressor versus
 * `active + inactive + free + speculative`. It enters WARNING once the compressor
 * holds more physical memory than all of those queues combined, and CRITICAL at
 * roughly 1.9x that. Free-memory byte counts do not enter the decision at all,
 * which is exactly why they are a poor admission signal on this platform.
 */
export type DarwinMemoryPressureLevel = 1 | 2 | 4;

export const DARWIN_PRESSURE_NORMAL = 1 satisfies DarwinMemoryPressureLevel;
export const DARWIN_PRESSURE_WARNING = 2 satisfies DarwinMemoryPressureLevel;
export const DARWIN_PRESSURE_CRITICAL = 4 satisfies DarwinMemoryPressureLevel;

export interface MemoryPressureSnapshot {
  /**
   * Reclaim-aware headroom: what a new process can actually get. On Linux this counts
   * page cache the kernel will hand back, NOT just untouched bytes.
   */
  availableMemoryBytes: number;
  effectiveMemoryLimitBytes: number;
  /** macOS only; absent when the probe is unavailable or returned an unknown value. */
  memoryPressureLevel?: DarwinMemoryPressureLevel;
  /** Linux only; `MemAvailable`, before any cgroup limit is applied. */
  hostAvailableBytes?: number;
  /** Linux only; present when some ancestor cgroup imposes a `memory.max`. */
  cgroup?: CgroupMemoryState;
  availableCommitBytes?: number;
  commitLimitBytes?: number;
  committedBytes?: number;
  /** Windows only; headroom the page file can still add to the commit limit. */
  commitGrowthBytes?: number;
  /** Windows only; `availableCommitBytes + commitGrowthBytes`. The number worth refusing on. */
  effectiveAvailableCommitBytes?: number;
}

/**
 * Reclaim-aware available memory for the current process, cgroup-aware.
 *
 * On Linux the answer is the minimum of:
 * - System-wide `MemAvailable` from `/proc/meminfo` (already reclaim-aware)
 * - The cgroup's budget: `memory.max - memory.current` PLUS reclaimable cache/slab
 *
 * The reclaimable term is the whole point. `memory.current` counts page cache, so
 * without it a cgroup that has merely read a lot of files looks full.
 *
 * On other platforms, falls back to `os.freemem()`.
 */
export function getAvailableMemoryBytes(): number {
  const systemAvailable = getSystemAvailableMemoryBytesSync();
  const cgroup = readCgroupMemoryState();
  if (cgroup !== null) {
    return Math.min(systemAvailable, cgroup.hardHeadroomBytes + cgroup.reclaimableBytes);
  }
  return systemAvailable;
}

export interface MemoryPressureProbeOptions {
  /**
   * Bypass the Windows commit cache. Required before REFUSING a turn; the periodic monitor
   * leaves it off so an idle daemon does not spawn `powershell.exe` every few seconds.
   */
  force?: boolean;
}

export async function getMemoryPressureSnapshot(
  options: MemoryPressureProbeOptions = {}
): Promise<MemoryPressureSnapshot> {
  const [windowsStatus, darwinPressureLevel] = await Promise.all([
    getWindowsMemoryStatus(options.force === true),
    getDarwinMemoryPressureLevel(),
  ]);
  const systemAvailable = await getSystemAvailableMemoryBytes();
  const cgroup = readCgroupMemoryState();
  const availableMemoryBytes =
    cgroup !== null
      ? Math.min(systemAvailable, cgroup.hardHeadroomBytes + cgroup.reclaimableBytes)
      : systemAvailable;
  const effectiveMemoryLimitBytes = getEffectiveMemoryLimitBytes();

  return {
    availableMemoryBytes,
    effectiveMemoryLimitBytes,
    ...(darwinPressureLevel !== null ? { memoryPressureLevel: darwinPressureLevel } : {}),
    ...(cgroup !== null ? { cgroup, hostAvailableBytes: systemAvailable } : {}),
    ...(windowsStatus
      ? {
          availableCommitBytes: windowsStatus.availableCommitBytes,
          commitLimitBytes: windowsStatus.commitLimitBytes,
          committedBytes: windowsStatus.committedBytes,
          // Both stay ABSENT when growth is undetermined, so the admission check fails open.
          ...(windowsStatus.commitGrowthBytes !== null
            ? { commitGrowthBytes: windowsStatus.commitGrowthBytes }
            : {}),
          ...(windowsStatus.effectiveAvailableCommitBytes !== undefined
            ? { effectiveAvailableCommitBytes: windowsStatus.effectiveAvailableCommitBytes }
            : {}),
        }
      : {}),
  };
}

/**
 * Get the effective memory limit for this process, cgroup-aware.
 *
 * Returns the minimum of `os.totalmem()` and any cgroup `memory.max` limit.
 * This ensures per-session budget calculations don't exceed the actual available
 * memory when a parent cgroup (e.g. `user.slice MemoryMax=26G` on a 32G machine)
 * constrains the process.
 */
export function getEffectiveMemoryLimitBytes(): number {
  const totalMem = os.totalmem();
  const cgroupMax = findTightestCgroupLimit()?.maxBytes ?? null;
  if (cgroupMax !== null) {
    return Math.min(totalMem, cgroupMax);
  }
  return totalMem;
}

async function getSystemAvailableMemoryBytes(): Promise<number> {
  const darwinAvailable = await getDarwinAvailableMemoryBytes();
  if (darwinAvailable !== null) {
    return darwinAvailable;
  }

  return getSystemAvailableMemoryBytesSync();
}

function getSystemAvailableMemoryBytesSync(): number {
  // On Windows `os.freemem()` is already the reclaim-aware number: libuv returns
  // `GlobalMemoryStatusEx().ullAvailPhys`, which is the free + zero + STANDBY lists — the same
  // quantity Task Manager labels "Available". No probe can improve on it, so none is run.
  if (process.platform === 'linux') {
    try {
      const meminfo = readFileSync('/proc/meminfo', 'utf8');
      const match = meminfo.match(/MemAvailable:\s+(\d+)/);
      if (match?.[1]) {
        return parseInt(match[1], 10) * 1024; // kB → bytes
      }
    } catch {
      // /proc/meminfo not readable, fall through
    }
  }

  return os.freemem();
}

/**
 * Read the Windows commit charge AND how far the commit limit can still move.
 *
 * The commit limit is `physical RAM + total page file size`, and with the default
 * system-managed page file the second term is NOT a constant: the Memory Manager grows the
 * page file on demand, raising the limit. A machine can therefore sit permanently within a
 * few hundred MB of its current commit limit while being in no distress whatsoever. Reading
 * `CommitLimit - CommitCharge` as remaining headroom is how this guard came to refuse turns
 * on healthy Windows machines — the same class of mistake as counting Linux page cache as
 * used, or ignoring the macOS compressor.
 *
 * So the page file configuration is part of the measurement, not a detail: only when nothing
 * can grow is the commit limit the hard ceiling this code is entitled to refuse on.
 *
 * Two sources for the commit numbers, in that order:
 * - `Win32_PerfFormattedData_PerfOS_Memory` — `CommitLimit`/`CommittedBytes` are the counters
 *   Microsoft's own page file documentation names for this measurement. They need the WMI
 *   performance provider, which is a routinely broken subsystem, hence the fallback.
 * - `Win32_OperatingSystem` — `TotalVirtualMemorySize`/`FreeVirtualMemory`. In practice these
 *   are `GlobalMemoryStatusEx`'s `ullTotalPageFile`/`ullAvailPageFile`, but the CIM
 *   documentation says only "virtual memory ... unused and available"; that equivalence is an
 *   inference, which is exactly why it is the fallback and not the primary.
 */
async function probeWindowsMemoryStatus(): Promise<WindowsMemoryStatus | null> {
  const script = [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$perf = Get-CimInstance -ClassName Win32_PerfFormattedData_PerfOS_Memory',
    '$os = Get-CimInstance -ClassName Win32_OperatingSystem',
    '$cs = Get-CimInstance -ClassName Win32_ComputerSystem',
    '$usage = @(Get-CimInstance -ClassName Win32_PageFileUsage)',
    '$setting = @(Get-CimInstance -ClassName Win32_PageFileSetting)',
    '$disks = @(Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DriveType=3")',
    '$out = @{ CommitLimit = $perf.CommitLimit }',
    '$out.CommittedBytes = $perf.CommittedBytes',
    '$out.TotalVirtualMemorySize = $os.TotalVirtualMemorySize',
    '$out.FreeVirtualMemory = $os.FreeVirtualMemory',
    '$out.AutomaticManagedPagefile = [bool]$cs.AutomaticManagedPagefile',
    '$out.PageFiles = @($usage | Select-Object Name, AllocatedBaseSize)',
    '$out.PageFileSettings = @($setting | Select-Object Name, MaximumSize)',
    '$out.Volumes = @($disks | Select-Object DeviceID, FreeSpace, Size)',
    '$out | ConvertTo-Json -Compress -Depth 4',
  ].join('; ');

  try {
    const { stdout } = await runCommandTextLegacy(
      {
        command: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        timeout: WINDOWS_MEMORY_PROBE_TIMEOUT_MS,
        abandonPolicy: READ_ONLY_ABANDON_POLICY,
        check: 'exit-0',
      },
      toShared()
    );
    return parseWindowsMemoryStatus(stdout, os.totalmem());
  } catch {
    return null;
  }
}

let windowsMemoryCache: { status: WindowsMemoryStatus | null; sampledAtMs: number } | null = null;
let windowsMemoryProbeInFlight: Promise<WindowsMemoryStatus | null> | null = null;

async function getWindowsMemoryStatus(force: boolean): Promise<WindowsMemoryStatus | null> {
  if (process.platform !== 'win32') {
    return null;
  }

  const cached = windowsMemoryCache;
  if (!force && cached !== null && Date.now() - cached.sampledAtMs < WINDOWS_MEMORY_CACHE_TTL_MS) {
    return cached.status;
  }
  // Concurrent samplers must not each launch their own `powershell.exe`.
  if (windowsMemoryProbeInFlight !== null) {
    return await windowsMemoryProbeInFlight;
  }

  const probe = probeWindowsMemoryStatus().then((status) => {
    windowsMemoryCache = { status, sampledAtMs: Date.now() };
    return status;
  });
  windowsMemoryProbeInFlight = probe;
  try {
    return await probe;
  } finally {
    if (windowsMemoryProbeInFlight === probe) {
      windowsMemoryProbeInFlight = null;
    }
  }
}

export function parseWindowsMemoryStatus(
  rawJson: string,
  totalPhysicalBytes: number
): WindowsMemoryStatus | null {
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(rawJson);
    if (typeof value !== 'object' || value === null) return null;
    parsed = value as Record<string, unknown>;
  } catch {
    return null;
  }

  const commit = readWindowsCommitTotals(parsed);
  if (commit === null) return null;

  const config: WindowsPageFileConfig = {
    automaticManagedPagefile: parsed.AutomaticManagedPagefile === true,
    pageFiles: readCimRows(parsed.PageFiles).flatMap((row) => {
      const name = readNonEmptyString(row.Name);
      const allocatedBytes = readMegabytes(row.AllocatedBaseSize);
      return name !== null && allocatedBytes !== null ? [{ name, allocatedBytes }] : [];
    }),
    pageFileSettings: readCimRows(parsed.PageFileSettings).flatMap((row) => {
      const name = readNonEmptyString(row.Name);
      const maximumBytes = readMegabytes(row.MaximumSize);
      return name !== null && maximumBytes !== null ? [{ name, maximumBytes }] : [];
    }),
    volumes: readCimRows(parsed.Volumes).flatMap((row) => {
      const name = readNonEmptyString(row.DeviceID);
      const freeBytes = readNumber(row.FreeSpace);
      const sizeBytes = readNumber(row.Size);
      return name !== null && freeBytes !== null && sizeBytes !== null
        ? [{ name, freeBytes, sizeBytes }]
        : [];
    }),
  };

  const commitGrowthBytes = computeWindowsCommitGrowthBytes(config, {
    totalPhysicalBytes,
    commitLimitBytes: commit.commitLimitBytes,
  });

  return {
    commitLimitBytes: commit.commitLimitBytes,
    committedBytes: commit.committedBytes,
    availableCommitBytes: commit.availableCommitBytes,
    commitGrowthBytes,
    ...(commitGrowthBytes !== null
      ? { effectiveAvailableCommitBytes: commit.availableCommitBytes + commitGrowthBytes }
      : {}),
  };
}

/** Perf counters first (documented names, bytes), `Win32_OperatingSystem` second (kilobytes). */
function readWindowsCommitTotals(
  parsed: Record<string, unknown>
): { commitLimitBytes: number; committedBytes: number; availableCommitBytes: number } | null {
  const perfLimit = readNumber(parsed.CommitLimit);
  const perfCommitted = readNumber(parsed.CommittedBytes);
  if (perfLimit !== null && perfLimit > 0 && perfCommitted !== null) {
    return {
      commitLimitBytes: perfLimit,
      committedBytes: Math.min(perfCommitted, perfLimit),
      availableCommitBytes: Math.max(0, perfLimit - perfCommitted),
    };
  }

  const osLimit = readKilobytes(parsed.TotalVirtualMemorySize);
  const osFree = readKilobytes(parsed.FreeVirtualMemory);
  if (osLimit !== null && osLimit > 0 && osFree !== null) {
    const available = Math.min(osFree, osLimit);
    return {
      commitLimitBytes: osLimit,
      committedBytes: osLimit - available,
      availableCommitBytes: available,
    };
  }

  return null;
}

export interface WindowsCommitGrowthInputs {
  totalPhysicalBytes: number;
  /** Cross-checks an empty page file enumeration against `commit limit = RAM + page files`. */
  commitLimitBytes: number;
}

/**
 * Bytes the commit limit can still gain by growing (or creating) page files, or `null` when
 * that cannot be determined.
 *
 * Pure, so every page file topology is testable off Windows.
 *
 * Each page file contributes `min(its maximum size - its current size, free space on its
 * volume)`. Its maximum is the configured `MaximumSize` when one is set; otherwise the file is
 * system-managed and Microsoft documents that ceiling as `max(3 x RAM, 4GB)` **capped at one
 * eighth of the volume size**. That last cap is not decoration — it is the binding term on
 * small disks, which are exactly the machines that actually run out of commit.
 *
 * `null` (undetermined) rather than `0` whenever the inputs cannot rule growth out: a page file
 * whose volume was not reported, or an empty enumeration on a machine whose commit limit
 * clearly exceeds physical RAM (so a page file does exist and the query simply failed).
 * Returning `0` there would manufacture a hard ceiling out of a failed probe and refuse a
 * perfectly healthy machine — the very bug this module exists to prevent.
 */
export function computeWindowsCommitGrowthBytes(
  config: WindowsPageFileConfig,
  inputs: WindowsCommitGrowthInputs
): number | null {
  const { totalPhysicalBytes, commitLimitBytes } = inputs;
  const volumeByKey = new Map(config.volumes.map((volume) => [volumeKey(volume.name), volume]));
  const maximumByName = new Map(
    config.pageFileSettings.map((setting) => [setting.name.toLowerCase(), setting.maximumBytes])
  );

  if (config.pageFiles.length === 0) {
    // `CommitLimit = RAM + total page file size`, so a limit above RAM proves a page file
    // exists whatever the enumeration said.
    if (commitLimitBytes > totalPhysicalBytes + EMPTY_PAGE_FILE_TOLERANCE_BYTES) return null;
    // Paging really is off. Windows only creates a page file while it manages them itself.
    if (!config.automaticManagedPagefile) return 0;
    return config.volumes.reduce(
      (largest, volume) =>
        Math.max(
          largest,
          Math.min(systemManagedMaxBytes(totalPhysicalBytes, volume.sizeBytes), volume.freeBytes)
        ),
      0
    );
  }

  let growthBytes = 0;
  for (const pageFile of config.pageFiles) {
    const volume = volumeByKey.get(volumeKey(pageFile.name));
    if (volume === undefined) return null;

    // While Windows manages the page files, any explicit setting row is stale and ignored —
    // and on a stock machine `Win32_PageFileSetting` reports nothing at all.
    const configuredMaximum = config.automaticManagedPagefile
      ? 0
      : (maximumByName.get(pageFile.name.toLowerCase()) ?? 0);
    const maximumBytes =
      configuredMaximum > 0
        ? configuredMaximum
        : systemManagedMaxBytes(totalPhysicalBytes, volume.sizeBytes);
    growthBytes += Math.min(Math.max(0, maximumBytes - pageFile.allocatedBytes), volume.freeBytes);
  }
  return growthBytes;
}

/** A commit limit within this of physical RAM counts as "no page file is backing it". */
const EMPTY_PAGE_FILE_TOLERANCE_BYTES = 64 * MIB;

/**
 * How large Windows lets a SYSTEM-MANAGED page file grow: three times RAM, or 4 GB, whichever
 * is larger, and never more than one eighth of the volume. Callers additionally bound it by
 * the volume's free space.
 */
function systemManagedMaxBytes(totalPhysicalBytes: number, volumeSizeBytes: number): number {
  return Math.min(Math.max(3 * totalPhysicalBytes, 4 * GIB), Math.floor(volumeSizeBytes / 8));
}

/** `C:\pagefile.sys` and `Win32_LogicalDisk`'s `C:` must land on the same key. */
function volumeKey(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

/**
 * CIM values cross `ConvertTo-Json` as numbers or as strings depending on the property's CIM
 * type, and a single-row result can arrive as a bare object instead of a one-element array.
 */
function readCimRows(value: unknown): Array<Record<string, unknown>> {
  const rows = Array.isArray(value) ? value : [value];
  return rows.filter(
    (row): row is Record<string, unknown> => typeof row === 'object' && row !== null
  );
}

function readNumber(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function readKilobytes(value: unknown): number | null {
  const parsed = readNumber(value);
  return parsed === null ? null : parsed * 1024;
}

function readMegabytes(value: unknown): number | null {
  const parsed = readNumber(value);
  return parsed === null ? null : parsed * MIB;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Read the macOS kernel memory pressure level.
 *
 * This is the same value jetsam itself acts on, and it is the only admission
 * signal on macOS that is not systematically wrong: byte-based estimates cannot
 * account for the compressor's remaining headroom, which is where most of a
 * Mac's reclaimable memory actually lives.
 *
 * Returns null off macOS, or when the probe fails/returns an unknown value. The
 * caller must treat null as "no pressure" (fail open) rather than falling back
 * to a byte threshold.
 */
async function getDarwinMemoryPressureLevel(): Promise<DarwinMemoryPressureLevel | null> {
  if (process.platform !== 'darwin') {
    return null;
  }

  try {
    const { stdout } = await runCommandTextLegacy(
      {
        command: 'sysctl',
        args: ['-n', 'kern.memorystatus_vm_pressure_level'],
        timeout: DARWIN_MEMORY_PROBE_TIMEOUT_MS,
        abandonPolicy: READ_ONLY_ABANDON_POLICY,
        check: 'exit-0',
      },
      toShared()
    );
    return parseDarwinPressureLevel(stdout);
  } catch {
    return null;
  }
}

export function parseDarwinPressureLevel(raw: string): DarwinMemoryPressureLevel | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }

  const value = Number.parseInt(trimmed, 10);
  if (
    value === DARWIN_PRESSURE_NORMAL ||
    value === DARWIN_PRESSURE_WARNING ||
    value === DARWIN_PRESSURE_CRITICAL
  ) {
    return value;
  }

  // Unknown level: a future kernel value must not be guessed at.
  return null;
}

/**
 * On macOS, `os.freemem()` is too conservative because it excludes memory that
 * can be reclaimed quickly, such as cached file-backed pages. Approximate the
 * reclaimable budget from `vm_stat` instead.
 *
 * This number is reported to the device resource monitor. It is deliberately NOT
 * the admission signal on macOS — see `getDarwinMemoryPressureLevel`.
 */
async function getDarwinAvailableMemoryBytes(): Promise<number | null> {
  if (process.platform !== 'darwin') {
    return null;
  }

  try {
    const { stdout } = await runCommandTextLegacy(
      {
        command: 'vm_stat',
        args: [],
        timeout: DARWIN_MEMORY_PROBE_TIMEOUT_MS,
        abandonPolicy: READ_ONLY_ABANDON_POLICY,
        check: 'exit-0',
      },
      toShared()
    );
    const parsed = parseDarwinAvailableMemoryBytes(stdout);
    if (parsed !== null) {
      return Math.max(parsed, os.freemem());
    }
  } catch {
    // Fall back to os.freemem() below.
  }

  return null;
}

export function parseDarwinAvailableMemoryBytes(vmStatOutput: string): number | null {
  const pageSizeMatch = vmStatOutput.match(/page size of\s+(\d+)\s+bytes/i);
  if (!pageSizeMatch?.[1]) {
    return null;
  }

  const pageSize = parseInt(pageSizeMatch[1], 10);
  if (!Number.isFinite(pageSize) || pageSize <= 0) {
    return null;
  }

  const counters = new Map<string, number>();
  for (const rawLine of vmStatOutput.split('\n')) {
    const line = rawLine.trim();
    const match = line.match(/^"?([^":]+?)"?:\s+(\d+)\.?$/);
    if (!match?.[1] || !match[2]) {
      continue;
    }
    counters.set(match[1].toLowerCase(), parseInt(match[2], 10));
  }

  const freePages = counters.get('pages free') ?? 0;
  const speculativePages = counters.get('pages speculative') ?? 0;
  const purgeablePages = counters.get('pages purgeable') ?? 0;
  const inactivePages = counters.get('pages inactive') ?? 0;
  const fileBackedPages = counters.get('file-backed pages');

  if (freePages === 0 && speculativePages === 0 && purgeablePages === 0 && inactivePages === 0) {
    return null;
  }

  // On macOS, cached files largely live in the inactive/file-backed set and
  // can be reclaimed quickly under pressure. Cap file-backed pages by inactive
  // pages so we do not overcount active file-backed memory.
  const reclaimableCachedPages =
    fileBackedPages !== undefined ? Math.min(fileBackedPages, inactivePages) : inactivePages;
  const availablePages = freePages + speculativePages + purgeablePages + reclaimableCachedPages;
  return availablePages * pageSize;
}

/**
 * Locate the most restrictive ancestor cgroup that actually imposes a `memory.max`.
 *
 * Returns its `/sys/fs/cgroup/...` prefix plus the limit, or null when not under
 * cgroup v2 or when every ancestor is unlimited.
 */
function findTightestCgroupLimit(): { prefix: string; maxBytes: number } | null {
  try {
    const cgroupPath = readSelfCgroupPath();
    if (cgroupPath === null) return null;

    let tightest: { prefix: string; maxBytes: number } | null = null;
    let current = cgroupPath;

    // Safety limit to avoid infinite loop
    for (let depth = 0; depth < 20; depth++) {
      const prefix = `/sys/fs/cgroup${current === '/' ? '' : current}`;
      const value = parseCgroupLimit(readFileSafe(`${prefix}/memory.max`));
      if (value !== null && (tightest === null || value < tightest.maxBytes)) {
        tightest = { prefix, maxBytes: value };
      }

      if (current === '/' || current === '') break;
      const parent = current.substring(0, current.lastIndexOf('/')) || '/';
      if (parent === current) break;
      current = parent;
    }

    return tightest;
  } catch {
    return null;
  }
}

function parseCgroupLimit(raw: string | null): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === 'max') return null;
  const value = parseInt(trimmed, 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export interface CgroupMemoryStat {
  inactiveFileBytes: number;
  activeFileBytes: number;
  slabReclaimableBytes: number;
  dirtyBytes: number;
}

export interface CgroupMemoryState {
  /** Filesystem prefix of the limiting cgroup, for diagnostics. */
  path: string;
  maxBytes: number;
  /** The throttling threshold, when set. Crossing it means reclaim pressure, not death. */
  highBytes: number | null;
  currentBytes: number;
  /** `memory.max - memory.current`: what is left without reclaiming anything. */
  hardHeadroomBytes: number;
  /** Cache and slab the kernel can hand back without swapping or OOM-killing. */
  reclaimableBytes: number;
  stat: CgroupMemoryStat;
  /** `memory.pressure` "some avg10": share of the last 10s stalled on reclaim. */
  psiSomeAvg10: number | null;
  /** `memory.events` counters. Growth means the kernel really did throttle us. */
  events: { high: number; max: number } | null;
}

/**
 * Read the limiting cgroup's memory state, including what is reclaimable.
 *
 * INVARIANT: `memory.current` counts page cache, so `memory.max - memory.current` alone
 * reports a cgroup as full when it is merely warm. A tree scan can park tens of GB of
 * clean page cache in `memory.current` while resident process memory is a fraction of
 * that; the kernel hands that cache straight back on the next allocation. Treating it as
 * unavailable is what made this guard refuse turns on a machine in no distress at all.
 */
function readCgroupMemoryState(): CgroupMemoryState | null {
  const limit = findTightestCgroupLimit();
  if (limit === null) return null;

  const currentRaw = readFileSafe(`${limit.prefix}/memory.current`);
  if (currentRaw === null) return null;
  const currentBytes = parseInt(currentRaw.trim(), 10);
  if (!Number.isFinite(currentBytes)) return null;

  const stat = parseCgroupMemoryStat(readFileSafe(`${limit.prefix}/memory.stat`) ?? '');

  return {
    path: limit.prefix,
    maxBytes: limit.maxBytes,
    highBytes: parseCgroupLimit(readFileSafe(`${limit.prefix}/memory.high`)),
    currentBytes,
    hardHeadroomBytes: Math.max(0, limit.maxBytes - currentBytes),
    reclaimableBytes: computeCgroupReclaimableBytes(stat),
    stat,
    psiSomeAvg10: parseCgroupPressureSomeAvg10(
      readFileSafe(`${limit.prefix}/memory.pressure`) ?? ''
    ),
    events: parseCgroupMemoryEvents(readFileSafe(`${limit.prefix}/memory.events`) ?? ''),
  };
}

export function parseCgroupMemoryStat(raw: string): CgroupMemoryStat {
  const values = new Map<string, number>();
  for (const line of raw.split('\n')) {
    const match = line.trim().match(/^([a-z_]+)\s+(\d+)$/);
    if (match?.[1] && match[2]) {
      values.set(match[1], parseInt(match[2], 10));
    }
  }
  return {
    inactiveFileBytes: values.get('inactive_file') ?? 0,
    activeFileBytes: values.get('active_file') ?? 0,
    slabReclaimableBytes: values.get('slab_reclaimable') ?? 0,
    dirtyBytes: (values.get('file_dirty') ?? 0) + (values.get('file_writeback') ?? 0),
  };
}

/**
 * Conservative estimate of cgroup memory the kernel can reclaim without I/O stalls.
 *
 * `inactive_file` less dirty/writeback pages (those must be written out first), plus half
 * of `slab_reclaimable` (dentry/inode caches shrink under pressure but not completely).
 *
 * `active_file` is deliberately EXCLUDED even though the kernel does deactivate and
 * reclaim it under pressure — a heavy tree scan leaves most cache in the active list, so
 * counting it would dominate the estimate with the least predictable term. The
 * under-count is intentional and is compensated by requiring a real stall signal (PSI or
 * `memory.events` growth) before any turn is refused; see `evaluateMemoryPressure`.
 */
export function computeCgroupReclaimableBytes(stat: CgroupMemoryStat): number {
  const cleanInactiveFile = Math.max(0, stat.inactiveFileBytes - stat.dirtyBytes);
  return cleanInactiveFile + Math.floor(stat.slabReclaimableBytes / 2);
}

export function parseCgroupPressureSomeAvg10(raw: string): number | null {
  const match = raw.match(/^some\s+avg10=([\d.]+)/m);
  if (!match?.[1]) return null;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) ? value : null;
}

export function parseCgroupMemoryEvents(raw: string): { high: number; max: number } | null {
  const read = (key: string): number | null => {
    const match = raw.match(new RegExp(`^${key}\\s+(\\d+)$`, 'm'));
    if (!match?.[1]) return null;
    const value = parseInt(match[1], 10);
    return Number.isFinite(value) ? value : null;
  };
  const high = read('high');
  const max = read('max');
  if (high === null || max === null) return null;
  return { high, max };
}

function readSelfCgroupPath(): string | null {
  try {
    const content = readFileSync('/proc/self/cgroup', 'utf8');
    const line = content
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('0::'));
    if (!line) return null;
    const cgroupPath = line.slice(3).trim();
    return cgroupPath || '/';
  } catch {
    return null;
  }
}

function readFileSafe(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}
