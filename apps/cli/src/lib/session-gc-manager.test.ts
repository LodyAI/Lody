import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { SessionId } from '@lody/shared';
import {
  SessionGCManager,
  SessionGCConfig,
  loadGCConfig,
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
  let cleanMock: ReturnType<typeof vi.fn>;
  let loggerMock: {
    info: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  let sessionActivities: Map<SessionId, number>;
  let activeTurns: Set<SessionId>;
  let activeGoals: Set<SessionId>;
  let backgroundWork: ReturnType<typeof vi.fn>;
  let pendingUpdates: Set<SessionId>;
  let pendingUserWork: Set<SessionId>;
  let pendingUserWorkRead: ReturnType<typeof vi.fn>;
  let archiveInFlight: Set<SessionId>;
  let sleepCalls: number[];

  beforeEach(() => {
    vi.useFakeTimers();
    sleepCalls = [];
    cleanMock = vi.fn().mockResolvedValue(true);
    loggerMock = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    sessionActivities = new Map();
    activeTurns = new Set();
    activeGoals = new Set();
    backgroundWork = vi.fn(async () => false);
    pendingUpdates = new Set();
    pendingUserWork = new Set();
    pendingUserWorkRead = vi.fn(async (id: SessionId) => pendingUserWork.has(id));
    archiveInFlight = new Set();
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
    platform: NodeJS.Platform = 'linux'
  ) => {
    const defaultConfig: SessionGCConfig = {
      idleTimeoutMs: 20 * 60 * 1000, // 20 minutes
      sweepIntervalMs: 60 * 1000, // 1 minute
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
        hasActiveTurn: (sessionId) => activeTurns.has(sessionId),
        hasProtectedWork: async (sessionId) =>
          activeGoals.has(sessionId) || (await backgroundWork(sessionId)),
        hasPendingUpdates: (sessionId) => pendingUpdates.has(sessionId),
        hasPendingUserWork: pendingUserWorkRead,
        isArchiveInFlight: (sessionId) => archiveInFlight.has(sessionId),
        captureCleanupGuard: () => () => true,
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
      },
      platform
    );
  };

  it.each(['idle', 'pressure'] as const)(
    'rechecks active work after the final %s metadata await',
    async (mode) => {
      const id = 'last-await' as SessionId;
      sessionActivities.set(id, Date.now() - 60000);
      pendingUserWorkRead.mockImplementation(async () => {
        activeTurns.add(id);
        return false;
      });
      mockedGetMemoryPressureSnapshot.mockResolvedValue({
        availableMemoryBytes: 1,
        effectiveMemoryLimitBytes: 32 * 1024 ** 3,
      });
      const manager = createManager({ idleTimeoutMs: 1000 });
      if (mode === 'idle') await manager.sweep();
      else expect((await manager.evictForMemoryPressure()).evictedSessionIds).toEqual([]);
      expect(cleanMock).not.toHaveBeenCalled();
    }
  );

  it('does not count a cleanup guard refusal as a pressure eviction', async () => {
    sessionActivities.set('refused' as SessionId, Date.now() - 60000);
    cleanMock.mockResolvedValue(false);
    mockedGetMemoryPressureSnapshot.mockResolvedValue({
      availableMemoryBytes: 1,
      effectiveMemoryLimitBytes: 32 * 1024 ** 3,
    });
    const result = await createManager().evictForMemoryPressure();
    expect(cleanMock).toHaveBeenCalledOnce();
    expect(result.evictedSessionIds).toEqual([]);
  });

  it.each(['capture', 'metadata'] as const)(
    'isolates %s inspection failure to one session',
    async (failure) => {
      const broken = 'broken-read' as SessionId;
      const healthy = 'healthy-read' as SessionId;
      sessionActivities.set(broken, Date.now() - 60000);
      sessionActivities.set(healthy, Date.now() - 60000);
      const manager = createManager({ idleTimeoutMs: 1000 });
      if (failure === 'capture') {
        (manager as any).deps.captureCleanupGuard = (id: SessionId) => {
          if (id === broken) throw new Error('destroyed');
          return () => true;
        };
      } else {
        pendingUserWorkRead.mockImplementation(async (id) => {
          if (id === broken) throw new Error('unreadable metadata');
          return false;
        });
      }
      await manager.sweep();
      expect(cleanMock.mock.calls.map(([id]) => id)).toEqual([healthy]);
    }
  );

  describe('background task eviction guard', () => {
    it.each(['idle', 'pressure'] as const)(
      'protects running tasks during %s eviction',
      async (mode) => {
        const manager = createManager({ idleTimeoutMs: 1000 });
        const id = 'background' as SessionId;
        sessionActivities.set(id, Date.now() - 60000);
        backgroundWork.mockResolvedValue(true);
        mockedGetMemoryPressureSnapshot.mockResolvedValue({
          availableMemoryBytes: 500 * 1024 * 1024,
          effectiveMemoryLimitBytes: 32 * 1024 ** 3,
        });
        if (mode === 'idle') await manager.sweep();
        else await manager.evictForMemoryPressure();
        expect(cleanMock).not.toHaveBeenCalled();
      }
    );

    it('allows cleanup once background work completes', async () => {
      const manager = createManager({ idleTimeoutMs: 1000 });
      const id = 'background' as SessionId;
      sessionActivities.set(id, Date.now() - 60000);
      backgroundWork.mockResolvedValue(true);
      await manager.sweep();
      backgroundWork.mockResolvedValue(false);
      await manager.sweep();
      expect(cleanMock).toHaveBeenCalledWith(id, expect.any(Function));
    });

    it('rechecks background work before cleanup', async () => {
      const manager = createManager({ idleTimeoutMs: 1000 });
      sessionActivities.set('background' as SessionId, Date.now() - 60000);
      backgroundWork.mockResolvedValueOnce(false).mockResolvedValue(true);
      await manager.sweep();
      expect(cleanMock).not.toHaveBeenCalled();
    });

    it.each(['idle', 'pressure', 'periodic'] as const)(
      'protects unreadable history while continuing %s cleanup for other sessions',
      async (mode) => {
        const manager = createManager({ idleTimeoutMs: 1000, sweepIntervalMs: 500 });
        const unreadable = 'unreadable' as SessionId;
        const eligible = 'eligible' as SessionId;
        sessionActivities.set(unreadable, Date.now() - 60000);
        sessionActivities.set(eligible, Date.now() - 60000);
        backgroundWork.mockImplementation(async (sessionId) => {
          if (sessionId === unreadable) throw new Error('history unavailable');
          return false;
        });
        mockedGetMemoryPressureSnapshot.mockResolvedValue({
          availableMemoryBytes: 500 * 1024 * 1024,
          effectiveMemoryLimitBytes: 32 * 1024 ** 3,
        });
        try {
          if (mode === 'idle') await manager.sweep();
          else if (mode === 'pressure') await manager.evictForMemoryPressure();
          else {
            manager.start();
            await vi.advanceTimersByTimeAsync(600);
          }
          expect(cleanMock).toHaveBeenCalledTimes(1);
          expect(cleanMock).toHaveBeenCalledWith(eligible, expect.any(Function));
          expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining('unreadable'));
        } finally {
          manager.stop();
        }
      }
    );
  });
  describe('loadGCConfig', () => {
    it('returns default config with 20 minute timeout', () => {
      const config = loadGCConfig();
      expect(config.idleTimeoutMs).toBe(20 * 60 * 1000);
      expect(config.sweepIntervalMs).toBe(60 * 1000);
      expect(config.enabled).toBe(true);
      // Default threshold = 10% of effective memory (32 GB mock), clamped to [1 GB, 4 GB]
      // = floor(32 * 1024^3 * 0.1) = 3,435,973,836 bytes (~3.2 GB)
      expect(config.memoryThresholdBytes).toBe(Math.floor(32 * 1024 * 1024 * 1024 * 0.1));
      // Eviction runs on the prompt hot path, so a single turn start can only pay for a few.
      expect(config.maxEvictionsPerCall).toBe(3);
      // Only the about-to-fail path pays this, so 2 x 500ms is cheap insurance against
      // refusing a turn on a sample taken mid-burst.
      expect(config.pressureRecheckAttempts).toBe(2);
      expect(config.pressureRecheckDelayMs).toBe(500);
    });

    it('reads env vars', () => {
      const original = {
        timeout: process.env.LODY_SESSION_GC_IDLE_TIMEOUT_MS,
        threshold: process.env.LODY_SESSION_GC_MEMORY_THRESHOLD_BYTES,
      };
      process.env.LODY_SESSION_GC_IDLE_TIMEOUT_MS = '300000';
      process.env.LODY_SESSION_GC_MEMORY_THRESHOLD_BYTES = '536870912';
      try {
        const config = loadGCConfig();
        expect(config.idleTimeoutMs).toBe(300000);
        expect(config.memoryThresholdBytes).toBe(536870912);
      } finally {
        if (original.timeout === undefined) delete process.env.LODY_SESSION_GC_IDLE_TIMEOUT_MS;
        else process.env.LODY_SESSION_GC_IDLE_TIMEOUT_MS = original.timeout;
        if (original.threshold === undefined)
          delete process.env.LODY_SESSION_GC_MEMORY_THRESHOLD_BYTES;
        else process.env.LODY_SESSION_GC_MEMORY_THRESHOLD_BYTES = original.threshold;
      }
    });
  });

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
      expect(cleanMock).toHaveBeenCalledWith(s1, expect.any(Function));
    });

    it('does not clean sessions with pending updates', async () => {
      const manager = createManager({ idleTimeoutMs: 1000 });
      const now = Date.now();
      const s1 = 'session-1' as SessionId;

      sessionActivities.set(s1, now - 2000);
      pendingUpdates.add(s1);

      await manager.sweep();

      expect(cleanMock).not.toHaveBeenCalled();
    });

    it('does not clean sessions with pending user work', async () => {
      const manager = createManager({ idleTimeoutMs: 1000 });
      const now = Date.now();
      const s1 = 'session-1' as SessionId;

      sessionActivities.set(s1, now - 2000);
      pendingUserWork.add(s1);

      await manager.sweep();

      expect(cleanMock).not.toHaveBeenCalled();
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

    it('does not clean sessions with active goals', async () => {
      const manager = createManager({ idleTimeoutMs: 1000 });
      const now = Date.now();
      const s1 = 'session-1' as SessionId;

      sessionActivities.set(s1, now - 2000);
      activeGoals.add(s1);

      await manager.sweep();

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

    it('cleans longest-idle first', async () => {
      const manager = createManager({ idleTimeoutMs: 1000 });
      const now = Date.now();
      const s1 = 'session-1' as SessionId;
      const s2 = 'session-2' as SessionId;
      const s3 = 'session-3' as SessionId;

      sessionActivities.set(s1, now - 3000); // 3s idle
      sessionActivities.set(s2, now - 5000); // 5s idle
      sessionActivities.set(s3, now - 2000); // 2s idle

      await manager.sweep();

      expect(cleanMock).toHaveBeenCalledTimes(3);
      // Verify order: longest idle first
      expect(cleanMock.mock.calls[0]![0]).toBe(s2);
      expect(cleanMock.mock.calls[1]![0]).toBe(s1);
      expect(cleanMock.mock.calls[2]![0]).toBe(s3);
    });

    it('skips sessions that became active between candidate selection and cleanup', async () => {
      const manager = createManager({ idleTimeoutMs: 1000 });
      const now = Date.now();
      const s1 = 'session-1' as SessionId;

      sessionActivities.set(s1, now - 2000);

      // Simulate the session becoming active during cleanup
      cleanMock.mockImplementationOnce(async () => {
        sessionActivities.set(s1, Date.now()); // touch the session
        return true;
      });

      await manager.sweep();

      // It was called because it was eligible at candidate selection time
      expect(cleanMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('evictForMemoryPressure', () => {
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

    it('evicts longest-idle session when memory is below threshold', async () => {
      const manager = createManager();
      const now = Date.now();
      const s1 = 'session-1' as SessionId;
      const s2 = 'session-2' as SessionId;

      sessionActivities.set(s1, now - 60000); // 60s idle
      sessionActivities.set(s2, now - 30000); // 30s idle

      // Start below threshold, go above after first eviction
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
      expect(cleanMock).toHaveBeenCalledWith(s1, expect.any(Function)); // longest idle first
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
      expect(cleanMock).toHaveBeenCalledWith(s2, expect.any(Function)); // s1 excluded, so s2 is evicted
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
      expect(cleanMock).toHaveBeenCalledWith(s2, expect.any(Function));
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
      expect(cleanMock).toHaveBeenCalledWith(s2, expect.any(Function));
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
      expect(cleanMock).toHaveBeenCalledWith(s2, expect.any(Function));
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
      expect(cleanMock).toHaveBeenCalledWith(s1, expect.any(Function));
      expect(result.evictedSessionIds).toEqual([s1]);
      expect(result.stillUnderPressure).toBe(false);
      expect(result.pressureReason).toBeNull();
    });

    it('does nothing when disabled', async () => {
      const manager = createManager({ enabled: false });
      const s1 = 'session-1' as SessionId;
      sessionActivities.set(s1, Date.now() - 60000);
      mockedGetMemoryPressureSnapshot.mockResolvedValue({
        availableMemoryBytes: 500 * 1024 * 1024,
        effectiveMemoryLimitBytes: 32 * 1024 * 1024 * 1024,
      });

      await manager.evictForMemoryPressure();

      expect(cleanMock).not.toHaveBeenCalled();
    });

    it('skips sessions with zero idle time', async () => {
      const manager = createManager();
      const s1 = 'session-1' as SessionId;

      // No lastActivity set → idleMs = 0
      sessionActivities.set(s1, Date.now());

      mockedGetMemoryPressureSnapshot.mockResolvedValue({
        availableMemoryBytes: 500 * 1024 * 1024,
        effectiveMemoryLimitBytes: 32 * 1024 * 1024 * 1024,
      });

      await manager.evictForMemoryPressure();

      expect(cleanMock).not.toHaveBeenCalled();
    });
  });

  describe('start/stop', () => {
    it('handles unexpected periodic sweep rejection and continues the next interval', async () => {
      const manager = createManager({ sweepIntervalMs: 500 });
      const sweep = vi
        .spyOn(manager, 'sweep')
        .mockRejectedValueOnce(new Error('unexpected sweep failure'))
        .mockResolvedValue(undefined);
      try {
        manager.start();
        await vi.advanceTimersByTimeAsync(1100);
        expect(sweep).toHaveBeenCalledTimes(2);
        expect(loggerMock.error).toHaveBeenCalledWith(
          '[GC] Sweep failed: unexpected sweep failure'
        );
      } finally {
        manager.stop();
      }
    });

    it('runs periodic sweep', async () => {
      const manager = createManager({
        idleTimeoutMs: 1000,
        sweepIntervalMs: 500,
      });
      const now = Date.now();
      const s1 = 'session-1' as SessionId;
      sessionActivities.set(s1, now - 2000);

      manager.start();

      await vi.advanceTimersByTimeAsync(600);

      expect(cleanMock).toHaveBeenCalledTimes(1);

      manager.stop();

      // Add another session
      const s2 = 'session-2' as SessionId;
      sessionActivities.set(s2, now - 2000);

      // Advance past another interval - should not sweep
      await vi.advanceTimersByTimeAsync(600);

      expect(cleanMock).toHaveBeenCalledTimes(1); // no new calls
    });

    it('does not start when disabled', () => {
      const manager = createManager({ enabled: false });
      manager.start();

      expect(loggerMock.debug).toHaveBeenCalledWith('[GC] Session GC is disabled');
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

      it('does nothing at NORMAL even when available bytes look low', () => {
        expect(
          evaluateMemoryPressure({ ...starvedBytes, memoryPressureLevel: 1 }, thresholds('darwin'))
        ).toEqual({ evict: false, block: false, reason: null });
      });

      it('reclaims but does not refuse a turn at WARNING', () => {
        expect(
          evaluateMemoryPressure({ ...starvedBytes, memoryPressureLevel: 2 }, thresholds('darwin'))
        ).toEqual({ evict: true, block: false, reason: 'darwin_pressure_warning' });
      });

      it('reclaims and refuses a turn at CRITICAL', () => {
        expect(
          evaluateMemoryPressure({ ...starvedBytes, memoryPressureLevel: 4 }, thresholds('darwin'))
        ).toEqual({ evict: true, block: true, reason: 'darwin_pressure_critical' });
      });

      it('fails open when the kernel level is unavailable', () => {
        // Must NOT fall back to the byte thresholds: they misreport pressure on healthy Macs.
        expect(evaluateMemoryPressure(starvedBytes, thresholds('darwin'))).toEqual({
          evict: false,
          block: false,
          reason: null,
        });
      });
    });

    describe('linux', () => {
      it('reclaims and refuses together below the threshold', () => {
        expect(
          evaluateMemoryPressure(
            { availableMemoryBytes: 500 * 1024 * 1024, effectiveMemoryLimitBytes: 32 * GB },
            thresholds('linux')
          )
        ).toEqual({ evict: true, block: true, reason: 'physical' });
      });

      it('does nothing above the threshold', () => {
        expect(
          evaluateMemoryPressure(
            { availableMemoryBytes: 4 * GB, effectiveMemoryLimitBytes: 32 * GB },
            thresholds('linux')
          )
        ).toEqual({ evict: false, block: false, reason: null });
      });

      it('ignores a kernel level that should never be present off macOS', () => {
        expect(
          evaluateMemoryPressure(
            {
              availableMemoryBytes: 4 * GB,
              effectiveMemoryLimitBytes: 32 * GB,
              memoryPressureLevel: 4,
            },
            thresholds('linux')
          )
        ).toEqual({ evict: false, block: false, reason: null });
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

      it('reclaims but does not refuse while the page file can still grow', () => {
        expect(evaluateMemoryPressure(growable, thresholds('win32'))).toEqual({
          evict: true,
          block: false,
          reason: 'commit',
        });
      });

      it('refuses only once the commit limit has nowhere left to go', () => {
        expect(
          evaluateMemoryPressure(
            {
              ...growable,
              commitGrowthBytes: 0,
              effectiveAvailableCommitBytes: growable.availableCommitBytes,
            },
            thresholds('win32')
          )
        ).toEqual({ evict: true, block: true, reason: 'commit' });
      });

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

      it('names both terms when physical is low and commit is exhausted', () => {
        expect(
          evaluateMemoryPressure(
            {
              ...growable,
              availableMemoryBytes: 500 * 1024 * 1024,
              commitGrowthBytes: 0,
              effectiveAvailableCommitBytes: growable.availableCommitBytes,
            },
            thresholds('win32')
          )
        ).toEqual({ evict: true, block: true, reason: 'physical_and_commit' });
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

    it('skips the forced refresh when the cached sample is already healthy', async () => {
      const getLatest = vi.fn().mockResolvedValue(relieved);
      const refresh = vi.fn().mockResolvedValue(relieved);
      const manager = createManager();
      (manager as any).deps.memoryPressure = { getLatest, refresh };

      await manager.evictForMemoryPressure();

      // The happy path must stay cheap: no extra OS probe on every turn start.
      expect(refresh).not.toHaveBeenCalled();
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

    it('gives up after the configured number of rechecks', async () => {
      const getLatest = vi.fn().mockResolvedValue(underPressure);
      const refresh = vi.fn().mockResolvedValue(underPressure);
      const manager = createManager({ pressureRecheckAttempts: 2, pressureRecheckDelayMs: 500 });
      (manager as any).deps.memoryPressure = { getLatest, refresh };

      const result = await manager.evictForMemoryPressure();

      expect(sleepCalls).toEqual([500, 500]);
      expect(result.stillUnderPressure).toBe(true);
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
