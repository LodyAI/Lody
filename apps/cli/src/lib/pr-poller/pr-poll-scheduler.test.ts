import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LodyPresenceInstanceId,
  LodyPresenceStateMap,
  MachineId,
  SessionId,
  SessionMeta,
} from '@lody/shared';
import type { Logger } from '@/utils/logger';
import type { PrPollBatchQuery } from './graphql-batch-builder';
import type { PrObservation, PrPollQueryOutcome } from './github-graphql-client';
import type { ResolvedGitHubCredential } from './github-credential-resolver';
import { loadPrPollerConfig, type PrPollerConfig } from './pr-poller-config';
import { INITIAL_SYNC_RETRY_MS, INITIAL_SYNC_WAIT_MS, PrPollScheduler } from './pr-poll-scheduler';
import {
  emptyPrPollerState,
  type PrPollerState,
  type PrPollerStateStore,
} from './pr-poller-state';
import type {
  AssociatePullRequestArgs,
  PrPollMetaPatch,
  PrPollerWorkspaceHandle,
} from './pr-poller-workspace';

const T0 = 1_720_000_000_000;
const sid = (value: string): SessionId => value as SessionId;
const LOCAL_MACHINE = 'machine-1' as MachineId;

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

function makeMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return { userId: 'user-1', machineId: LOCAL_MACHINE, ...overrides } as SessionMeta;
}

function prMeta(prNumber: number, status: PrObservation['status'] = 'open') {
  return { url: `https://github.com/owner/repo/pull/${prNumber}`, status };
}

function observation(prNumber: number, overrides: Partial<PrObservation> = {}): PrObservation {
  return {
    number: prNumber,
    url: `https://github.com/owner/repo/pull/${prNumber}`,
    status: 'open',
    headRefName: 'feat/x',
    updatedAt: '2026-07-17T00:00:00Z',
    ciState: null,
    mergeState: null,
    ...overrides,
  };
}

/** Success outcome mirroring the request: every status PR open, empty valid discoveries. */
function successOutcome(batch: PrPollBatchQuery): PrPollQueryOutcome {
  const branches = Array.from(new Set(batch.discoveryAliases.map(({ branch }) => branch)));
  return {
    kind: 'success',
    batch: {
      pullRequests: batch.statusAliases.map(({ prNumber }) => ({
        prNumber,
        pr: observation(prNumber),
        ok: true,
      })),
      discoveries: branches.map((branch) => ({ branch, prs: [], ok: true })),
      rateLimit: { cost: 1, remaining: 4999, limit: 5000, resetAtMs: null },
    },
  };
}

function viewingPresence(sessionId: SessionId, updatedAt: number): LodyPresenceStateMap {
  return {
    'viewing:user-1:instance-1': {
      kind: 'session-viewing',
      userId: 'user-1',
      instanceId: 'instance-1' as LodyPresenceInstanceId,
      sessionId,
      since: updatedAt,
      updatedAt,
    },
  };
}

class FakeWorkspace {
  readonly metas = new Map<SessionId, SessionMeta>();
  presence: LodyPresenceStateMap = {};
  initialSyncResult = true;
  credential: ResolvedGitHubCredential | null = {
    token: 'token-1',
    source: 'managed',
    credentialScope: 'managed:scope-1',
  };
  /** When set, invalidateCredential swaps this in (token rotation / scope change). */
  replacementCredential: ResolvedGitHubCredential | null = null;
  associateResult = true;

  readonly associateCalls: AssociatePullRequestArgs[] = [];
  readonly writtenPatches: Array<{ sessionId: SessionId; patch: PrPollMetaPatch }> = [];
  readonly listAliveSessionMetas = vi.fn(async () =>
    Array.from(this.metas.entries()).map(([sessionId, meta]) => ({ sessionId, meta }))
  );
  readonly readOwnerMeta = vi.fn(async (sessionId: SessionId) => this.metas.get(sessionId));
  readonly resolveCredential = vi.fn(async (_repo: string) => this.credential);
  readonly waitForInitialSync = vi.fn(async (_timeoutMs?: number) => this.initialSyncResult);
  readonly invalidateCredential = vi.fn(() => {
    if (this.replacementCredential) {
      this.credential = this.replacementCredential;
    }
  });
  private readonly presenceListeners = new Set<(states: LodyPresenceStateMap) => void>();
  private readonly metaListeners = new Set<(sessionId: SessionId) => void>();

  constructor(readonly workspaceId: string) {}

  handle(): PrPollerWorkspaceHandle {
    return {
      workspaceId: this.workspaceId,
      machineId: LOCAL_MACHINE,
      listAliveSessionMetas: this.listAliveSessionMetas,
      readOwnerMeta: this.readOwnerMeta,
      writeOwnerMeta: async (sessionId, patch) => {
        this.writtenPatches.push({ sessionId, patch });
        const current = this.metas.get(sessionId) ?? makeMeta();
        this.metas.set(sessionId, { ...current, ...patch });
        // A real workspace fires the doc-metadata watcher on writes.
        this.notifyMetaChanged(sessionId);
      },
      watchSessionMetadata: (listener) => {
        this.metaListeners.add(listener);
        return () => this.metaListeners.delete(listener);
      },
      subscribePresence: (listener) => {
        this.presenceListeners.add(listener);
        return () => this.presenceListeners.delete(listener);
      },
      getPresenceStates: () => this.presence,
      waitForInitialSync: this.waitForInitialSync,
      resolveCredential: this.resolveCredential,
      invalidateCredential: this.invalidateCredential,
      associatePullRequest: async (args) => {
        this.associateCalls.push(args);
        return this.associateResult;
      },
      dispose: async () => {},
    };
  }

  setPresence(states: LodyPresenceStateMap): void {
    this.presence = states;
    for (const listener of this.presenceListeners) {
      listener(states);
    }
  }

  notifyMetaChanged(sessionId: SessionId): void {
    for (const listener of this.metaListeners) {
      listener(sessionId);
    }
  }

  presenceListenerCount(): number {
    return this.presenceListeners.size;
  }
}

