/**
 * Reproduction harness for the reported reconnect storm.
 *
 * Field report: ~30 transport reconnects/minute, each logging
 * `[dispatch] Scanning owned sessions (reason=meta-room-synced:transport-connected)`
 * followed by `Found 113 session room(s)`, i.e. ~3400 session reconciles/minute,
 * with 6.4s event-loop lag and 1.6GB RSS.
 *
 * These started as a diagnostic harness asserting the BUGGY behavior (59
 * fan-outs/min, 6667 session reconciles/min, reconnect gaps pinned at the 1s
 * base delay). They are now regression guards for the fix, and each one logs
 * its pre-fix number so the delta stays visible:
 *
 *   scenario A: fan-outs/min   59 -> 2      reconnect gaps 1050 constant -> climbing
 *   scenario D: reconciles/min 6667 -> 226
 *
 * Scenario B is the control that must NOT change: a genuine sustained outage
 * was always cheap, and its exponential backoff still works.
 *
 * What is deliberately NOT modelled: loro-repo internals. The aggregate
 * `TransportConnectionStatus` is driven by hand here, so these tests prove
 * "IF the aggregate flaps, THEN a storm follows" — they do not prove what makes
 * it flap in production.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { WorkspaceId, MachineId, SessionId } from '@lody/shared';
import type { LoroRepo, TransportRoomStatus, TransportSubscription } from 'loro-repo';

import type { Logger } from '../src/utils/logger';
import type { LoroDocumentManager } from '../src/lib/loro/doc';
import type { SessionExecutionService } from '../src/session/session-execution-service';
import { LoroConnectionRecoveryController } from '../src/lib/loro/connection-recovery';
import { SessionDispatchWatcher } from '../src/session/session-dispatch-watcher';

/** Field report: this workspace had 113 session rooms. */
const SESSION_ROOM_COUNT = 113;
/** How long the stuck room stays non-errored after repo.reconnect() moves it. */
const ROOM_REFAIL_MS = 50;
const ONE_MINUTE_MS = 60_000;

const createSilentLogger = (): Logger =>
  ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    success: () => {},
    setLevel: () => {},
    child: () => createSilentLogger(),
    close: async () => {},
  }) as unknown as Logger;

type FakeMetaSub = TransportSubscription & {
  emitStatus: (status: TransportRoomStatus) => void;
};

/** Mirrors the fake in connection-recovery.test.ts: status is read through the
 *  per-transport 'streams' binding, never the classic surface. */
