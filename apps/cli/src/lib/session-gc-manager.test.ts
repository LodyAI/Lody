import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { SessionId } from '@lody/shared';
import {
  SessionGCManager,
  SessionGCConfig,
  type SessionNativeWork,
  type SessionGCDeps,
  evaluateMemoryPressure,
} from './session-gc-manager';

// Mock the memory utility
vi.mock('@/utils/memory', () => ({
  getMemoryPressureSnapshot: vi.fn(async () => ({
    availableMemoryBytes: 4 * 1024 * 1024 * 1024,
    effectiveMemoryLimitBytes: 32 * 1024 * 1024 * 1024,
  })),
  getEffectiveMemoryLimitBytes: vi.fn(() => 32 * 1024 * 1024 * 1024), // 32 GB by default
  DARWIN_PRESSURE_NORMAL: 1,
  DARWIN_PRESSURE_WARNING: 2,
  DARWIN_PRESSURE_CRITICAL: 4,
}));

import { getMemoryPressureSnapshot } from '@/utils/memory';

const mockedGetMemoryPressureSnapshot = vi.mocked(getMemoryPressureSnapshot);

describe('SessionGCManager', () => {
  let cleanMock: ReturnType<typeof vi.fn<(sessionId: SessionId) => Promise<void>>>;
  let loggerMock: {
    info: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  let sessionActivities: Map<SessionId, number>;
  let activeTurns: Set<SessionId>;
  let activeGoals: Set<SessionId>;
  let pendingUpdates: Set<SessionId>;
  let pendingUserWork: Set<SessionId>;
  let archiveInFlight: Set<SessionId>;
  let nativeWork: Map<SessionId, SessionNativeWork>;
  let sleepCalls: number[];

  beforeEach(() => {
    vi.useFakeTimers();
    sleepCalls = [];
    cleanMock = vi.fn<(sessionId: SessionId) => Promise<void>>().mockResolvedValue(undefined);
    loggerMock = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    sessionActivities = new Map();
    activeTurns = new Set();
    activeGoals = new Set();
    pendingUpdates = new Set();
    pendingUserWork = new Set();
    archiveInFlight = new Set();
    nativeWork = new Map();
    mockedGetMemoryPressureSnapshot.mockResolvedValue({
      availableMemoryBytes: 4 * 1024 * 1024 * 1024,
      effectiveMemoryLimitBytes: 32 * 1024 * 1024 * 1024,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Platform is explicit in every test: the byte-threshold branch does not run on macOS, so a
  // host-dependent default would make these pass or fail based on the developer's laptop.
  const createManager = (
    config?: Partial<SessionGCConfig>,
    platform: NodeJS.Platform = 'linux',
    overrides: Partial<SessionGCDeps> = {}
  ) => {
    const defaultConfig: SessionGCConfig = {
      idleTimeoutMs: 20 * 60 * 1000, // 20 minutes
      sweepIntervalMs: 60 * 1000, // 1 minute
      nativeBackgroundMaxIdleMs: 24 * 60 * 60 * 1000,
      enabled: true,
      memoryThresholdBytes: 1024 * 1024 * 1024, // 1 GB
      maxEvictionsPerCall: 100,
      pressureRecheckAttempts: 0,
      pressureRecheckDelayMs: 500,
      ...config,
    };
    return new SessionGCManager(
      defaultConfig,
      {
        getSessionLastActivity: (sessionId) => sessionActivities.get(sessionId),
        getNativeWork: (sessionId) => nativeWork.get(sessionId) ?? null,
        hasActiveTurn: (sessionId) => activeTurns.has(sessionId),
        hasActiveGoal: async (sessionId) => activeGoals.has(sessionId),
        hasPendingUpdates: (sessionId) => pendingUpdates.has(sessionId),
        hasPendingUserWork: async (sessionId) => pendingUserWork.has(sessionId),
        isArchiveInFlight: (sessionId) => archiveInFlight.has(sessionId),
        cleanSession: cleanMock,
        getSessionIds: () => [...sessionActivities.keys()],
        memoryPressure: {
          getLatest: mockedGetMemoryPressureSnapshot,
          refresh: mockedGetMemoryPressureSnapshot,
        },
        logger: loggerMock as any,
        // Never a real timer: the recheck backoff must not make these tests wall-clock dependent.
        sleep: async (ms: number) => {
          sleepCalls.push(ms);
        },
        ...overrides,
      },
      platform
    );
  };

  it.each(['idle', 'memory'] as const)(
    'isolates a failed eligibility read and retries it: %s',
    async (mode) => {
      const broken = 'broken' as SessionId;
      const healthy = 'healthy' as SessionId;
      sessionActivities.set(broken, Date.now() - 30 * 60_000);
      sessionActivities.set(healthy, Date.now() - 25 * 60_000);
      mockedGetMemoryPressureSnapshot.mockResolvedValue({ availableMemoryBytes: 512 * 1024 ** 2 });
      let failed = true;
      const cleaned = new Set<SessionId>();
      const manager = createManager(undefined, 'linux', {
        hasPendingUserWork: async (id) => {
          if (id === broken && failed) throw new Error('metadata unavailable');
          return false;
        },
        cleanSession: async (id) => {
          cleaned.add(id);
        },
      });
      const collect = () => (mode === 'idle' ? manager.sweep() : manager.evictForMemoryPressure());
      await collect();
      expect([...cleaned]).toEqual([healthy]);
      failed = false;
      await collect();
      expect(cleaned.has(broken)).toBe(true);
    }
  );

  it.each([false, true])(
    'bounds slow reclamation and uses live pressure, block=%s',
    async (block) => {
      const id = 'slow' as SessionId;
      sessionActivities.set(id, Date.now() - 30 * 60_000);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<boolean>();
      const cleaned = Promise.withResolvers<void>();
      let healthy = false;
      const manager = createManager(undefined, 'linux', {
        hasPendingUserWork: () => {
          entered.resolve();
          return release.promise;
        },
        cleanSession: async () => {
          cleaned.resolve();
        },
      });
      mockedGetMemoryPressureSnapshot.mockImplementation(async () => ({
        availableMemoryBytes: healthy ? 4 * 1024 ** 3 : 512 * 1024 ** 2,
      }));
      const first = manager.evictForMemoryPressure();
      await entered.promise;
      healthy = !block;
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await first).stillUnderPressure).toBe(block);
      expect((await manager.evictForMemoryPressure()).stillUnderPressure).toBe(block);
      release.resolve(false);
      await cleaned.promise;
      await manager.evictForMemoryPressure();
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  describe('sweep', () => {
    it('cleans sessions idle for longer than timeout', async () => {
      const manager = createManager({ idleTimeoutMs: 1000 });
      const now = Date.now();
      const s1 = 'session-1' as SessionId;
      const s2 = 'session-2' as SessionId;

      // s1 idle for 2000ms, s2 idle for 500ms
      sessionActivities.set(s1, now - 2000);
      sessionActivities.set(s2, now - 500);

      await manager.sweep();

      expect(cleanMock).toHaveBeenCalledTimes(1);
      expect(cleanMock).toHaveBeenCalledWith(s1);
    });

    it('does not clean sessions with active turns', async () => {
      const manager = createManager({ idleTimeoutMs: 1000 });
      const now = Date.now();
      const s1 = 'session-1' as SessionId;

      sessionActivities.set(s1, now - 2000);
      activeTurns.add(s1);

      await manager.sweep();

      expect(cleanMock).not.toHaveBeenCalled();
    });

    it('never cleans a session whose agent is running outside a turn', async () => {
      // A model turn Claude started by itself after a background task finished.
      const manager = createManager({ idleTimeoutMs: 1000, nativeBackgroundMaxIdleMs: 5000 });
      const s1 = 'session-1' as SessionId;
      sessionActivities.set(s1, Date.now() - 60_000);
      nativeWork.set(s1, 'running');

      await manager.sweep();

      expect(cleanMock).not.toHaveBeenCalled();
    });

    it('spares a session waiting on background tasks until the ceiling', async () => {
      const manager = createManager({ idleTimeoutMs: 1000, nativeBackgroundMaxIdleMs: 5000 });
      const waiting = 'session-waiting' as SessionId;
      const forgotten = 'session-forgotten' as SessionId;
      const now = Date.now();
      sessionActivities.set(waiting, now - 2000);
      sessionActivities.set(forgotten, now - 6000);
      nativeWork.set(waiting, 'background');
      nativeWork.set(forgotten, 'background');

      await manager.sweep();

      expect(cleanMock.mock.calls).toEqual([[forgotten]]);
    });

    it('cleans the session once its background tasks are gone', async () => {
      const manager = createManager({ idleTimeoutMs: 1000 });
      const s1 = 'session-1' as SessionId;
      sessionActivities.set(s1, Date.now() - 2000);
      nativeWork.set(s1, 'background');

      await manager.sweep();
      expect(cleanMock).not.toHaveBeenCalled();

      nativeWork.delete(s1);
      await manager.sweep();
      expect(cleanMock.mock.calls).toEqual([[s1]]);
    });

    it('retains a session that starts background work during the final eligibility read', async () => {
      const sessionId = 'session-background-race' as SessionId;
      sessionActivities.set(sessionId, Date.now() - 2000);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let reads = 0;
      const manager = createManager(
        { idleTimeoutMs: 1000, nativeBackgroundMaxIdleMs: 5000 },
        'linux',
        {
          hasPendingUserWork: async () => {
            if (++reads === 2) {
              entered.resolve();
              await release.promise;
            }
            return false;
          },
        }
      );

      const sweep = manager.sweep();
      await entered.promise;
      nativeWork.set(sessionId, 'background');
      release.resolve();
      await sweep;

      expect(cleanMock).not.toHaveBeenCalled();
    });

    it('does not clean sessions in archive flight', async () => {
      const manager = createManager({ idleTimeoutMs: 1000 });
      const now = Date.now();
      const s1 = 'session-1' as SessionId;

      sessionActivities.set(s1, now - 2000);
      archiveInFlight.add(s1);

      await manager.sweep();

      expect(cleanMock).not.toHaveBeenCalled();
    });
  });

  describe('evictForMemoryPressure', () => {
    it('may evict a session waiting on background tasks, never a running one', async () => {
      const manager = createManager();
      const now = Date.now();
      const running = 'session-running' as SessionId;
      const background = 'session-background' as SessionId;
      sessionActivities.set(running, now - 90_000);
      sessionActivities.set(background, now - 60_000);
      nativeWork.set(running, 'running');
      nativeWork.set(background, 'background');
      mockedGetMemoryPressureSnapshot.mockResolvedValue({
        availableMemoryBytes: 500 * 1024 * 1024,
        effectiveMemoryLimitBytes: 32 * 1024 * 1024 * 1024,
      });

      const result = await manager.evictForMemoryPressure();

      expect(result.evictedSessionIds).toEqual([background]);
    });

    it('does nothing when memory is above threshold', async () => {
      const manager = createManager();
      const s1 = 'session-1' as SessionId;
      sessionActivities.set(s1, Date.now() - 60000);

      mockedGetMemoryPressureSnapshot.mockResolvedValue({
        availableMemoryBytes: 2 * 1024 * 1024 * 1024,
        effectiveMemoryLimitBytes: 32 * 1024 * 1024 * 1024,
      });

      await manager.evictForMemoryPressure();

      expect(cleanMock).not.toHaveBeenCalled();
    });

    it('evicts multiple sessions until memory is above threshold', async () => {
      const manager = createManager();
      const now = Date.now();
      const s1 = 'session-1' as SessionId;
      const s2 = 'session-2' as SessionId;
      const s3 = 'session-3' as SessionId;

      sessionActivities.set(s1, now - 90000);
      sessionActivities.set(s2, now - 60000);
      sessionActivities.set(s3, now - 30000);

      mockedGetMemoryPressureSnapshot
        .mockResolvedValueOnce({
          availableMemoryBytes: 500 * 1024 * 1024,
          effectiveMemoryLimitBytes: 32 * 1024 * 1024 * 1024,
        })
        .mockResolvedValueOnce({
          availableMemoryBytes: 500 * 1024 * 1024,
          effectiveMemoryLimitBytes: 32 * 1024 * 1024 * 1024,
        })
        .mockResolvedValueOnce({
          availableMemoryBytes: 700 * 1024 * 1024,
          effectiveMemoryLimitBytes: 32 * 1024 * 1024 * 1024,
        })
        .mockResolvedValueOnce({
          availableMemoryBytes: 1.5 * 1024 * 1024 * 1024,
          effectiveMemoryLimitBytes: 32 * 1024 * 1024 * 1024,
        });

      await manager.evictForMemoryPressure();

      expect(cleanMock).toHaveBeenCalledTimes(2);
      expect(cleanMock.mock.calls[0]![0]).toBe(s1);
      expect(cleanMock.mock.calls[1]![0]).toBe(s2);
    });

    it('excludes the specified session from eviction', async () => {
      const manager = createManager();
      const now = Date.now();
      const s1 = 'session-1' as SessionId;
      const s2 = 'session-2' as SessionId;

      sessionActivities.set(s1, now - 60000);
      sessionActivities.set(s2, now - 30000);

      mockedGetMemoryPressureSnapshot
        .mockResolvedValueOnce({
          availableMemoryBytes: 500 * 1024 * 1024,
          effectiveMemoryLimitBytes: 32 * 1024 * 1024 * 1024,
        })
        .mockResolvedValueOnce({
          availableMemoryBytes: 500 * 1024 * 1024,
          effectiveMemoryLimitBytes: 32 * 1024 * 1024 * 1024,
        })
        .mockResolvedValueOnce({
          availableMemoryBytes: 2 * 1024 * 1024 * 1024,
          effectiveMemoryLimitBytes: 32 * 1024 * 1024 * 1024,
        });

      await manager.evictForMemoryPressure(s1); // exclude s1

      expect(cleanMock).toHaveBeenCalledTimes(1);
      expect(cleanMock).toHaveBeenCalledWith(s2); // s1 excluded, so s2 is evicted
    });

    it('skips sessions with pending updates', async () => {
      const manager = createManager();
      const now = Date.now();
      const s1 = 'session-1' as SessionId;
      const s2 = 'session-2' as SessionId;

      sessionActivities.set(s1, now - 60000);
      sessionActivities.set(s2, now - 30000);
      pendingUpdates.add(s1);

      mockedGetMemoryPressureSnapshot
        .mockResolvedValueOnce({
          availableMemoryBytes: 500 * 1024 * 1024,
          effectiveMemoryLimitBytes: 32 * 1024 * 1024 * 1024,
        })
        .mockResolvedValueOnce({
          availableMemoryBytes: 500 * 1024 * 1024,
          effectiveMemoryLimitBytes: 32 * 1024 * 1024 * 1024,
        })
        .mockResolvedValueOnce({
          availableMemoryBytes: 2 * 1024 * 1024 * 1024,
          effectiveMemoryLimitBytes: 32 * 1024 * 1024 * 1024,
        });

      await manager.evictForMemoryPressure();

      expect(cleanMock).toHaveBeenCalledTimes(1);
      expect(cleanMock).toHaveBeenCalledWith(s2);
    });

    it('skips sessions with pending user work', async () => {
      const manager = createManager();
      const now = Date.now();
      const s1 = 'session-1' as SessionId;
      const s2 = 'session-2' as SessionId;

      sessionActivities.set(s1, now - 60000);
      sessionActivities.set(s2, now - 30000);
      pendingUserWork.add(s1);

      mockedGetMemoryPressureSnapshot
        .mockResolvedValueOnce({
          availableMemoryBytes: 500 * 1024 * 1024,
          effectiveMemoryLimitBytes: 32 * 1024 * 1024 * 1024,
        })
        .mockResolvedValueOnce({
          availableMemoryBytes: 500 * 1024 * 1024,
          effectiveMemoryLimitBytes: 32 * 1024 * 1024 * 1024,
        })
        .mockResolvedValueOnce({
          availableMemoryBytes: 2 * 1024 * 1024 * 1024,
          effectiveMemoryLimitBytes: 32 * 1024 * 1024 * 1024,
        });

      await manager.evictForMemoryPressure();

      expect(cleanMock).toHaveBeenCalledTimes(1);
      expect(cleanMock).toHaveBeenCalledWith(s2);
    });

    it('skips sessions with active goals', async () => {
      const manager = createManager();
      const now = Date.now();
      const s1 = 'session-1' as SessionId;
      const s2 = 'session-2' as SessionId;

      sessionActivities.set(s1, now - 60000);
      sessionActivities.set(s2, now - 30000);
      activeGoals.add(s1);

      mockedGetMemoryPressureSnapshot
        .mockResolvedValueOnce({
          availableMemoryBytes: 500 * 1024 * 1024,
          effectiveMemoryLimitBytes: 32 * 1024 * 1024 * 1024,
        })
        .mockResolvedValueOnce({
          availableMemoryBytes: 500 * 1024 * 1024,
          effectiveMemoryLimitBytes: 32 * 1024 * 1024 * 1024,
        })
        .mockResolvedValueOnce({
          availableMemoryBytes: 2 * 1024 * 1024 * 1024,
          effectiveMemoryLimitBytes: 32 * 1024 * 1024 * 1024,
        });

      await manager.evictForMemoryPressure();

      expect(cleanMock).toHaveBeenCalledTimes(1);
      expect(cleanMock).toHaveBeenCalledWith(s2);
    });

    it('returns stillUnderPressure when nothing eligible can be evicted', async () => {
      const manager = createManager();
      const s1 = 'session-1' as SessionId;

      sessionActivities.set(s1, Date.now() - 60000);
      pendingUserWork.add(s1);
      mockedGetMemoryPressureSnapshot.mockResolvedValue({
        availableMemoryBytes: 500 * 1024 * 1024,
        effectiveMemoryLimitBytes: 32 * 1024 * 1024 * 1024,
      });

      const result = await manager.evictForMemoryPressure();

      expect(cleanMock).not.toHaveBeenCalled();
      expect(result.stillUnderPressure).toBe(true);
      expect(result.evictedSessionIds).toEqual([]);
      expect(result.hadMemoryPressure).toBe(true);
    });

    it('reclaims but does not refuse when the windows page file can still grow', async () => {
      // The default system-managed page file: commit sits right under the CURRENT limit, which
      // Windows simply raises. Refusing here is the false positive this branch exists to prevent.
      const manager = createManager(undefined, 'win32');
      mockedGetMemoryPressureSnapshot.mockResolvedValue({
        availableMemoryBytes: 4 * 1024 * 1024 * 1024,
        effectiveMemoryLimitBytes: 32 * 1024 * 1024 * 1024,
        availableCommitBytes: 256 * 1024 * 1024,
        commitLimitBytes: 40 * 1024 * 1024 * 1024,
        committedBytes: 39.75 * 1024 * 1024 * 1024,
        commitGrowthBytes: 60 * 1024 * 1024 * 1024,
        effectiveAvailableCommitBytes: 60.25 * 1024 * 1024 * 1024,
      });

      const result = await manager.evictForMemoryPressure();

      expect(result.hadMemoryPressure).toBe(true);
      expect(result.stillUnderPressure).toBe(false);
      expect(result.pressureReason).toBe('commit');
      expect(result.commitThresholdBytes).toBe(1024 * 1024 * 1024);
      expect(result.commitGrowthBytes).toBe(60 * 1024 * 1024 * 1024);
    });

    it('refuses on windows once the commit limit can no longer grow', async () => {
      const manager = createManager(undefined, 'win32');
      mockedGetMemoryPressureSnapshot.mockResolvedValue({
        availableMemoryBytes: 4 * 1024 * 1024 * 1024,
        effectiveMemoryLimitBytes: 32 * 1024 * 1024 * 1024,
        availableCommitBytes: 256 * 1024 * 1024,
        commitLimitBytes: 40 * 1024 * 1024 * 1024,
        committedBytes: 39.75 * 1024 * 1024 * 1024,
        commitGrowthBytes: 0,
        effectiveAvailableCommitBytes: 256 * 1024 * 1024,
      });

      const result = await manager.evictForMemoryPressure();

      expect(cleanMock).not.toHaveBeenCalled();
      expect(result.hadMemoryPressure).toBe(true);
      expect(result.stillUnderPressure).toBe(true);
      expect(result.pressureReason).toBe('commit');
      expect(result.commitThresholdBytes).toBe(1024 * 1024 * 1024);
    });

    it('evicts idle sessions to recover commit headroom on windows', async () => {
      const manager = createManager(undefined, 'win32');
      const s1 = 'session-1' as SessionId;
      sessionActivities.set(s1, Date.now() - 60000);

      const exhausted = {
        availableMemoryBytes: 4 * 1024 * 1024 * 1024,
        effectiveMemoryLimitBytes: 32 * 1024 * 1024 * 1024,
        availableCommitBytes: 256 * 1024 * 1024,
        commitLimitBytes: 40 * 1024 * 1024 * 1024,
        committedBytes: 39.75 * 1024 * 1024 * 1024,
        commitGrowthBytes: 0,
        effectiveAvailableCommitBytes: 256 * 1024 * 1024,
      };
      mockedGetMemoryPressureSnapshot
        .mockResolvedValueOnce(exhausted)
        .mockResolvedValueOnce(exhausted)
        .mockResolvedValueOnce({
          availableMemoryBytes: 4 * 1024 * 1024 * 1024,
          effectiveMemoryLimitBytes: 32 * 1024 * 1024 * 1024,
          availableCommitBytes: 2 * 1024 * 1024 * 1024,
          commitLimitBytes: 40 * 1024 * 1024 * 1024,
          committedBytes: 38 * 1024 * 1024 * 1024,
          commitGrowthBytes: 0,
          effectiveAvailableCommitBytes: 2 * 1024 * 1024 * 1024,
        });

      const result = await manager.evictForMemoryPressure();

      expect(cleanMock).toHaveBeenCalledTimes(1);
      expect(cleanMock).toHaveBeenCalledWith(s1);
      expect(result.evictedSessionIds).toEqual([s1]);
      expect(result.stillUnderPressure).toBe(false);
      expect(result.pressureReason).toBeNull();
    });
  });

  describe('evaluateMemoryPressure', () => {
    const GB = 1024 * 1024 * 1024;
    const thresholds = (platform: NodeJS.Platform) => ({
      platform,
      thresholdBytes: 1 * GB,
      commitThresholdBytes: 1 * GB,
      psiStallAvg10: 10,
      cgroupHardFloorBytes: 128 * 1024 * 1024,
    });

    describe('darwin', () => {
      // The byte figures below are deliberately "under pressure" by the Linux rule, to prove the
      // kernel level is the only input on macOS.
      const starvedBytes = {
        availableMemoryBytes: 100 * 1024 * 1024,
        effectiveMemoryLimitBytes: 32 * GB,
      };

      it('fails open when the kernel level is unavailable', () => {
        // Must NOT fall back to the byte thresholds: they misreport pressure on healthy Macs.
        expect(evaluateMemoryPressure(starvedBytes, thresholds('darwin'))).toEqual({
          evict: false,
          block: false,
          reason: null,
        });
      });
    });

    describe('linux under a cgroup limit', () => {
      // 10% of the 26GiB limit, i.e. the margin the reported incident actually used.
      const cgroupThresholds = { ...thresholds('linux'), thresholdBytes: 2.6 * GB };

      // The reported incident, to scale: memory.high 24GiB, memory.max 26GiB, current 24GiB,
      // of which ~19GiB is page cache and resident process memory is only ~3.8GiB. No OOM
      // happened, and usage fell back to 16.7GiB on its own once the scan stopped.
      const scanning = (over: Partial<{ psi: number | null; inactiveFile: number }> = {}) => ({
        availableMemoryBytes: 2 * GB,
        effectiveMemoryLimitBytes: 26 * GB,
        hostAvailableBytes: 20 * GB,
        cgroup: {
          path: '/sys/fs/cgroup/user.slice',
          maxBytes: 26 * GB,
          highBytes: 24 * GB,
          currentBytes: 24 * GB,
          hardHeadroomBytes: 2 * GB,
          reclaimableBytes: over.inactiveFile ?? 6 * GB,
          stat: {
            inactiveFileBytes: over.inactiveFile ?? 6 * GB,
            activeFileBytes: 13 * GB,
            slabReclaimableBytes: 0,
            dirtyBytes: 0,
          },
          psiSomeAvg10: over.psi === undefined ? 0 : over.psi,
          events: { high: 0, max: 0 },
        },
      });

      it('does not act when reclaimable cache covers the margin and nothing is stalling', () => {
        // 2GiB unused + 6GiB reclaimable clears the 1GiB margin. The old
        // `memory.max - memory.current` view saw only 2GiB and refused the turn.
        expect(evaluateMemoryPressure(scanning(), cgroupThresholds)).toEqual({
          evict: false,
          block: false,
          reason: null,
        });
      });

      it('reclaims but does not refuse when headroom is low without a stall', () => {
        // Even with almost no reclaimable cache credited, a cgroup that is not stalling must not
        // fail a user's turn: the estimate excludes active_file and is known to under-count.
        expect(evaluateMemoryPressure(scanning({ inactiveFile: 0 }), cgroupThresholds)).toEqual({
          evict: true,
          block: false,
          reason: 'cgroup_low_headroom',
        });
      });

      it('refuses only when low headroom coincides with a real PSI stall', () => {
        expect(
          evaluateMemoryPressure(scanning({ inactiveFile: 0, psi: 42.5 }), cgroupThresholds)
        ).toEqual({ evict: true, block: true, reason: 'cgroup_stalled' });
      });

      it('ignores a PSI stall while headroom is still comfortable', () => {
        expect(evaluateMemoryPressure(scanning({ psi: 42.5 }), cgroupThresholds)).toEqual({
          evict: false,
          block: false,
          reason: null,
        });
      });

      it('falls back to a hard-headroom floor when the kernel has no PSI', () => {
        const noPsi = scanning({ inactiveFile: 0, psi: null });
        expect(evaluateMemoryPressure(noPsi, cgroupThresholds)).toEqual({
          evict: true,
          block: false,
          reason: 'cgroup_low_headroom',
        });

        const starved = {
          ...noPsi,
          cgroup: { ...noPsi.cgroup, hardHeadroomBytes: 64 * 1024 * 1024 },
        };
        expect(evaluateMemoryPressure(starved, cgroupThresholds)).toEqual({
          evict: true,
          block: true,
          reason: 'cgroup_stalled',
        });
      });

      it('still refuses when the host itself is out of memory', () => {
        // MemAvailable already credits reclaimable cache, so a low host number is trustworthy
        // on its own and does not need stall corroboration.
        const hostStarved = { ...scanning(), hostAvailableBytes: 100 * 1024 * 1024 };
        expect(evaluateMemoryPressure(hostStarved, cgroupThresholds)).toEqual({
          evict: true,
          block: true,
          reason: 'physical',
        });
      });
    });

    describe('win32', () => {
      // A machine with the DEFAULT system-managed page file: commit charge is right up against
      // the current limit, and the current limit is not where the machine ends.
      const growable = {
        availableMemoryBytes: 4 * GB,
        effectiveMemoryLimitBytes: 32 * GB,
        availableCommitBytes: 100 * 1024 * 1024,
        commitLimitBytes: 40 * GB,
        committedBytes: 40 * GB - 100 * 1024 * 1024,
        commitGrowthBytes: 60 * GB,
        effectiveAvailableCommitBytes: 60 * GB + 100 * 1024 * 1024,
      };

      it('never refuses on physical availability alone', () => {
        // Windows trims working sets and leans on the standby list rather than failing. Low
        // `AvailableBytes` is worth reclaiming idle sessions over, never worth failing a turn.
        expect(
          evaluateMemoryPressure(
            { availableMemoryBytes: 500 * 1024 * 1024, effectiveMemoryLimitBytes: 32 * GB },
            thresholds('win32')
          )
        ).toEqual({ evict: true, block: false, reason: 'physical' });
      });

      it('fails open when the probe returned nothing at all', () => {
        // A `powershell.exe` timeout must not become a refused turn.
        expect(
          evaluateMemoryPressure(
            { availableMemoryBytes: 4 * GB, effectiveMemoryLimitBytes: 32 * GB },
            thresholds('win32')
          )
        ).toEqual({ evict: false, block: false, reason: null });
      });

      it('reclaims but does not refuse when page file growth is undetermined', () => {
        // Commit headroom read fine, but the page file or its volume did not. Undetermined is
        // not the same as zero: without positive evidence that the limit is stuck, refusing
        // would be the original bug wearing a different hat.
        const { commitGrowthBytes, effectiveAvailableCommitBytes, ...undetermined } = growable;
        expect(commitGrowthBytes).toBeDefined();
        expect(effectiveAvailableCommitBytes).toBeDefined();
        expect(evaluateMemoryPressure(undetermined, thresholds('win32'))).toEqual({
          evict: true,
          block: false,
          reason: 'commit',
        });
      });
    });
  });

  describe('evictForMemoryPressure staleness handling', () => {
    const underPressure = {
      availableMemoryBytes: 500 * 1024 * 1024,
      effectiveMemoryLimitBytes: 32 * 1024 * 1024 * 1024,
    };
    const relieved = {
      availableMemoryBytes: 4 * 1024 * 1024 * 1024,
      effectiveMemoryLimitBytes: 32 * 1024 * 1024 * 1024,
    };

    it('never acts on the cached sample once it looks like pressure', async () => {
      const getLatest = vi.fn().mockResolvedValue(underPressure);
      const refresh = vi.fn().mockResolvedValue(relieved);
      const manager = createManager();
      // Replace the source so getLatest and refresh are distinguishable.
      (manager as any).deps.memoryPressure = { getLatest, refresh };

      const result = await manager.evictForMemoryPressure();

      expect(getLatest).toHaveBeenCalledTimes(1);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(result.stillUnderPressure).toBe(false);
      expect(cleanMock).not.toHaveBeenCalled();
    });

    it('rechecks with a delay before failing a turn, and clears if cache came back', async () => {
      const getLatest = vi.fn().mockResolvedValue(underPressure);
      const refresh = vi
        .fn()
        .mockResolvedValueOnce(underPressure) // forced refresh
        .mockResolvedValue(relieved); // first recheck: the kernel handed the cache back
      const manager = createManager({ pressureRecheckAttempts: 2, pressureRecheckDelayMs: 500 });
      (manager as any).deps.memoryPressure = { getLatest, refresh };

      const result = await manager.evictForMemoryPressure();

      expect(sleepCalls).toEqual([500]);
      expect(result.stillUnderPressure).toBe(false);
    });
  });

  describe('evictForMemoryPressure on darwin', () => {
    const idleSessions = (count: number) => {
      const now = Date.now();
      for (let i = 0; i < count; i++) {
        // Descending idle time so eviction order is deterministic: session-0 is the stalest.
        sessionActivities.set(`session-${i}` as SessionId, now - (count - i) * 60_000);
      }
    };

    it('reclaims idle sessions at WARNING without failing the turn', async () => {
      const manager = createManager({ maxEvictionsPerCall: 100 }, 'darwin');
      idleSessions(2);
      mockedGetMemoryPressureSnapshot.mockResolvedValue({
        availableMemoryBytes: 100 * 1024 * 1024,
        effectiveMemoryLimitBytes: 32 * 1024 * 1024 * 1024,
        memoryPressureLevel: 2,
      });

      const result = await manager.evictForMemoryPressure();

      expect(cleanMock).toHaveBeenCalledTimes(2);
      expect(result.hadMemoryPressure).toBe(true);
      expect(result.stillUnderPressure).toBe(false);
      expect(result.pressureReason).toBe('darwin_pressure_warning');
    });

    it('fails the turn at CRITICAL', async () => {
      const manager = createManager({}, 'darwin');
      mockedGetMemoryPressureSnapshot.mockResolvedValue({
        availableMemoryBytes: 100 * 1024 * 1024,
        effectiveMemoryLimitBytes: 32 * 1024 * 1024 * 1024,
        memoryPressureLevel: 4,
      });

      const result = await manager.evictForMemoryPressure();

      expect(result.stillUnderPressure).toBe(true);
      expect(result.pressureReason).toBe('darwin_pressure_critical');
      expect(result.memoryPressureLevel).toBe(4);
    });

    it('does not act on low available bytes when the kernel reports NORMAL', async () => {
      const manager = createManager({}, 'darwin');
      idleSessions(2);
      mockedGetMemoryPressureSnapshot.mockResolvedValue({
        // Well under memoryThresholdBytes — the old heuristic would have evicted and blocked here.
        availableMemoryBytes: 100 * 1024 * 1024,
        effectiveMemoryLimitBytes: 32 * 1024 * 1024 * 1024,
        memoryPressureLevel: 1,
      });

      const result = await manager.evictForMemoryPressure();

      expect(cleanMock).not.toHaveBeenCalled();
      expect(result.hadMemoryPressure).toBe(false);
      expect(result.stillUnderPressure).toBe(false);
    });

    it('bounds evictions per call so a turn start is not stalled', async () => {
      const manager = createManager({ maxEvictionsPerCall: 3 }, 'darwin');
      idleSessions(10);
      mockedGetMemoryPressureSnapshot.mockResolvedValue({
        availableMemoryBytes: 100 * 1024 * 1024,
        effectiveMemoryLimitBytes: 32 * 1024 * 1024 * 1024,
        memoryPressureLevel: 2,
      });

      await manager.evictForMemoryPressure();

      expect(cleanMock).toHaveBeenCalledTimes(3);
      expect(cleanMock.mock.calls.map(([id]) => id)).toEqual([
        'session-0',
        'session-1',
        'session-2',
      ]);
    });
  });
});
