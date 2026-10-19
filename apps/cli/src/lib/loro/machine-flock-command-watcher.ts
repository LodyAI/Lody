import type { MachineFlockEvent } from '@lody/shared';
import type { LoroRepo, RepoRoomSubscription } from 'loro-repo';

import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';

import { computeLoroReconnectDelayMs } from './connection-recovery';
import { isRecoverableStreamsRoomStatus, streamsRoomBinding } from './streams-room-binding';

type MachineFlockDocHandle = Awaited<ReturnType<LoroRepo['openFlockDoc']>>;

export type MachineFlockCommandWatcherOptions = {
  repo: LoroRepo;
  docId: string;
  /** Greppable `workspaceId=…, machineId=…, docId=…` context for debug lines. */
  logContext: string;
  waitForRemoteAuthority: boolean;
  logger: Logger;
  /**
   * `authoritative` is false while the room has not yet established remote
   * authority, so consumers that must not act on a possibly-stale local row
   * can skip without reaching into watcher state.
   */
  onEvents: (events: readonly MachineFlockEvent[], context: { authoritative: boolean }) => void;
  onReady: () => void;
};

/**
 * Owns the long-lived Machine Flock command subscription.
 *
 * Flock rows are durable, so reconnect correctness is scan-based rather than
 * event-based: every successful authoritative join calls `onReady`, whose
 * consumers rescan their queues. Events only provide low-latency wakeups while
 * the room is healthy. Initial join/sync failures retry with bounded backoff.
 */
export class MachineFlockCommandWatcher {
  private readonly repo: LoroRepo;
  private readonly docId: string;
  private readonly logContext: string;
  private readonly waitForRemoteAuthority: boolean;
  private readonly logger: Logger;
  private readonly onEvents: (
    events: readonly MachineFlockEvent[],
    context: { authoritative: boolean }
  ) => void;
  private readonly onReady: () => void;

  private handle: MachineFlockDocHandle | null = null;
  private unsubscribeFlock: (() => void) | null = null;
  private roomSub: RepoRoomSubscription | null = null;
  private unsubscribeRoomStatus: (() => void) | null = null;
  private attemptPromise: Promise<void> | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryAttempt = 0;
  private ready = false;
  private stopped = false;

  constructor(options: MachineFlockCommandWatcherOptions) {
    this.repo = options.repo;
    this.docId = options.docId;
    this.logContext = options.logContext;
    this.waitForRemoteAuthority = options.waitForRemoteAuthority;
    this.logger = options.logger;
    this.onEvents = options.onEvents;
    this.onReady = options.onReady;
  }

  /** Runs a consumer callback so a throwing consumer cannot break the room. */
  private invokeSafely(label: string, run: () => void): void {
    try {
      run();
    } catch (error) {
      this.logger.debug(
        `[machine-flock] Command ${label} failed (${this.logContext}): ${formatErrorMessage(error)}`
      );
    }
  }

  /** Single recovery step for every way a joined room can turn out unusable. */
  private failRoom(roomSub: RepoRoomSubscription, reason: string): void {
    if (this.stopped || this.roomSub !== roomSub) return;
    this.logger.debug(
      `[machine-flock] Command room ${reason}; scheduling rejoin (${this.logContext})`
    );
    this.releaseRoom(roomSub);
    this.scheduleRetry();
  }

  get isReady(): boolean {
    return this.ready;
  }

  start(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!this.attemptPromise) {
      this.attemptPromise = this.connect()
        .catch((error: unknown) => {
          if (this.stopped) return;
          this.logger.debug(
            `[machine-flock] Command watcher connection failed (${this.logContext}): ${formatErrorMessage(
              error,
              { includeStack: true }
            )}`
          );
          this.scheduleRetry();
        })
        .finally(() => {
          this.attemptPromise = null;
        });
    }
    return this.attemptPromise;
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.releaseRoom(this.roomSub);
    this.unsubscribeFlock?.();
    this.unsubscribeFlock = null;
    this.handle = null;
  }

  private async connect(): Promise<void> {
    const handle = (this.handle ??= await this.repo.openFlockDoc(this.docId));
    if (!this.unsubscribeFlock) {
      this.unsubscribeFlock = handle.flock.subscribe((batch) => {
        if (this.stopped) return;
        const events = (batch as { events?: MachineFlockEvent[] }).events ?? [];
        this.invokeSafely('event handler', () =>
          this.onEvents(events, { authoritative: this.ready })
        );
      });
    }
    if (this.roomSub) return;

    const roomSub = await handle.joinRoom();
    if (this.stopped) {
      roomSub.unsubscribe();
      return;
    }
    const binding = streamsRoomBinding(roomSub);
    this.roomSub = roomSub;
    this.unsubscribeRoomStatus = binding.onStatusChange((status) => {
      if (!isRecoverableStreamsRoomStatus(status)) return;
      this.failRoom(roomSub, `became ${status}`);
    });
    if (isRecoverableStreamsRoomStatus(binding.status)) {
      this.failRoom(roomSub, `joined as ${binding.status}`);
      return;
    }

    if (this.waitForRemoteAuthority) {
      void binding.firstSyncedWithRemote.then(
        () => this.markReady(roomSub),
        (error: unknown) =>
          this.failRoom(roomSub, `initial sync failed: ${formatErrorMessage(error)}`)
      );
      return;
    }
    this.markReady(roomSub);
  }

  private markReady(roomSub: RepoRoomSubscription): void {
    if (this.stopped || this.roomSub !== roomSub) return;
    this.retryAttempt = 0;
    this.ready = true;
    this.invokeSafely('ready handler', () => this.onReady());
    this.logger.debug(`[machine-flock] Command watcher ready (${this.logContext})`);
  }

  private releaseRoom(roomSub: RepoRoomSubscription | null): void {
    if (!roomSub || this.roomSub !== roomSub) return;
    this.unsubscribeRoomStatus?.();
    this.unsubscribeRoomStatus = null;
    this.roomSub = null;
    if (this.waitForRemoteAuthority) this.ready = false;
    roomSub.unsubscribe();
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const delayMs = computeLoroReconnectDelayMs(this.retryAttempt);
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.start();
    }, delayMs);
    this.retryTimer.unref?.();
  }
}
