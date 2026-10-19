import { SessionId } from '@lody/shared';
import { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import {
  DARWIN_PRESSURE_CRITICAL,
  DARWIN_PRESSURE_WARNING,
  getEffectiveMemoryLimitBytes,
  type CgroupMemoryState,
  type DarwinMemoryPressureLevel,
  type MemoryPressureSnapshot,
} from '@/utils/memory';
import type { MemoryPressureSnapshotSource } from '@/monitor/memory-pressure-sampler';

/**
 * Session Garbage Collection Manager
 *
 * Unified session lifecycle manager that handles both idle cleanup and memory pressure eviction.
 *
 * ## Idle Cleanup
 *
 * Sessions idle for longer than `idleTimeoutMs` (default: 20 minutes) are fully cleaned up:
 * ACP process killed, Loro documents cleaned, session object deleted.
 * Periodic sweep runs every `sweepIntervalMs` (default: 1 minute) to find and clean idle sessions.
 *
 * ## Memory Pressure Eviction
 *
 * Before starting a new session, call `evictForMemoryPressure()`. It produces two independent
 * verdicts (see `evaluateMemoryPressure`): whether to reclaim idle sessions, and whether the
 * machine is too constrained to start a turn at all. Reclaiming is cheap and invisible to the
 * user (a reclaimed session is restored on its next turn); refusing a turn is not, so the two
 * are deliberately not the same threshold.
 *
 * The signal is platform specific:
 *
 * - **macOS** uses `kern.memorystatus_vm_pressure_level`, the kernel's own verdict and the one
 *   jetsam acts on. WARNING reclaims (the kernel is already killing idle processes at that
 *   point, so ordered reclamation beats waiting to be picked at random); only CRITICAL refuses
 *   a turn. Byte-based estimates are NOT used here and must not be reintroduced as a fallback:
 *   they cannot see compressor headroom, which is where most of a Mac's reclaimable memory is,
 *   and they consequently report pressure on perfectly healthy machines.
 * - **Linux** keeps the byte thresholds. There the limits are real and hard — a cgroup
 *   `memory.max` overrun is an OOM kill — so refusing early is correct.
 * - **Windows** refuses only on COMMIT, and only once the commit limit can no longer move.
 *   Low available physical memory is not fatal on Windows (the Memory Manager trims working
 *   sets and pages out), and the commit limit itself grows with a system-managed page file, so
 *   neither raw number is grounds for failing a user's turn on its own.
 */

export interface SessionGCConfig {
  /** Idle timeout before a session is fully cleaned up (default: 20 minutes) */
  idleTimeoutMs: number;
  /** Interval to run GC sweep (default: 1 min) */
  sweepIntervalMs: number;
  /** Enable GC (default: true) */
  enabled: boolean;
  /** Memory threshold in bytes; below this, memory pressure eviction kicks in (default: 1 GB) */
  memoryThresholdBytes: number;
  /**
   * Upper bound on sessions evicted per `evictForMemoryPressure()` call (default: 3).
   *
   * This runs on the prompt hot path — the caller awaits it before `agent.prompt` — and each
   * eviction terminates an ACP process and unloads a Loro document. Without a bound, one turn
   * start could synchronously tear down every idle session. The periodic sweep picks up the rest.
   */
  maxEvictionsPerCall: number;
  /**
   * Extra forced re-samples before a turn is refused (default: 2).
   *
   * Reclaimable page cache is returned in milliseconds, so a snapshot taken mid-scan can show
   * no headroom that is gone again a moment later. Only the about-to-fail path pays this.
   */
  pressureRecheckAttempts: number;
  /** Delay between those re-samples (default: 500ms). */
  pressureRecheckDelayMs: number;
}

export type MemoryPressureReason =
  | 'physical'
  | 'commit'
  | 'physical_and_commit'
  | 'darwin_pressure_warning'
  | 'darwin_pressure_critical'
  | 'cgroup_low_headroom'
  | 'cgroup_stalled';

export interface MemoryPressureVerdict {
  /** Reclaim idle sessions. Invisible to users; they are restored on their next turn. */
  evict: boolean;
  /** Refuse to start a turn. User-visible failure — reserved for genuinely constrained machines. */
  block: boolean;
  reason: MemoryPressureReason | null;
}

export interface SessionGCDeps {
  getSessionLastActivity: (sessionId: SessionId) => number | undefined;
  /** Whether the session has an active turn (prompting or finalizing) */
  hasActiveTurn: (sessionId: SessionId) => boolean;
  /** Whether the session has an active background goal that still needs its ACP runtime */
  hasActiveGoal: (sessionId: SessionId) => boolean | Promise<boolean>;
  hasPendingUpdates: (sessionId: SessionId) => boolean;
  hasPendingUserWork: (sessionId: SessionId) => boolean | Promise<boolean>;
  isArchiveInFlight: (sessionId: SessionId) => boolean;
  cleanSession: (sessionId: SessionId) => Promise<void>;
  getSessionIds: () => SessionId[];
  memoryPressure: MemoryPressureSnapshotSource;
  logger: Logger;
  /** Injectable so the pressure re-check backoff never needs a real sleep in tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface MemoryPressureEvictionResult {
  availableMemoryBytes: number;
  thresholdBytes: number;
  /** Something was worth reclaiming. Not a statement about whether the turn may proceed. */
  hadMemoryPressure: boolean;
  /** The turn must be refused. */
  stillUnderPressure: boolean;
  evictedSessionIds: SessionId[];
  pressureReason: MemoryPressureReason | null;
  /** macOS only; lets the failure message describe the kernel verdict instead of byte counts. */
  memoryPressureLevel?: DarwinMemoryPressureLevel;
  /** Linux only; lets the failure message break the number down instead of quoting one total. */
  cgroup?: CgroupMemoryState;
  hostAvailableBytes?: number;
  availableCommitBytes?: number;
  commitThresholdBytes?: number;
  commitLimitBytes?: number;
  committedBytes?: number;
  /** Windows only; what the page file can still add to the commit limit. */
  commitGrowthBytes?: number;
  /** Windows only; the number the refusal was actually made on. */
  effectiveAvailableCommitBytes?: number;
}

function readEnvNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const GIB = 1024 * 1024 * 1024;
const WINDOWS_COMMIT_THRESHOLD_FLOOR_BYTES = 512 * 1024 * 1024;
const WINDOWS_COMMIT_THRESHOLD_CEILING_BYTES = 2 * GIB;
const DEFAULT_MAX_EVICTIONS_PER_CALL = 3;
const DEFAULT_PRESSURE_RECHECK_ATTEMPTS = 2;
const DEFAULT_PRESSURE_RECHECK_DELAY_MS = 500;
/** ~10% of the last ten seconds spent stalled on reclaim. */
const DEFAULT_PSI_STALL_AVG10 = 10;
const DEFAULT_CGROUP_HARD_FLOOR_BYTES = 128 * 1024 * 1024;

/**
 * Default memory pressure threshold: 10% of effective memory (cgroup-aware),
 * clamped to [1 GB, 4 GB]. On a 26 GB cgroup this yields ~2.6 GB, giving the
 * system enough breathing room for kernel page cache and I/O buffers.
 */
function defaultMemoryThresholdBytes(): number {
  const tenPercent = Math.floor(getEffectiveMemoryLimitBytes() * 0.1);
  return Math.max(GIB, Math.min(4 * GIB, tenPercent));
}

export function loadGCConfig(): SessionGCConfig {
  return {
    idleTimeoutMs: readEnvNumber('LODY_SESSION_GC_IDLE_TIMEOUT_MS', 20 * 60 * 1000), // 20 minutes
    sweepIntervalMs: readEnvNumber('LODY_SESSION_GC_SWEEP_INTERVAL_MS', 60 * 1000),
    enabled: process.env.LODY_SESSION_GC_ENABLED !== 'false',
    memoryThresholdBytes: readEnvNumber(
      'LODY_SESSION_GC_MEMORY_THRESHOLD_BYTES',
      defaultMemoryThresholdBytes()
    ),
    maxEvictionsPerCall: readEnvNumber(
      'LODY_SESSION_GC_MAX_EVICTIONS_PER_CALL',
      DEFAULT_MAX_EVICTIONS_PER_CALL
    ),
    pressureRecheckAttempts: readEnvNumber(
      'LODY_SESSION_GC_PRESSURE_RECHECK_ATTEMPTS',
      DEFAULT_PRESSURE_RECHECK_ATTEMPTS
    ),
    pressureRecheckDelayMs: readEnvNumber(
      'LODY_SESSION_GC_PRESSURE_RECHECK_DELAY_MS',
      DEFAULT_PRESSURE_RECHECK_DELAY_MS
    ),
  };
}

function getWindowsCommitThresholdBytes(memoryThresholdBytes: number): number {
  return Math.max(
    WINDOWS_COMMIT_THRESHOLD_FLOOR_BYTES,
    Math.min(WINDOWS_COMMIT_THRESHOLD_CEILING_BYTES, memoryThresholdBytes)
  );
}

export interface MemoryPressureThresholds {
  platform: NodeJS.Platform;
  thresholdBytes: number;
  commitThresholdBytes: number;
  /**
   * `memory.pressure` "some avg10" at or above which the cgroup counts as genuinely stalled.
   * 10 means ~10% of the last ten seconds was spent waiting on reclaim.
   */
  psiStallAvg10: number;
  /**
   * Fallback for kernels built without PSI: hard headroom (`memory.max - memory.current`,
   * no reclaim credited) below this means every allocation forces synchronous reclaim.
   */
  cgroupHardFloorBytes: number;
}

/**
 * Windows: reclaim on either byte term, but refuse ONLY when commit is exhausted and the commit
 * limit itself has nowhere left to go.
 *
 * `CommitLimit - CommitCharge` is not headroom on this platform. With the default system-managed
 * page file the limit grows on demand, so a healthy machine sits permanently a few hundred MB
 * under its CURRENT limit; `effectiveAvailableCommitBytes` adds back what the page file can still
 * grow (see `utils/memory.ts`). Low `AvailableBytes` is not a refusal signal either: Windows trims
 * working sets and pages out rather than failing an allocation. A failed probe leaves both commit
 * terms absent and therefore fails open, as on macOS.
 */
function evaluateWindowsMemoryPressure(
  snapshot: MemoryPressureSnapshot,
  thresholds: MemoryPressureThresholds
): MemoryPressureVerdict {
  const physicalLow = snapshot.availableMemoryBytes < thresholds.thresholdBytes;
  const commitLow =
    snapshot.availableCommitBytes !== undefined &&
    snapshot.availableCommitBytes < thresholds.commitThresholdBytes;
  const commitExhausted =
    snapshot.effectiveAvailableCommitBytes !== undefined &&
    snapshot.effectiveAvailableCommitBytes < thresholds.commitThresholdBytes;

  if (commitExhausted) {
    return { evict: true, block: true, reason: physicalLow ? 'physical_and_commit' : 'commit' };
  }

  const reason: MemoryPressureReason | null =
    physicalLow && commitLow
      ? 'physical_and_commit'
      : physicalLow
        ? 'physical'
        : commitLow
          ? 'commit'
          : null;
  return { evict: reason !== null, block: false, reason };
}

/**
 * Decide, from one memory sample, whether to reclaim idle sessions and whether to refuse a turn.
 *
 * Pure — the platform is an explicit input so every branch is testable everywhere.
 */
export function evaluateMemoryPressure(
  snapshot: MemoryPressureSnapshot,
  thresholds: MemoryPressureThresholds
): MemoryPressureVerdict {
  if (thresholds.platform === 'darwin') {
    // Fail open. An unreadable level must not silently reactivate the byte thresholds:
    // they misreport pressure on healthy Macs, which is the bug this branch exists to fix.
    if (snapshot.memoryPressureLevel === DARWIN_PRESSURE_CRITICAL) {
      return { evict: true, block: true, reason: 'darwin_pressure_critical' };
    }
    if (snapshot.memoryPressureLevel === DARWIN_PRESSURE_WARNING) {
      return { evict: true, block: false, reason: 'darwin_pressure_warning' };
    }
    return { evict: false, block: false, reason: null };
  }

  if (thresholds.platform === 'win32') {
    return evaluateWindowsMemoryPressure(snapshot, thresholds);
  }

  const cgroup = snapshot.cgroup;
  if (cgroup) {
    // `MemAvailable` is already reclaim-aware, so when the HOST is the binding constraint the
    // number is trustworthy on its own and may refuse a turn directly.
    const hostLow =
      snapshot.hostAvailableBytes !== undefined &&
      snapshot.hostAvailableBytes < thresholds.thresholdBytes;
    const cgroupLow =
      cgroup.hardHeadroomBytes + cgroup.reclaimableBytes < thresholds.thresholdBytes;

    // The cgroup estimate deliberately under-counts (active_file is excluded), so low headroom
    // alone is NOT enough to fail a user's turn — a tree scan parks tens of GB of clean cache in
    // `memory.current` and the kernel gives it straight back. Require evidence that reclaim is
    // actually hurting: PSI stall, or, on kernels without PSI, hard headroom so low that every
    // allocation forces synchronous reclaim.
    const stalled =
      cgroup.psiSomeAvg10 !== null
        ? cgroup.psiSomeAvg10 >= thresholds.psiStallAvg10
        : cgroup.hardHeadroomBytes < thresholds.cgroupHardFloorBytes;

    if (hostLow || (cgroupLow && stalled)) {
      return { evict: true, block: true, reason: stalled ? 'cgroup_stalled' : 'physical' };
    }
    if (cgroupLow) {
      // Worth reclaiming idle sessions — invisible to the user — but not worth refusing a turn.
      return { evict: true, block: false, reason: 'cgroup_low_headroom' };
    }
    return { evict: false, block: false, reason: null };
  }

  const physicalPressure = snapshot.availableMemoryBytes < thresholds.thresholdBytes;
  const reason: MemoryPressureReason | null = physicalPressure ? 'physical' : null;

  // No cgroup limit: this is Linux `MemAvailable`, which already credits reclaimable cache and
  // is therefore trustworthy enough to refuse on. (Windows returned above; it does not share
  // this branch, because its equivalent number is not a refusal signal.)
  return { evict: reason !== null, block: reason !== null, reason };
}

export class SessionGCManager {
  private sweepInterval: NodeJS.Timeout | null = null;

  constructor(
    private config: SessionGCConfig,
    private deps: SessionGCDeps,
    /** Injectable so both the kernel-signal and byte-threshold branches are testable anywhere. */
    private platform: NodeJS.Platform = process.platform
  ) {}

  start(): void {
    if (!this.config.enabled) {
      this.deps.logger.debug('[GC] Session GC is disabled');
      return;
    }
    const pressureSignal =
      this.platform === 'darwin'
        ? 'kern.memorystatus_vm_pressure_level'
        : this.platform === 'win32'
          ? `commit+pagefile-growth<${Math.round(
              getWindowsCommitThresholdBytes(this.config.memoryThresholdBytes) / 1024 / 1024
            )}MB`
          : `available<${Math.round(this.config.memoryThresholdBytes / 1024 / 1024)}MB`;
    this.deps.logger.debug(
      `[GC] Starting session GC (interval=${this.config.sweepIntervalMs}ms, ` +
        `idleTimeout=${this.config.idleTimeoutMs}ms, ` +
        `pressureSignal=${pressureSignal}, ` +
        `maxEvictionsPerCall=${this.config.maxEvictionsPerCall})`
    );
    this.sweepInterval = setInterval(() => void this.sweep(), this.config.sweepIntervalMs);
  }

  stop(): void {
    if (this.sweepInterval) {
      clearInterval(this.sweepInterval);
      this.sweepInterval = null;
      this.deps.logger.debug('[GC] Session GC stopped');
    }
  }

  /**
   * Periodic sweep: clean all sessions that have been idle longer than `idleTimeoutMs`.
   */
  async sweep(): Promise<void> {
    const sweepStart = Date.now();
    const candidates = await this.getIdleCandidates();

    if (candidates.length === 0) {
      return;
    }

    // Clean longest-idle first
    candidates.sort((a, b) => b.idleMs - a.idleMs);

    let cleaned = 0;
    let skipped = 0;
    for (const { sessionId } of candidates) {
      if (!(await this.isStillEligibleForGC(sessionId))) {
        skipped++;
        continue;
      }

      try {
        await this.deps.cleanSession(sessionId);
        cleaned++;
      } catch (error) {
        this.deps.logger.error(
          `[GC] Failed to clean session ${sessionId}: ${formatErrorMessage(error)}`
        );
      }
    }

    if (skipped > 0) {
      this.deps.logger.debug(`[GC] Skipped ${skipped} sessions that became active during sweep`);
    }

    const sweepDuration = Date.now() - sweepStart;
    this.deps.logger.debug(
      `[GC] Sweep completed: cleaned ${cleaned}/${candidates.length} sessions in ${sweepDuration}ms`
    );
  }

  /**
   * Reclaim idle sessions under memory pressure, and report whether a turn may start.
   *
   * Call this before starting a turn. Evicts the longest-idle sessions one at a time (bounded by
   * `maxEvictionsPerCall`) while the platform signal still asks for reclamation, then reports
   * `stillUnderPressure` — which is the REFUSE verdict, not the reclaim one. On macOS those two
   * differ: WARNING reclaims silently, only CRITICAL refuses.
   *
   * @param excludeSessionId - Session to exclude from eviction (e.g. the session being started)
   */
  async evictForMemoryPressure(
    excludeSessionId?: SessionId
  ): Promise<MemoryPressureEvictionResult> {
    const thresholdBytes = this.config.memoryThresholdBytes;
    const commitThresholdBytes = getWindowsCommitThresholdBytes(thresholdBytes);
    const thresholds: MemoryPressureThresholds = {
      platform: this.platform,
      thresholdBytes,
      commitThresholdBytes,
      psiStallAvg10: DEFAULT_PSI_STALL_AVG10,
      cgroupHardFloorBytes: DEFAULT_CGROUP_HARD_FLOOR_BYTES,
    };
    let memorySnapshot = await this.deps.memoryPressure.getLatest();
    let verdict = evaluateMemoryPressure(memorySnapshot, thresholds);

    // The cached sample may be seconds old. That is fine for deciding "nothing to do", but never
    // for acting: memory moves fast enough that a stale sample can both invent pressure that is
    // already over and miss pressure that just started.
    if (this.config.enabled && verdict.evict) {
      memorySnapshot = await this.deps.memoryPressure.refresh();
      verdict = evaluateMemoryPressure(memorySnapshot, thresholds);
    }

    if (!this.config.enabled || !verdict.evict) {
      return this.buildEvictionResult({
        snapshot: memorySnapshot,
        thresholdBytes,
        commitThresholdBytes,
        hadMemoryPressure: false,
        // A disabled GC never blocks: it is the operator opting out of the whole mechanism.
        verdict: this.config.enabled ? verdict : { evict: false, block: false, reason: null },
        evictedSessionIds: [],
      });
    }

    this.deps.logger.debug(
      `[GC] Memory pressure detected (${verdict.reason}): ${this.describeMemoryState(
        memorySnapshot,
        thresholdBytes,
        commitThresholdBytes
      )}`
    );

    // Get all sessions sorted by idle time (longest idle first)
    const sessions = this.getSessionsWithIdleTime();
    sessions.sort((a, b) => b.idleMs - a.idleMs);

    const evictedSessionIds: SessionId[] = [];
    for (const { sessionId, idleMs } of sessions) {
      if (!verdict.evict || evictedSessionIds.length >= this.config.maxEvictionsPerCall) {
        break;
      }

      if (excludeSessionId && sessionId === excludeSessionId) {
        continue;
      }

      // Skip sessions with no idle time (just created)
      if (idleMs === 0) {
        continue;
      }

      if (!(await this.isEligibleForCleanup(sessionId))) {
        continue;
      }

      try {
        this.deps.logger.debug(
          `[GC] Evicting session ${sessionId} (idle ${Math.round(idleMs / 1000)}s) due to memory pressure`
        );
        await this.deps.cleanSession(sessionId);
        evictedSessionIds.push(sessionId);
        // Re-check memory after eviction
        memorySnapshot = await this.deps.memoryPressure.refresh();
        verdict = evaluateMemoryPressure(memorySnapshot, thresholds);
      } catch (error) {
        this.deps.logger.error(
          `[GC] Failed to evict session ${sessionId}: ${formatErrorMessage(error)}`
        );
      }
    }

    // Last chance before failing a user's turn. Reclaimable cache comes back in milliseconds, so
    // a sample taken during a burst of file I/O can report no headroom that is already gone by
    // the time we would surface the error. Only this path pays the delay.
    for (
      let attempt = 0;
      verdict.block && attempt < this.config.pressureRecheckAttempts;
      attempt++
    ) {
      await this.sleep(this.config.pressureRecheckDelayMs);
      memorySnapshot = await this.deps.memoryPressure.refresh();
      verdict = evaluateMemoryPressure(memorySnapshot, thresholds);
      if (!verdict.block) {
        this.deps.logger.debug(
          `[GC] Memory pressure cleared on recheck ${attempt + 1}: ${this.describeMemoryState(
            memorySnapshot,
            thresholdBytes,
            commitThresholdBytes
          )}`
        );
      }
    }

    const availableMemory = memorySnapshot.availableMemoryBytes;
    const stillUnderPressure = verdict.block;

    if (evictedSessionIds.length > 0) {
      this.deps.logger.debug(
        `[GC] Memory pressure eviction complete: evicted ${evictedSessionIds.length} sessions, ` +
          `available memory now ${Math.round(availableMemory / 1024 / 1024)}MB`
      );
    } else if (stillUnderPressure) {
      this.deps.logger.debug(
        '[GC] Memory pressure persists but no idle sessions were eligible for eviction'
      );
    }

    return this.buildEvictionResult({
      snapshot: memorySnapshot,
      thresholdBytes,
      commitThresholdBytes,
      hadMemoryPressure: true,
      verdict,
      evictedSessionIds,
    });
  }

  private buildEvictionResult(options: {
    snapshot: MemoryPressureSnapshot;
    thresholdBytes: number;
    commitThresholdBytes: number;
    hadMemoryPressure: boolean;
    verdict: MemoryPressureVerdict;
    evictedSessionIds: SessionId[];
  }): MemoryPressureEvictionResult {
    const { snapshot, thresholdBytes, commitThresholdBytes, verdict } = options;
    return {
      availableMemoryBytes: snapshot.availableMemoryBytes,
      thresholdBytes,
      hadMemoryPressure: options.hadMemoryPressure,
      stillUnderPressure: verdict.block,
      evictedSessionIds: options.evictedSessionIds,
      pressureReason: verdict.reason,
      ...(snapshot.memoryPressureLevel !== undefined
        ? { memoryPressureLevel: snapshot.memoryPressureLevel }
        : {}),
      ...(snapshot.cgroup !== undefined ? { cgroup: snapshot.cgroup } : {}),
      ...(snapshot.hostAvailableBytes !== undefined
        ? { hostAvailableBytes: snapshot.hostAvailableBytes }
        : {}),
      ...(snapshot.availableCommitBytes !== undefined
        ? {
            availableCommitBytes: snapshot.availableCommitBytes,
            commitThresholdBytes,
            commitLimitBytes: snapshot.commitLimitBytes,
            committedBytes: snapshot.committedBytes,
            // Both stay absent when page file growth could not be determined.
            ...(snapshot.commitGrowthBytes !== undefined
              ? { commitGrowthBytes: snapshot.commitGrowthBytes }
              : {}),
            ...(snapshot.effectiveAvailableCommitBytes !== undefined
              ? { effectiveAvailableCommitBytes: snapshot.effectiveAvailableCommitBytes }
              : {}),
          }
        : {}),
    };
  }

  private sleep(ms: number): Promise<void> {
    if (this.deps.sleep) return this.deps.sleep(ms);
    return new Promise((resolve) => {
      setTimeout(resolve, ms).unref?.();
    });
  }

  private describeMemoryState(
    snapshot: MemoryPressureSnapshot,
    thresholdBytes: number,
    commitThresholdBytes: number
  ): string {
    if (snapshot.memoryPressureLevel !== undefined) {
      return `kernel pressure level ${snapshot.memoryPressureLevel}`;
    }

    const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);
    const cgroup = snapshot.cgroup;
    if (cgroup) {
      return (
        `cgroup ${cgroup.path}: hard headroom ${mb(cgroup.hardHeadroomBytes)}MB + ` +
        `reclaimable ${mb(cgroup.reclaimableBytes)}MB (of ${mb(cgroup.stat.activeFileBytes)}MB ` +
        `active file cache not counted), host available ` +
        `${snapshot.hostAvailableBytes !== undefined ? mb(snapshot.hostAvailableBytes) : '?'}MB, ` +
        `PSI some avg10 ${cgroup.psiSomeAvg10 ?? '?'}, threshold ${mb(thresholdBytes)}MB`
      );
    }

    // The growth term is the whole reason this platform stopped refusing healthy machines, so
    // it is logged next to the raw headroom rather than folded silently into one total.
    // "unknown" is a distinct state from 0 and must read that way: it means the probe could not
    // rule growth out, which is why no turn was refused.
    const growthText =
      snapshot.commitGrowthBytes !== undefined
        ? `${mb(snapshot.commitGrowthBytes)}MB page file growth`
        : 'page file growth unknown';
    const commitText =
      snapshot.availableCommitBytes !== undefined
        ? `, commit headroom ${mb(snapshot.availableCommitBytes)}MB + ${growthText} ` +
          `(threshold: ${mb(commitThresholdBytes)}MB)`
        : '';
    return (
      `${Math.round(snapshot.availableMemoryBytes / 1024 / 1024)}MB available ` +
      `(threshold: ${Math.round(thresholdBytes / 1024 / 1024)}MB)${commitText}`
    );
  }

  /**
   * Get idle sessions eligible for cleanup, sorted by idle time (longest idle first).
   */
  private async getIdleCandidates(): Promise<Array<{ sessionId: SessionId; idleMs: number }>> {
    const sessions = this.getSessionsWithIdleTime();
    const candidates: Array<{ sessionId: SessionId; idleMs: number }> = [];

    for (const session of sessions) {
      if (session.idleMs < this.config.idleTimeoutMs) {
        continue;
      }

      if (!(await this.isEligibleForCleanup(session.sessionId))) {
        continue;
      }

      candidates.push(session);
    }

    return candidates;
  }

  private getSessionsWithIdleTime(): Array<{ sessionId: SessionId; idleMs: number }> {
    const now = Date.now();
    const result: Array<{ sessionId: SessionId; idleMs: number }> = [];
    const sessionIds = this.deps.getSessionIds();

    for (const sessionId of sessionIds) {
      const lastActivity = this.deps.getSessionLastActivity(sessionId);
      if (lastActivity === undefined) {
        // No activity record, probably just created, treat as most recent (protected)
        result.push({ sessionId, idleMs: 0 });
        continue;
      }

      const idleMs = now - lastActivity;
      result.push({ sessionId, idleMs });
    }

    return result;
  }

  /**
   * Check if a session is eligible for cleanup.
   * A session is NOT eligible if it has an active turn, active goal,
   * pending updates, pending user work, or archive in flight.
   */
  private async isEligibleForCleanup(sessionId: SessionId): Promise<boolean> {
    if (this.deps.hasActiveTurn(sessionId)) {
      return false;
    }

    if (await this.deps.hasActiveGoal(sessionId)) {
      return false;
    }

    if (this.deps.hasPendingUpdates(sessionId)) {
      return false;
    }

    if (await this.deps.hasPendingUserWork(sessionId)) {
      return false;
    }

    if (this.deps.isArchiveInFlight(sessionId)) {
      return false;
    }

    return true;
  }

  /**
   * Re-check eligibility right before cleanup to guard against races.
   * Also verifies the session hasn't become active since candidate selection.
   */
  private async isStillEligibleForGC(sessionId: SessionId): Promise<boolean> {
    if (!(await this.isEligibleForCleanup(sessionId))) {
      return false;
    }

    const lastActivity = this.deps.getSessionLastActivity(sessionId);
    if (lastActivity !== undefined) {
      const idleMs = Date.now() - lastActivity;
      if (idleMs < this.config.idleTimeoutMs) {
        return false;
      }
    }

    return true;
  }
}