const createMetaSub = (initialStatus: TransportRoomStatus = 'joined'): FakeMetaSub => {
  const listeners = new Set<(status: TransportRoomStatus) => void>();
  const sub = {
    status: initialStatus,
    firstSyncedWithRemote: Promise.resolve(),
    waitUntilSynced: vi.fn(async () => {}),
    unsubscribe: vi.fn(),
    rejoin: vi.fn(),
    onStatusChange: (listener: (status: TransportRoomStatus) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emitStatus: (status: TransportRoomStatus) => {
      sub.status = status;
      for (const listener of listeners) listener(status);
    },
    subscription: (transportId: string) => ({
      transportId,
      get status() {
        return sub.status;
      },
      firstSyncedWithRemote: sub.firstSyncedWithRemote,
      waitUntilSynced: sub.waitUntilSynced,
      rejoin: sub.rejoin,
      onStatusChange: sub.onStatusChange,
    }),
    subscriptions: () => [],
    transportIds: () => ['streams'],
  };
  return sub as unknown as FakeMetaSub;
};

describe('reconnect storm repro', () => {
  let controller: LoroConnectionRecoveryController | null = null;
  let watcher: SessionDispatchWatcher | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    // Kill jitter so reconnect delays are exactly the computed backoff.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(async () => {
    watcher?.stop();
    watcher = null;
    await controller?.cleanUp();
    controller = null;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const createController = (repo: Partial<LoroRepo>, metaSub: FakeMetaSub) => {
    controller = new LoroConnectionRecoveryController({
      repo: repo as LoroRepo,
      workspaceId: 'ws-storm-repro' as WorkspaceId,
      logger: createSilentLogger(),
      initialMetaSub: metaSub,
      initialTransportStatus: 'connected',
      initialMetaSyncPromise: Promise.resolve(true),
      initialMetaSyncCompleted: true,
      onMetaRoomReady: vi.fn(),
    });
    return controller;
  };

  it('SCENARIO A: a flapping aggregate is throttled and backs off', async () => {
    // Model: one session room is permanently broken, so the all-rooms aggregate
    // reads 'disconnected'. `repo.reconnect()` transiently moves it (rejoin ->
    // 'connecting'), which is enough to make isStreamsHealthy() true, and then it
    // fails again ROOM_REFAIL_MS later. The meta room NEVER leaves 'joined':
    // nothing was actually missed on any of these cycles.
    let instance!: LoroConnectionRecoveryController;
    let stormActive = true;
    const reconnectAtMs: number[] = [];
    const reconnect = vi.fn(async () => {
      reconnectAtMs.push(Date.now());
      if (!stormActive) return;
      instance.setTransportStatus('connecting');
      setTimeout(() => {
        if (stormActive) instance.setTransportStatus('disconnected');
      }, ROOM_REFAIL_MS);
    });
    const metaSub = createMetaSub('joined');
    instance = createController({ reconnect, transportRooms: () => [] }, metaSub);

    const metaSynced = vi.fn();
    const streamsOnline = vi.fn();
    instance.onMetaRoomSynced(metaSynced);
    instance.onStreamsOnline(streamsOnline);

    // The stuck room poisons the aggregate.
    instance.setTransportStatus('disconnected');
    await vi.advanceTimersByTimeAsync(ONE_MINUTE_MS);
    stormActive = false;

    const fanOuts = metaSynced.mock.calls.length;
    // eslint-disable-next-line no-console
    console.log(
      `[SCENARIO A] fan-outs/min=${fanOuts} online-signals/min=${streamsOnline.mock.calls.length} reconnects/min=${reconnect.mock.calls.length} (pre-fix: 59 / 59 / 59)`
    );

    // The expensive fan-out is bounded by the 30s floor: at most ~2 per minute
    // no matter how fast the aggregate flaps.
    expect(fanOuts).toBeLessThanOrEqual(3);
    // ...but parked work is NOT starved: the cheap online signal still fires on
    // every recovery edge, so a dirty Machine Flock doc and the automation
    // queues are released each time (they arm no timer of their own).
    expect(streamsOnline.mock.calls.length).toBeGreaterThan(fanOuts);

    // Backoff now engages: gaps climb from the 1s base delay toward the 30s cap
    // instead of being reset by every transient healthy blip.
    const gaps = reconnectAtMs.slice(1).map((at, index) => at - (reconnectAtMs[index] ?? 0));
    const maxGap = Math.max(...gaps);
    // eslint-disable-next-line no-console
    console.log(
      `[SCENARIO A] reconnect gaps (ms): ${gaps.join(', ')} max=${maxGap} (pre-fix: constant 1050)`
    );
    expect(maxGap).toBeGreaterThanOrEqual(8_000);
  });

  it('SCENARIO B (control): a sustained outage backs off and never fans out', async () => {
    // Same broken transport, but WITHOUT the transient healthy blip: the aggregate
    // stays 'disconnected' the whole time. This isolates the flap as the cause —
    // an outage on its own is cheap.
    const reconnectAtMs: number[] = [];
    const reconnect = vi.fn(async () => {
      reconnectAtMs.push(Date.now());
    });
    const metaSub = createMetaSub('joined');
    const instance = createController({ reconnect, transportRooms: () => [] }, metaSub);

    const metaSynced = vi.fn();
    instance.onMetaRoomSynced(metaSynced);

    instance.setTransportStatus('disconnected');
    await vi.advanceTimersByTimeAsync(ONE_MINUTE_MS);

    // eslint-disable-next-line no-console
    console.log(
      `[SCENARIO B] fan-outs/min=${metaSynced.mock.calls.length} reconnects/min=${reconnect.mock.calls.length}`
    );

    // No health rising edge -> no fan-out at all.
    expect(metaSynced).not.toHaveBeenCalled();
    // And exponential backoff works exactly as designed when it is not reset.
    const gaps = reconnectAtMs.slice(1).map((at, index) => at - (reconnectAtMs[index] ?? 0));
    // eslint-disable-next-line no-console
    console.log(`[SCENARIO B] reconnect gaps (ms): ${gaps.join(', ')}`);
    expect(Math.max(...gaps)).toBeGreaterThanOrEqual(4_000);
  });

  const createWatcherOverDocumentManager = (options: {
    onMetaRoomSynced: LoroDocumentManager['onMetaRoomSynced'];
    scanCounter: { scans: number; docMetaReads: number };
  }) => {
    const machineId = 'machine-storm' as MachineId;
    const roomIds = Array.from(
      { length: SESSION_ROOM_COUNT },
      (_unused, index) => `session-session-${index}`
    );

    const workspaceDocument = {
      repo: {
        getMeta: () => ({
          scan: async () => {
            options.scanCounter.scans += 1;
            return roomIds.map((roomId) => ({ key: ['e', roomId], value: true }));
          },
        }),
        getDocMeta: async (roomId: string) => {
          options.scanCounter.docMetaReads += 1;
          return {
            meta: {
              id: roomId.slice('session-'.length) as SessionId,
              machineId,
              userId: 'user-1',
              createdAt: new Date().toISOString(),
              cliType: 'builtin',
              agentType: 'codex',
              // Idle and fully handled: reconcile does the cheapest possible work
              // and still costs one getDocMeta per room per scan.
              status: { type: 'idle' },
            },
          };
        },
        watch: () => ({ unsubscribe: () => {} }),
      },
      getOrCreateSessionDoc: async () => {
        throw new Error('idle sessions must not open documents in this repro');
      },
      onMetaRoomSynced: options.onMetaRoomSynced,
    } as unknown as LoroDocumentManager;

    watcher = new SessionDispatchWatcher({
      logger: createSilentLogger(),
      machineId,
      workspaceId: 'ws-storm-repro' as WorkspaceId,
      workspaceDocument,
      executionService: {
        getExecutionSnapshot: () => ({
          hasActiveTurn: false,
          hasBlockingPendingCreate: false,
          hasReusableSession: false,
        }),
      } as unknown as SessionExecutionService,
      userResolver: { resolve: vi.fn(), clear: vi.fn() },
      canUseMachine: vi.fn(async () => ({ outcome: 'allowed' as const })),
    });
    return watcher;
  };

  it('SCENARIO C: the watcher itself has no throttle — one fan-out costs one full scan', async () => {
    const scanCounter = { scans: 0, docMetaReads: 0 };
    let fire: ((reason: string) => void) | null = null;

    const created = createWatcherOverDocumentManager({
      onMetaRoomSynced: ((listener: (reason: string) => void) => {
        fire = listener;
        return () => {
          fire = null;
        };
      }) as unknown as LoroDocumentManager['onMetaRoomSynced'],
      scanCounter,
    });
    await created.start();
    // Drain the startup bootstrap so the counts below are recovery-driven only.
    await vi.advanceTimersByTimeAsync(100);
    const afterStartup = { ...scanCounter };

    // 30 recovery fan-outs, spaced like the field report (~2s apart).
    for (let round = 0; round < 30; round++) {
      fire?.('transport-connected');
      await vi.advanceTimersByTimeAsync(2_000);
    }

    const scans = scanCounter.scans - afterStartup.scans;
    const reconciles = scanCounter.docMetaReads - afterStartup.docMetaReads;
    // eslint-disable-next-line no-console
    console.log(`[SCENARIO C] scans=${scans} session reconciles=${reconciles}`);

    // DELIBERATE: the watcher does not rate-limit itself. Per
    // `src/session/AGENTS.md`, coalescing bounds the work per trigger and
    // keeping the trigger RATE sane is the connection recovery boundary's job —
    // which is where the fix put it. This test pins that ownership: if someone
    // adds a throttle here instead, the cost model moves and this fails.
    expect(scans).toBe(30);
    // The price of one unthrottled fan-out, i.e. the reported 3400/min figure.
    expect(reconciles).toBe(30 * SESSION_ROOM_COUNT);
  });

  it('SCENARIO D (end to end): one stuck room no longer floods the dispatch watcher', async () => {
    // The real recovery controller wired to the real dispatch watcher. Nothing
    // in between is faked except loro-repo's aggregate status and the room store.
    let instance!: LoroConnectionRecoveryController;
    let stormActive = true;
    const reconnect = vi.fn(async () => {
      if (!stormActive) return;
      instance.setTransportStatus('connecting');
      setTimeout(() => {
        if (stormActive) instance.setTransportStatus('disconnected');
      }, ROOM_REFAIL_MS);
    });
    const metaSub = createMetaSub('joined');
    instance = createController({ reconnect, transportRooms: () => [] }, metaSub);

    const scanCounter = { scans: 0, docMetaReads: 0 };
    const created = createWatcherOverDocumentManager({
      onMetaRoomSynced: ((listener: (reason: string) => void) =>
        instance.onMetaRoomSynced(listener)) as unknown as LoroDocumentManager['onMetaRoomSynced'],
      scanCounter,
    });
    await created.start();
    await vi.advanceTimersByTimeAsync(100);
    const afterStartup = { ...scanCounter };

    instance.setTransportStatus('disconnected');
    await vi.advanceTimersByTimeAsync(ONE_MINUTE_MS);
    stormActive = false;

    const scans = scanCounter.scans - afterStartup.scans;
    const reconciles = scanCounter.docMetaReads - afterStartup.docMetaReads;
    // eslint-disable-next-line no-console
    console.log(
      `[SCENARIO D] one stuck room -> scans/min=${scans} reconciles/min=${reconciles} (pre-fix: 59 / 6667; meta room stayed 'joined' throughout)`
    );

    // The whole point: a transport-only flap can no longer buy more than the
    // 30s floor allows, however many rooms the workspace has.
    expect(scans).toBeLessThanOrEqual(3);
    expect(reconciles).toBeLessThanOrEqual(3 * SESSION_ROOM_COUNT);
  });
});