/** Write-through fake mirroring the SQLite store interface. */
function makeStateStore(initial?: PrPollerState) {
  const stored = initial ?? emptyPrPollerState();
  const store = {
    dbPath: '/fake/pr-poller-state.sqlite3',
    load: vi.fn(() => structuredClone(stored)),
    upsertScope: vi.fn((scope: string, quota: PrPollerState['scopes'][string]) => {
      stored.scopes[scope] = quota;
    }),
    upsertRepoCooldown: vi.fn(
      (key: string, cooldown: PrPollerState['repoCooldowns'][string]) => {
        stored.repoCooldowns[key] = cooldown;
      }
    ),
    deleteRepoCooldown: vi.fn((key: string) => {
      delete stored.repoCooldowns[key];
    }),
    upsertTarget: vi.fn((key: string, target: PrPollerState['targets'][string]) => {
      stored.targets[key] = target;
    }),
    deleteTarget: vi.fn((key: string) => {
      delete stored.targets[key];
    }),
    upsertDiscoveryFingerprint: vi.fn((key: string, fingerprint: string) => {
      stored.discoveryFingerprints[key] = fingerprint;
    }),
    deleteDiscoveryFingerprint: vi.fn((key: string) => {
      delete stored.discoveryFingerprints[key];
    }),
    close: vi.fn(),
  } as unknown as PrPollerStateStore;
  return { store, getStored: () => stored };
}

const config: PrPollerConfig = loadPrPollerConfig({});

