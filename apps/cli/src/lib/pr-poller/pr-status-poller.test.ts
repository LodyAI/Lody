import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';
import type { MachineId, SessionId, SessionMeta } from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { loadPrPollerConfig } from './pr-poller-config';
import type { PrPollQueryOutcome } from './github-graphql-client';
import { emptyPrPollerState, type PrPollerStateStore } from './pr-poller-state';
import { layerPrStatusPoller, makePrStatusPoller, PrStatusPoller } from './pr-status-poller';
import type { PrPollerWorkspaceHandle } from './pr-poller-workspace';

function createTestLogger(): Logger {
  const logger: Logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    debug: vi.fn(),
    setLevel: vi.fn(),
    setDebug: vi.fn(),
    child: vi.fn(() => logger),
    close: vi.fn(async () => {}),
  };
  return logger;
}

function makeFakeStateStore(): PrPollerStateStore {
  const stored = emptyPrPollerState();
  return {
    dbPath: '/fake/pr-poller-state.sqlite3',
    load: vi.fn(() => stored),
    upsertScope: vi.fn(),
    upsertRepoCooldown: vi.fn(),
    deleteRepoCooldown: vi.fn(),
    upsertTarget: vi.fn(),
    deleteTarget: vi.fn(),
    upsertDiscoveryFingerprint: vi.fn(),
    deleteDiscoveryFingerprint: vi.fn(),
    upsertTerminalVerificationFingerprint: vi.fn(),
    deleteTerminalVerificationFingerprint: vi.fn(),
    close: vi.fn(),
  } as unknown as PrPollerStateStore;
}

const NO_OUTCOME: PrPollQueryOutcome = { kind: 'network-error', message: 'unset' };

function makeDeps(overrides: Partial<ReturnType<typeof loadPrPollerConfig>> = {}) {
  const logger = createTestLogger();
  const config = { ...loadPrPollerConfig({}), ...overrides };
  const stateStore = makeFakeStateStore();
  const client = { executeBatch: vi.fn(async (): Promise<PrPollQueryOutcome> => NO_OUTCOME) };
  return { logger, config, stateStore, client };
}

function makeWorkspaceHandle(workspaceId: string): PrPollerWorkspaceHandle {
  return {
    workspaceId,
    machineId: 'machine-1' as MachineId,
    listAliveSessionMetas: async () => [
      {
        sessionId: 's1' as SessionId,
        meta: {
          userId: 'user-1',
          machineId: 'machine-1' as MachineId,
          pullRequests: [{ url: 'https://github.com/owner/repo/pull/1', status: 'open' }],
        } as SessionMeta,
      },
    ],
    readOwnerMeta: async () => undefined,
    writeOwnerMeta: async () => {},
    watchSessionMetadata: () => () => {},
    subscribePresence: () => () => {},
    getPresenceStates: () => ({}),
    waitForInitialSync: async () => true,
    resolveCredential: async () => ({
      token: 'token-1',
      source: 'managed',
      credentialScope: 'managed:scope-1',
    }),
    invalidateCredential: () => {},
    associatePullRequest: async () => false,
    dispose: async () => {},
  };
}

async function runWithPoller<A>(
  deps: ReturnType<typeof makeDeps>,
  program: (poller: PrStatusPoller['Type']) => Effect.Effect<A>
): Promise<A> {
  return await Effect.runPromise(
    Effect.gen(function* () {
      const poller = yield* PrStatusPoller;
      return yield* program(poller);
    }).pipe(Effect.provide(layerPrStatusPoller(deps)))
  );
}

describe('PrStatusPoller lifecycle', () => {
  it('starts and stops', async () => {
    const deps = makeDeps();
    const [startedAfterStart, startedAfterStop] = await runWithPoller(deps, (poller) =>
      Effect.gen(function* () {
        yield* poller.start;
        const afterStart = yield* poller.isStarted;
        yield* poller.stop;
        const afterStop = yield* poller.isStarted;
        return [afterStart, afterStop] as const;
      })
    );

    expect(startedAfterStart).toBe(true);
    expect(startedAfterStop).toBe(false);
  });

  it('start is idempotent', async () => {
    const deps = makeDeps();
    await runWithPoller(deps, (poller) =>
      Effect.gen(function* () {
        yield* poller.start;
        yield* poller.start;
        expect(yield* poller.isStarted).toBe(true);
        yield* poller.stop;
      })
    );
  });

  it('a disabled poller (LODY_PR_POLL_DISABLED=1) never enters the started state', async () => {
    const deps = makeDeps({ enabled: false });
    const started = await runWithPoller(deps, (poller) =>
      Effect.gen(function* () {
        yield* poller.start;
        return yield* poller.isStarted;
      })
    );

    expect(started).toBe(false);
  });

  it('stop on a never-started poller is a no-op', async () => {
    const deps = makeDeps();
    await expect(runWithPoller(deps, (poller) => poller.stop)).resolves.toBeUndefined();
  });

  it('exposes config and state store for the fleet wiring', async () => {
    const deps = makeDeps();
    await runWithPoller(deps, (poller) =>
      Effect.sync(() => {
        expect(poller.config).toBe(deps.config);
        expect(poller.stateStore).toBe(deps.stateStore);
      })
    );
  });
});

describe('PrStatusPoller scheduler wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('an enabled, started poller polls registered workspaces', async () => {
    const deps = makeDeps();
    const poller = makePrStatusPoller(deps);
    await Effect.runPromise(poller.start);
    poller.registerWorkspace(makeWorkspaceHandle('ws1'));

    await vi.advanceTimersByTimeAsync(10);
    expect(deps.client.executeBatch).toHaveBeenCalled();

    await Effect.runPromise(poller.stop);
  });

  it('the disabled kill switch: registerWorkspace is a no-op, nothing is ever polled', async () => {
    const deps = makeDeps({ enabled: false });
    const poller = makePrStatusPoller(deps);
    await Effect.runPromise(poller.start);
    poller.registerWorkspace(makeWorkspaceHandle('ws1'));

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(deps.client.executeBatch).not.toHaveBeenCalled();
  });

  it('registerWorkspace before start is dropped (service never started)', async () => {
    const deps = makeDeps();
    const poller = makePrStatusPoller(deps);
    poller.registerWorkspace(makeWorkspaceHandle('ws1'));

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(deps.client.executeBatch).not.toHaveBeenCalled();
  });

  it('exposes scheduler counters for observability', async () => {
    const deps = makeDeps();
    const poller = makePrStatusPoller(deps);
    expect(poller.counters()).toEqual({
      calls: 0,
      pointsSpent: 0,
      corrections: 0,
      discoveries: 0,
      skips: 0,
    });
  });
});