describe('PrPollScheduler', () => {
  let now: number;
  let scheduler: PrPollScheduler;
  let client: { executeBatch: ReturnType<typeof vi.fn> };
  let clientHandler: (batch: PrPollBatchQuery, token: string) => Promise<PrPollQueryOutcome>;
  let stateStore: ReturnType<typeof makeStateStore>;
  let logger: Logger;

  /**
   * Advances in 1s steps so the manual `now` never runs far ahead of the fake
   * timer clock. One big jump lets callbacks mid-window see `now` at the
   * window END: timer delays computed against that future `now` then fire too
   * early on the fake clock, which both busy-loops wake timers (multi-second
   * real-time tests) and makes boundary assertions flaky under load.
   */
  async function advance(ms: number): Promise<void> {
    const stepMs = 1_000;
    for (let elapsed = 0; elapsed < ms; elapsed += stepMs) {
      const delta = Math.min(stepMs, ms - elapsed);
      now += delta;
      await vi.advanceTimersByTimeAsync(delta);
      // Drains the poll chain, including immediate wakes appended mid-flight.
      await scheduler.settle();
    }
  }

  function makeScheduler(configOverride: Partial<PrPollerConfig> = {}): PrPollScheduler {
    return new PrPollScheduler({
      config: { ...config, ...configOverride },
      stateStore: stateStore.store,
      logger,
      client,
      nowMs: () => now,
    });
  }

  async function startWith(workspaces: FakeWorkspace[]): Promise<void> {
    scheduler.start();
    for (const workspace of workspaces) {
      scheduler.registerWorkspace(workspace.handle());
    }
    // Registration waits for (fake) initial sync, enumerates, then wakes.
    await advance(1);
  }

  function calls(): Array<{ batch: PrPollBatchQuery; token: string }> {
    return client.executeBatch.mock.calls.map(([batch, token]) => ({
      batch: batch as PrPollBatchQuery,
      token: token as string,
    }));
  }

  beforeEach(() => {
    vi.useFakeTimers();
    now = T0;
    logger = createTestLogger();
    stateStore = makeStateStore();
    clientHandler = async (batch) => successOutcome(batch);
    client = {
      executeBatch: vi.fn((batch: PrPollBatchQuery, token: string) => clientHandler(batch, token)),
    };
    scheduler = makeScheduler();
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  it('coalesces all due targets of one repo into a single batched call', async () => {
    const workspace = new FakeWorkspace('ws1');
    workspace.metas.set(sid('s1'), makeMeta({ pullRequests: [prMeta(11)] }));
    workspace.metas.set(
      sid('s2'),
      makeMeta({
        project: { kind: 'github', repoFullName: 'owner/repo' } as SessionMeta['project'],
        branchName: 'feat/x',
      })
    );

    await startWith([workspace]);

    expect(calls()).toHaveLength(1);
    const [call] = calls();
    expect(call?.batch.statusAliases).toEqual([{ alias: 'p0', prNumber: 11 }]);
    expect(call?.batch.discoveryAliases.map((alias) => alias.branch)).toEqual([
      'feat/x',
      'feat/x',
    ]);
    expect(call?.batch.variables).toMatchObject({ owner: 'owner', name: 'repo' });
    expect(scheduler.counters.calls).toBe(1);
    expect(scheduler.counters.pointsSpent).toBe(1);
    // Per-target last-success persisted (write-through) for restart catch-up.
    expect(stateStore.getStored().targets['ws1|s1|owner/repo|status|11']?.lastSuccessAtMs).toBe(
      now
    );
    expect(
      stateStore.getStored().targets['ws1|s2|owner/repo|discovery|feat/x']?.lastSuccessAtMs
    ).toBe(now);
  });

  it('low lane: an unviewed open PR is re-polled on the low status cadence', async () => {
    const workspace = new FakeWorkspace('ws1');
    workspace.metas.set(sid('s1'), makeMeta({ pullRequests: [prMeta(11)] }));
    await startWith([workspace]);
    expect(calls()).toHaveLength(1);

    // Boundary asserted 1s early, not 1ms: exact-ms edges are flaky under
    // full-suite timer interleaving without weakening the cadence guarantee.
    await advance(config.lowStatusIntervalMs - 1_000);
    expect(calls()).toHaveLength(1);
    await advance(1_000);
    expect(calls()).toHaveLength(2);
  });

  it('high lane: a viewed session is re-polled on the high interval', async () => {
    const workspace = new FakeWorkspace('ws1');
    workspace.metas.set(sid('s1'), makeMeta({ pullRequests: [prMeta(11)] }));
    workspace.presence = viewingPresence(sid('s1'), now);
    await startWith([workspace]);
    expect(calls()).toHaveLength(1);

    await advance(config.highIntervalMs - 1_000);
    expect(calls()).toHaveLength(1);
    workspace.setPresence(viewingPresence(sid('s1'), now)); // heartbeat refresh
    await advance(1_000);
    expect(calls()).toHaveLength(2);
  });

  it('recent conversation activity keeps a session on the high cadence', async () => {
    const workspace = new FakeWorkspace('ws1');
    workspace.metas.set(sid('s1'), makeMeta({ pullRequests: [prMeta(11)], lastMessageAt: now }));
    await startWith([workspace]);
    expect(calls()).toHaveLength(1);

    await advance(config.highIntervalMs);
    expect(calls()).toHaveLength(2);

    // After the activity window expires the session demotes to the low lane.
    await advance(config.activityWindowMs);
    const callsAtExpiry = calls().length;
    await advance(config.highIntervalMs * 2);
    expect(calls()).toHaveLength(callsAtExpiry);
  });

  it('a new viewer promotes a stale session without waiting for the low cadence', async () => {
    const workspace = new FakeWorkspace('ws1');
    workspace.metas.set(sid('s1'), makeMeta({ pullRequests: [prMeta(11)] }));
    await startWith([workspace]);
    expect(calls()).toHaveLength(1);

    await advance(60_000); // older than the high interval, well before low cadence
    workspace.setPresence(viewingPresence(sid('s1'), now));
    await advance(2_000); // presence debounce + wake
    expect(calls()).toHaveLength(2);
  });

  it('a newly associated PR is due immediately instead of inheriting the repo stamp', async () => {
    const workspace = new FakeWorkspace('ws1');
    workspace.metas.set(sid('s1'), makeMeta({ pullRequests: [prMeta(11)] }));
    await startWith([workspace]);
    expect(calls()).toHaveLength(1);

    // A webhook-style association lands seconds later: the new PR forms a
    // never-refreshed target and is polled right away; PR 11 (freshly
    // refreshed) is NOT re-queried.
    await advance(10_000);
    workspace.metas.set(sid('s1'), makeMeta({ pullRequests: [prMeta(11), prMeta(12, 'draft')] }));
    workspace.notifyMetaChanged(sid('s1'));
    await advance(3_000); // meta debounce + wake
    expect(calls()).toHaveLength(2);
    expect(calls()[1]?.batch.statusAliases).toEqual([{ alias: 'p0', prNumber: 12 }]);
  });

  it('refreshes one changed session without rescanning 2500 cached sessions', async () => {
    const workspace = new FakeWorkspace('ws1');
    workspace.metas.set(sid('s1'), makeMeta());
    for (let index = 0; index < 2_499; index += 1) {
      workspace.metas.set(sid(`historical-${index}`), makeMeta({ isArchived: true }));
    }
    await startWith([workspace]);

    expect(workspace.listAliveSessionMetas).toHaveBeenCalledTimes(1);
    expect(workspace.readOwnerMeta).not.toHaveBeenCalled();

    workspace.metas.set(sid('s1'), makeMeta({ pullRequests: [prMeta(12)] }));
    workspace.notifyMetaChanged(sid('s1'));
    await advance(2_000);

    expect(workspace.listAliveSessionMetas).toHaveBeenCalledTimes(1);
    expect(workspace.readOwnerMeta.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      sid('s1'),
      sid('s1'),
    ]);
    expect(calls()).toHaveLength(1);
    expect(calls()[0]?.batch.statusAliases).toEqual([{ alias: 'p0', prNumber: 12 }]);
  });

  it('replays session changes that race the initial full projection', async () => {
    const workspace = new FakeWorkspace('ws1');
    workspace.metas.set(sid('s1'), makeMeta());
    let releaseScan: (() => void) | undefined;
    let markScanStarted: (() => void) | undefined;
    const scanStarted = new Promise<void>((resolve) => {
      markScanStarted = resolve;
    });
    workspace.listAliveSessionMetas.mockImplementationOnce(async () => {
      const staleSnapshot = Array.from(workspace.metas.entries()).map(([sessionId, meta]) => ({
        sessionId,
        meta,
      }));
      markScanStarted?.();
      await new Promise<void>((resolve) => {
        releaseScan = resolve;
      });
      return staleSnapshot;
    });

    scheduler.start();
    scheduler.registerWorkspace(workspace.handle());
    await scanStarted;

    workspace.metas.set(sid('s1'), makeMeta({ pullRequests: [prMeta(12)] }));
    workspace.notifyMetaChanged(sid('s1'));
    releaseScan?.();
    await advance(1);

    expect(workspace.listAliveSessionMetas).toHaveBeenCalledTimes(1);
    expect(calls()).toHaveLength(1);
    expect(calls()[0]?.batch.statusAliases).toEqual([{ alias: 'p0', prNumber: 12 }]);
  });

  it('removes a deleted session from the local projection without another full scan', async () => {
    const workspace = new FakeWorkspace('ws1');
    workspace.metas.set(sid('s1'), makeMeta({ pullRequests: [prMeta(11)] }));
    await startWith([workspace]);
    expect(calls()).toHaveLength(1);

    workspace.metas.delete(sid('s1'));
    workspace.notifyMetaChanged(sid('s1'));
    await advance(2_000);
    await advance(config.lowStatusIntervalMs);

    expect(workspace.listAliveSessionMetas).toHaveBeenCalledTimes(1);
    expect(calls()).toHaveLength(1);
  });

  it('incrementally applies archive and machine-ownership changes', async () => {
    const workspace = new FakeWorkspace('ws1');
    workspace.metas.set(sid('s1'), makeMeta({ pullRequests: [prMeta(11)] }));
    await startWith([workspace]);
    expect(calls()).toHaveLength(1);

    workspace.metas.set(sid('s1'), makeMeta({ isArchived: true, pullRequests: [prMeta(11)] }));
    workspace.notifyMetaChanged(sid('s1'));
    await advance(2_000);
    await advance(config.lowStatusIntervalMs);
    expect(calls()).toHaveLength(1);

    workspace.metas.set(sid('s1'), makeMeta({ pullRequests: [prMeta(11)] }));
    workspace.notifyMetaChanged(sid('s1'));
    await advance(2_000);
    expect(calls()).toHaveLength(2);

    workspace.metas.set(
      sid('s1'),
      makeMeta({
        machineId: 'machine-2' as MachineId,
        pullRequests: [prMeta(11)],
      })
    );
    workspace.notifyMetaChanged(sid('s1'));
    await advance(2_000);
    await advance(config.lowStatusIntervalMs);

    expect(workspace.listAliveSessionMetas).toHaveBeenCalledTimes(1);
    expect(calls()).toHaveLength(2);
  });

  it('coalesces a metadata burst by session id with fake time', async () => {
    const workspace = new FakeWorkspace('ws1');
    workspace.metas.set(sid('s1'), makeMeta());
    await startWith([workspace]);
    workspace.readOwnerMeta.mockClear();

    for (let index = 1; index <= 3; index += 1) {
      workspace.metas.set(sid('s1'), makeMeta({ lastMessageAt: now + index }));
      workspace.notifyMetaChanged(sid('s1'));
    }

    await advance(1_999);
    expect(workspace.readOwnerMeta).not.toHaveBeenCalled();
    await advance(1);

    expect(workspace.readOwnerMeta).toHaveBeenCalledTimes(1);
    expect(workspace.readOwnerMeta).toHaveBeenCalledWith(sid('s1'));
    expect(workspace.listAliveSessionMetas).toHaveBeenCalledTimes(1);
  });

  it('an empty bucket skips the cycle and resumes at refill time', async () => {
    stateStore = makeStateStore({
      ...emptyPrPollerState(),
      scopes: { 'managed:scope-1': { tokens: 0.5, updatedAtMs: T0 } },
    });
    scheduler = makeScheduler();
    const workspace = new FakeWorkspace('ws1');
    workspace.metas.set(sid('s1'), makeMeta({ pullRequests: [prMeta(11)] }));
    await startWith([workspace]);

    expect(calls()).toHaveLength(0);
    expect(scheduler.counters.skips).toBe(1);
    // 0.5 points missing at 4 pts/min → one point in 7.5 s.
    await advance(7_500);
    expect(calls()).toHaveLength(1);
  });

  it('a RATE_LIMITED outcome freezes the scope until resetAt', async () => {
    const workspace = new FakeWorkspace('ws1');
    workspace.metas.set(sid('s1'), makeMeta({ pullRequests: [prMeta(11)] }));
    await startWith([workspace]);
    expect(calls()).toHaveLength(1);

    clientHandler = async () => ({
      kind: 'rate-limited',
      resetAtMs: now + 600_000,
      message: 'slow',
    });
    await advance(config.lowStatusIntervalMs);
    expect(calls()).toHaveLength(2);
    expect(scheduler.peekState().scopes['managed:scope-1']?.frozenUntilMs).toBe(now + 600_000);
    // Safety-relevant state is written through immediately (survives crashes).
    expect(stateStore.getStored().scopes['managed:scope-1']?.frozenUntilMs).toBe(now + 600_000);

    await advance(config.lowStatusIntervalMs);
    expect(calls()).toHaveLength(2); // frozen — no poll
    await advance(300_000); // 600s total since freeze
    expect(calls()).toHaveLength(3); // thawed
  });

  it('freezes the scope when remaining drops below 10% of the limit', async () => {
    const workspace = new FakeWorkspace('ws1');
    workspace.metas.set(sid('s1'), makeMeta({ pullRequests: [prMeta(11)] }));
    await startWith([workspace]);

    clientHandler = async (batch) => {
      const outcome = successOutcome(batch);
      if (outcome.kind === 'success' && outcome.batch.rateLimit) {
        outcome.batch.rateLimit.remaining = 400; // 8% of 5000
        outcome.batch.rateLimit.resetAtMs = now + 3_600_000;
      }
      return outcome;
    };
    await advance(config.lowStatusIntervalMs);
    expect(calls()).toHaveLength(2);
    expect(scheduler.peekState().scopes['managed:scope-1']?.frozenUntilMs).toBe(now + 3_600_000);

    await advance(config.lowStatusIntervalMs);
    expect(calls()).toHaveLength(2); // frozen
  });

  it('repo 404 enters 15min cooldown with exponential backoff and resets on success', async () => {
    const workspace = new FakeWorkspace('ws1');
    workspace.metas.set(sid('s1'), makeMeta({ pullRequests: [prMeta(11)] }));
    await startWith([workspace]);

    clientHandler = async () => ({ kind: 'repo-not-found-or-forbidden', message: 'not found' });
    await advance(config.lowStatusIntervalMs);
    expect(calls()).toHaveLength(2);
    expect(scheduler.peekState().repoCooldowns['managed:scope-1:owner/repo']).toMatchObject({
      consecutiveFailures: 1,
      lastErrorKind: 'repo-not-found-or-forbidden',
    });

    await advance(15 * 60_000 - 1_000);
    expect(calls()).toHaveLength(2); // still cooling down
    await advance(1_000);
    expect(calls()).toHaveLength(3); // first probe
    expect(
      scheduler.peekState().repoCooldowns['managed:scope-1:owner/repo']?.consecutiveFailures
    ).toBe(2);

    clientHandler = async (batch) => successOutcome(batch);
    await advance(30 * 60_000);
    expect(calls()).toHaveLength(4);
    expect(scheduler.peekState().repoCooldowns['managed:scope-1:owner/repo']).toBeUndefined();
    expect(stateStore.getStored().repoCooldowns['managed:scope-1:owner/repo']).toBeUndefined();
  });

  it('token-invalid invalidates and retries once, then enters cooldown when still failing', async () => {
    const workspace = new FakeWorkspace('ws1');
    workspace.metas.set(sid('s1'), makeMeta({ pullRequests: [prMeta(11)] }));
    await startWith([workspace]);

    clientHandler = async () => ({ kind: 'token-invalid', message: 'bad credentials' });
    await advance(config.lowStatusIntervalMs);

    expect(workspace.invalidateCredential).toHaveBeenCalledTimes(1);
    expect(calls()).toHaveLength(3); // initial + retry-once (first cycle had 1)
    expect(scheduler.peekState().repoCooldowns['managed:scope-1:owner/repo']).toMatchObject({
      consecutiveFailures: 1,
      lastErrorKind: 'token-invalid',
    });
  });

  it('a network error retries after the attempt floor, keeping the last state', async () => {
    const workspace = new FakeWorkspace('ws1');
    workspace.metas.set(sid('s1'), makeMeta({ pullRequests: [prMeta(11)] }));
    await startWith([workspace]);

    clientHandler = async () => ({ kind: 'network-error', message: 'ECONNRESET' });
    await advance(config.lowStatusIntervalMs);
    expect(calls()).toHaveLength(2);
    expect(scheduler.peekState().repoCooldowns['managed:scope-1:owner/repo']).toBeUndefined();
    // The failed attempt is retried after the low-lane minimum interval, not
    // only after a full desired interval.
    await advance(config.lowMinIntervalMs);
    expect(calls()).toHaveLength(3);
  });

  it('restart resumes from persisted last-success instead of re-polling immediately', async () => {
    const workspace = new FakeWorkspace('ws1');
    workspace.metas.set(sid('s1'), makeMeta({ pullRequests: [prMeta(11)] }));
    await startWith([workspace]);
    expect(calls()).toHaveLength(1);
    scheduler.stop();
    await scheduler.settle();

    scheduler = makeScheduler(); // same state store
    await startWith([workspace]);
    expect(calls()).toHaveLength(1); // within the interval — no catch-up burst

    await advance(config.lowStatusIntervalMs);
    expect(calls()).toHaveLength(2);
  });

  it('stops polling a workspace after unregister', async () => {
    const workspace = new FakeWorkspace('ws1');
    workspace.metas.set(sid('s1'), makeMeta({ pullRequests: [prMeta(11)] }));
    await startWith([workspace]);
    expect(workspace.presenceListenerCount()).toBe(1);

    scheduler.unregisterWorkspace('ws1');
    expect(workspace.presenceListenerCount()).toBe(0);
    await advance(10 * 60_000);
    expect(calls()).toHaveLength(1);
  });

  it('polls the same repo once per workspace under its own credential', async () => {
    const ws1 = new FakeWorkspace('ws1');
    ws1.metas.set(sid('s1'), makeMeta({ pullRequests: [prMeta(11)] }));
    const ws2 = new FakeWorkspace('ws2');
    ws2.credential = { token: 'token-2', source: 'managed', credentialScope: 'managed:scope-2' };
    ws2.metas.set(sid('s9'), makeMeta({ pullRequests: [prMeta(11)] }));

    await startWith([ws1, ws2]);

    expect(calls()).toHaveLength(2);
    expect(
      calls()
        .map((call) => call.token)
        .sort()
    ).toEqual(['token-1', 'token-2']);
  });

  it('writes back a changed status against fresh meta and logs the correction', async () => {
    const workspace = new FakeWorkspace('ws1');
    workspace.metas.set(sid('s1'), makeMeta({ pullRequests: [prMeta(11), prMeta(12, 'draft')] }));
    // Fixture must agree with meta: PR 12 is a draft (OPEN + isDraft upstream).
    const drafted = (batch: PrPollBatchQuery): PrPollQueryOutcome => {
      const outcome = successOutcome(batch);
      if (outcome.kind === 'success') {
        for (const result of outcome.batch.pullRequests) {
          if (result.prNumber === 12 && result.pr) {
            result.pr.status = 'draft';
          }
        }
      }
      return outcome;
    };
    clientHandler = async (batch) => drafted(batch);
    await startWith([workspace]);
    expect(workspace.writtenPatches).toHaveLength(0); // nothing changed yet

    clientHandler = async (batch) => {
      const outcome = drafted(batch);
      if (outcome.kind === 'success') {
        for (const result of outcome.batch.pullRequests) {
          if (result.prNumber === 11 && result.pr) {
            result.pr.status = 'merged';
          }
        }
      }
      return outcome;
    };
    await advance(config.lowStatusIntervalMs);

    expect(workspace.writtenPatches).toHaveLength(1);
    const [write] = workspace.writtenPatches;
    expect(write?.sessionId).toBe(sid('s1'));
    // Lifecycle corrected; the open/draft PR stays current (last item).
    expect(write?.patch.pullRequests).toEqual([prMeta(11, 'merged'), prMeta(12, 'draft')]);
    expect(scheduler.counters.corrections).toBe(1);
    expect(
      (logger.debug as ReturnType<typeof vi.fn>).mock.calls.some((args) =>
        String(args[0]).includes('poll corrected stale PR status')
      )
    ).toBe(true);
  });

  it('writes CI + merge state into pullRequestState on change only', async () => {
    const workspace = new FakeWorkspace('ws1');
    workspace.metas.set(sid('s1'), makeMeta({ pullRequests: [prMeta(11)] }));
    clientHandler = async (batch) => {
      const outcome = successOutcome(batch);
      if (outcome.kind === 'success') {
        const first = outcome.batch.pullRequests[0];
        if (first?.pr) {
          first.pr.ciState = 's';
          first.pr.mergeState = 'c';
        }
      }
      return outcome;
    };
    await startWith([workspace]);
    expect(workspace.metas.get(sid('s1'))?.pullRequestState).toEqual({
      'https://github.com/owner/repo/pull/11': {
        s: 's',
        m: 'c',
        t: Math.floor(now / 1000),
      },
    });

    // Unchanged signals → no further writes (and `t` keeps the change time).
    const writesBefore = workspace.writtenPatches.length;
    await advance(config.lowStatusIntervalMs);
    expect(workspace.writtenPatches).toHaveLength(writesBefore);
  });

  it('deletes the state record when the PR turns terminal and stops polling it', async () => {
    const workspace = new FakeWorkspace('ws1');
    workspace.metas.set(sid('s1'), makeMeta({ pullRequests: [prMeta(11)] }));
    clientHandler = async (batch) => {
      const outcome = successOutcome(batch);
      if (outcome.kind === 'success') {
        const first = outcome.batch.pullRequests[0];
        if (first?.pr) {
          first.pr.ciState = 's';
          first.pr.mergeState = 'c';
        }
      }
      return outcome;
    };
    await startWith([workspace]);
    expect(
      workspace.metas.get(sid('s1'))?.pullRequestState?.['https://github.com/owner/repo/pull/11']
    ).toBeDefined();

    clientHandler = async (batch) => {
      const outcome = successOutcome(batch);
      if (outcome.kind === 'success') {
        const first = outcome.batch.pullRequests[0];
        if (first?.pr) {
          first.pr.status = 'merged';
          first.pr.ciState = 's';
          first.pr.mergeState = 'c';
        }
      }
      return outcome;
    };
    await advance(config.lowStatusIntervalMs);
    const meta = workspace.metas.get(sid('s1'));
    expect(meta?.pullRequests).toEqual([prMeta(11, 'merged')]);
    expect(meta?.pullRequestState?.['https://github.com/owner/repo/pull/11']).toBeUndefined();

    // Terminal + no repository context → no further polling at all.
    const callsAfterTerminal = calls().length;
    await advance(30 * 60_000);
    expect(calls()).toHaveLength(callsAfterTerminal);
  });

  it('discovery associates through the backend endpoint, then writes meta', async () => {
    const workspace = new FakeWorkspace('ws1');
    workspace.metas.set(
      sid('s1'),
      makeMeta({
        project: { kind: 'github', repoFullName: 'owner/repo' } as SessionMeta['project'],
        branchName: 'feat/x',
      })
    );
    clientHandler = async (batch) => {
      const outcome = successOutcome(batch);
      if (outcome.kind === 'success') {
        outcome.batch.discoveries = outcome.batch.discoveries.map((discovery) => ({
          ...discovery,
          prs: [observation(55)],
        }));
      }
      return outcome;
    };
    await startWith([workspace]);

    expect(workspace.associateCalls).toEqual([
      {
        repoFullName: 'owner/repo',
        prNumber: 55,
        prUrl: 'https://github.com/owner/repo/pull/55',
        branch: 'feat/x',
        status: 'open',
        ownerSessionId: sid('s1'),
      },
    ]);
    expect(workspace.metas.get(sid('s1'))?.pullRequests).toEqual([prMeta(55)]);
    expect(scheduler.counters.discoveries).toBe(1);
  });

  it('a failed association keeps the discovery target due and retries the round', async () => {
    const workspace = new FakeWorkspace('ws1');
    workspace.associateResult = false;
    // The exact review-finding scenario: TERMINAL current PR + a newer PR on
    // the branch. The fingerprint must not be committed on failure, or the
    // owner would go idle-terminal and lose the new PR forever.
    workspace.metas.set(
      sid('s1'),
      makeMeta({
        project: { kind: 'github', repoFullName: 'owner/repo' } as SessionMeta['project'],
        branchName: 'feat/x',
        pullRequests: [prMeta(9, 'merged')],
      })
    );
    clientHandler = async (batch) => {
      const outcome = successOutcome(batch);
      if (outcome.kind === 'success') {
        outcome.batch.discoveries = outcome.batch.discoveries.map((discovery) => ({
          ...discovery,
          prs: [observation(55)],
        }));
      }
      return outcome;
    };
    await startWith([workspace]);

    expect(workspace.associateCalls).toHaveLength(1);
    expect(workspace.metas.get(sid('s1'))?.pullRequests).toEqual([prMeta(9, 'merged')]);
    expect(scheduler.counters.discoveries).toBe(0);
    // No fingerprint, no success stamp → NOT idle-terminal; the whole round
    // (GitHub query included) retries at the attempt floor.
    expect(scheduler.peekState().discoveryFingerprints['ws1:s1']).toBeUndefined();
    await advance(config.lowMinIntervalMs);
    expect(calls()).toHaveLength(2);
    expect(workspace.associateCalls).toHaveLength(2);

    // Once the association endpoint recovers, the PR lands and the owner
    // reaches idle-terminal only after the NEXT successful discovery pass.
    workspace.associateResult = true;
    await advance(config.lowMinIntervalMs);
    expect(workspace.metas.get(sid('s1'))?.pullRequests).toEqual([
      prMeta(9, 'merged'),
      prMeta(55),
    ]);
  });

  it('a malformed discovery alias is not a confirmed empty result (no idle-terminal)', async () => {
    const workspace = new FakeWorkspace('ws1');
    workspace.metas.set(
      sid('s1'),
      makeMeta({
        project: { kind: 'github', repoFullName: 'owner/repo' } as SessionMeta['project'],
        branchName: 'feat/x',
        pullRequests: [prMeta(9, 'merged')],
      })
    );
    clientHandler = async (batch) => {
      const outcome = successOutcome(batch);
      if (outcome.kind === 'success') {
        outcome.batch.discoveries = outcome.batch.discoveries.map((discovery) => ({
          ...discovery,
          prs: [],
          ok: false,
        }));
      }
      return outcome;
    };
    await startWith([workspace]);
    expect(calls()).toHaveLength(1);
    expect(scheduler.peekState().discoveryFingerprints['ws1:s1']).toBeUndefined();

    // Still due: retried at the attempt floor instead of going idle.
    await advance(config.lowMinIntervalMs);
    expect(calls()).toHaveLength(2);
  });

  it('idle-terminal: a terminal current PR stops discovery until the branch changes', async () => {
    const workspace = new FakeWorkspace('ws1');
    workspace.metas.set(
      sid('s1'),
      makeMeta({
        project: { kind: 'github', repoFullName: 'owner/repo' } as SessionMeta['project'],
        branchName: 'feat/x',
        pullRequests: [prMeta(9, 'merged')],
      })
    );
    await startWith([workspace]);
    // One discovery pass records the context fingerprint...
    expect(calls()).toHaveLength(1);
    expect(scheduler.peekState().discoveryFingerprints['ws1:s1']).toBe('owner/repo|feat/x');

    // ...after which the terminal owner consumes no quota at all.
    await advance(45 * 60_000);
    expect(calls()).toHaveLength(1);

    // A branch switch re-enables discovery immediately (fresh target key —
    // it does NOT inherit the old branch's success stamp).
    workspace.metas.set(sid('s1'), {
      ...workspace.metas.get(sid('s1'))!,
      branchName: 'feat/next',
    });
    workspace.notifyMetaChanged(sid('s1'));
    await advance(5_000);
    expect(calls()).toHaveLength(2);
    expect(calls()[1]?.batch.variables).toMatchObject({ b0: 'feat/next' });
  });

  it('drops in-flight discovery results when the branch switched mid-request', async () => {
    const workspace = new FakeWorkspace('ws1');
    workspace.metas.set(
      sid('s1'),
      makeMeta({
        project: { kind: 'github', repoFullName: 'owner/repo' } as SessionMeta['project'],
        branchName: 'feat/x',
      })
    );
    clientHandler = async (batch) => {
      // The session switches branches while the GitHub request is in flight:
      // the results belong to the OLD branch and must not associate its PR.
      workspace.metas.set(sid('s1'), {
        ...workspace.metas.get(sid('s1'))!,
        branchName: 'feat/other',
      });
      const outcome = successOutcome(batch);
      if (outcome.kind === 'success') {
        outcome.batch.discoveries = outcome.batch.discoveries.map((discovery) => ({
          ...discovery,
          prs: [observation(55)],
        }));
      }
      return outcome;
    };
    await startWith([workspace]);

    expect(workspace.associateCalls).toHaveLength(0);
    expect(workspace.metas.get(sid('s1'))?.pullRequests).toBeUndefined();
    expect(scheduler.peekState().discoveryFingerprints['ws1:s1']).toBeUndefined();
  });

  it('drops in-flight results when a session switches to a direct local project', async () => {
    const workspace = new FakeWorkspace('ws1');
    workspace.metas.set(
      sid('s1'),
      makeMeta({
        project: { kind: 'github', repoFullName: 'owner/repo' } as SessionMeta['project'],
        branchName: 'feat/x',
      })
    );
    clientHandler = async (batch) => {
      workspace.metas.set(sid('s1'), {
        ...workspace.metas.get(sid('s1'))!,
        project: {
          kind: 'local',
          githubRepoFullName: 'owner/repo',
        } as SessionMeta['project'],
      });
      const outcome = successOutcome(batch);
      if (outcome.kind === 'success') {
        outcome.batch.discoveries = outcome.batch.discoveries.map((discovery) => ({
          ...discovery,
          prs: [observation(55)],
        }));
      }
      return outcome;
    };
    await startWith([workspace]);

    expect(workspace.associateCalls).toHaveLength(0);
    expect(workspace.writtenPatches).toHaveLength(0);
    expect(workspace.metas.get(sid('s1'))?.pullRequests).toBeUndefined();
    expect(scheduler.peekState().discoveryFingerprints['ws1:s1']).toBeUndefined();
  });

  it('does not write or associate for an owner that migrated machines mid-poll', async () => {
    const workspace = new FakeWorkspace('ws1');
    workspace.metas.set(sid('s1'), makeMeta({ pullRequests: [prMeta(11)] }));
    await startWith([workspace]);

    clientHandler = async (batch) => {
      workspace.metas.set(sid('s1'), {
        ...workspace.metas.get(sid('s1'))!,
        machineId: 'machine-2' as MachineId,
      });
      const outcome = successOutcome(batch);
      if (outcome.kind === 'success') {
        const first = outcome.batch.pullRequests[0];
        if (first?.pr) {
          first.pr.status = 'merged';
        }
      }
      return outcome;
    };
    await advance(config.lowStatusIntervalMs);

    expect(workspace.writtenPatches).toHaveLength(0);
    expect(workspace.metas.get(sid('s1'))?.pullRequests).toEqual([prMeta(11)]);
  });

  it('truncated targets are not starved: the tail forms the next batch', async () => {
    scheduler = makeScheduler({ maxAliasesPerQuery: 2 });
    const workspace = new FakeWorkspace('ws1');
    workspace.metas.set(
      sid('s1'),
      makeMeta({ pullRequests: [prMeta(11), prMeta(12), prMeta(13)] })
    );
    await startWith([workspace]);

    // First call covers the alias budget; the truncated PR was never stamped
    // as attempted, so it stays due and gets its own batch on the next wake.
    expect(calls()).toHaveLength(1);
    expect(calls()[0]?.batch.statusAliases.map((alias) => alias.prNumber)).toEqual([11, 12]);
    await advance(MAX_WAKE_TEST_MS);
    expect(calls().length).toBeGreaterThanOrEqual(2);
    expect(calls()[1]?.batch.statusAliases.map((alias) => alias.prNumber)).toEqual([13]);
  });

  it('a stuck initial sync never blocks other workspaces, and is retried bounded', async () => {
    const stuck = new FakeWorkspace('ws-stuck');
    stuck.initialSyncResult = false;
    stuck.waitForInitialSync.mockImplementationOnce(async (timeoutMs?: number) => {
      await new Promise((resolve) => setTimeout(resolve, timeoutMs));
      return false;
    });
    stuck.metas.set(sid('s1'), makeMeta({ pullRequests: [prMeta(11)] }));
    const healthy = new FakeWorkspace('ws-ok');
    healthy.metas.set(
      sid('s2'),
      makeMeta({
        pullRequests: [{ url: 'https://github.com/owner/repo2/pull/22', status: 'open' }],
      })
    );

    scheduler.start();
    scheduler.registerWorkspace(stuck.handle());
    scheduler.registerWorkspace(healthy.handle());
    await advance(1);

    // The healthy workspace initializes and polls despite the stuck one.
    expect(calls()).toHaveLength(1);
    expect(calls()[0]?.batch.variables).toMatchObject({ owner: 'owner', name: 'repo2' });

    // The stuck workspace is not enumerated while its real-duration bounded
    // wait is pending, and that wait does not occupy the shared poll chain.
    await advance(INITIAL_SYNC_WAIT_MS);
    expect(calls()).toHaveLength(1);

    stuck.initialSyncResult = true;
    await advance(INITIAL_SYNC_RETRY_MS);
    expect(calls()).toHaveLength(2);
    expect(calls()[1]?.batch.variables).toMatchObject({ owner: 'owner', name: 'repo' });
  });

  it('does not associate or write meta when the session is deleted mid-poll', async () => {
    const workspace = new FakeWorkspace('ws1');
    workspace.metas.set(
      sid('s1'),
      makeMeta({
        project: { kind: 'github', repoFullName: 'owner/repo' } as SessionMeta['project'],
        branchName: 'feat/x',
      })
    );
    clientHandler = async (batch) => {
      // Session deleted while the GitHub request is in flight.
      workspace.metas.delete(sid('s1'));
      const outcome = successOutcome(batch);
      if (outcome.kind === 'success') {
        outcome.batch.discoveries = outcome.batch.discoveries.map((discovery) => ({
          ...discovery,
          prs: [observation(55)],
        }));
      }
      return outcome;
    };
    await startWith([workspace]);

    // The backend endpoint does not validate session existence — the poller must.
    expect(workspace.associateCalls).toHaveLength(0);
    expect(workspace.writtenPatches).toHaveLength(0);
    expect(workspace.metas.has(sid('s1'))).toBe(false);
  });

  it('does not write status to a session deleted mid-poll', async () => {
    const workspace = new FakeWorkspace('ws1');
    workspace.metas.set(sid('s1'), makeMeta({ pullRequests: [prMeta(11)] }));
    await startWith([workspace]);
    expect(workspace.writtenPatches).toHaveLength(0);

    clientHandler = async (batch) => {
      workspace.metas.delete(sid('s1'));
      const outcome = successOutcome(batch);
      if (outcome.kind === 'success') {
        const first = outcome.batch.pullRequests[0];
        if (first?.pr) {
          first.pr.status = 'merged';
        }
      }
      return outcome;
    };
    await advance(config.lowStatusIntervalMs);

    expect(workspace.writtenPatches).toHaveLength(0);
    expect(workspace.metas.has(sid('s1'))).toBe(false);
  });

  it('normalizes child tabs to the owner session in the write path', async () => {
    const workspace = new FakeWorkspace('ws1');
    workspace.metas.set(sid('owner'), makeMeta({ pullRequests: [prMeta(11)] }));
    workspace.metas.set(sid('child'), makeMeta({ parentSessionId: sid('owner') }));
    await startWith([workspace]);

    clientHandler = async (batch) => {
      const outcome = successOutcome(batch);
      if (outcome.kind === 'success') {
        const first = outcome.batch.pullRequests[0];
        if (first?.pr) {
          first.pr.status = 'closed';
        }
      }
      return outcome;
    };
    await advance(config.lowStatusIntervalMs);

    expect(workspace.writtenPatches).toHaveLength(1);
    expect(workspace.writtenPatches[0]?.sessionId).toBe(sid('owner'));
    expect(workspace.metas.get(sid('owner'))?.pullRequests).toEqual([prMeta(11, 'closed')]);
  });

  it('charges the retried call to the replacement credential scope', async () => {
    const workspace = new FakeWorkspace('ws1');
    workspace.metas.set(sid('s1'), makeMeta({ pullRequests: [prMeta(11)] }));
    await startWith([workspace]);

    workspace.replacementCredential = {
      token: 'token-2',
      source: 'managed',
      credentialScope: 'managed:scope-2',
    };
    clientHandler = async (batch, token) => {
      if (token === 'token-1') {
        return { kind: 'token-invalid', message: 'expired' };
      }
      return successOutcome(batch);
    };
    await advance(config.lowStatusIntervalMs);

    expect(workspace.invalidateCredential).toHaveBeenCalledTimes(1);
    expect(calls()).toHaveLength(3); // initial + invalid + retried with token-2
    expect(calls()[2]?.token).toBe('token-2');
    const scopes = scheduler.peekState().scopes;
    // Quota for the retried call is spent on scope-2, not the invalid scope-1.
    expect(scopes['managed:scope-2']?.tokens).toBeLessThan(config.bucketCapacityPoints);
    expect(scopes['managed:scope-1']?.tokens ?? config.bucketCapacityPoints).toBe(
      config.bucketCapacityPoints
    );
  });

  it('does not retry with a replacement credential whose scope is frozen', async () => {
    const workspace = new FakeWorkspace('ws1');
    workspace.metas.set(sid('s1'), makeMeta({ pullRequests: [prMeta(11)] }));
    await startWith([workspace]);

    workspace.replacementCredential = {
      token: 'token-2',
      source: 'managed',
      credentialScope: 'managed:scope-2',
    };
    scheduler.peekState().scopes['managed:scope-2'] = {
      tokens: config.bucketCapacityPoints,
      updatedAtMs: now,
      frozenUntilMs: now + 10 * 60_000,
    };
    clientHandler = async () => ({ kind: 'token-invalid', message: 'expired' });

    await advance(config.lowStatusIntervalMs);

    expect(calls()).toHaveLength(2); // initial + invalid token; no token-2 request
    expect(calls().some((call) => call.token === 'token-2')).toBe(false);
    expect(scheduler.counters.skips).toBe(1);
  });

  it('does not retry with a replacement credential whose repo is cooling down', async () => {
    const workspace = new FakeWorkspace('ws1');
    workspace.metas.set(sid('s1'), makeMeta({ pullRequests: [prMeta(11)] }));
    await startWith([workspace]);

    workspace.replacementCredential = {
      token: 'token-2',
      source: 'managed',
      credentialScope: 'managed:scope-2',
    };
    scheduler.peekState().repoCooldowns['managed:scope-2:owner/repo'] = {
      consecutiveFailures: 1,
      nextRetryAtMs: now + 10 * 60_000,
      lastErrorKind: 'repo-not-found-or-forbidden',
    };
    clientHandler = async () => ({ kind: 'token-invalid', message: 'expired' });

    await advance(config.lowStatusIntervalMs);

    expect(calls()).toHaveLength(2); // initial + invalid token; no token-2 request
    expect(calls().some((call) => call.token === 'token-2')).toBe(false);
  });
});

/** Wake cap: truncated targets are picked up within one capped wake. */
const MAX_WAKE_TEST_MS = 31_000;
