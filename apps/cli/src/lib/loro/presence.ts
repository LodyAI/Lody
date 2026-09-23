import {
  EphemeralStoreAdaptor,
  EphemeralStreamCrdt,
  type EphemeralStreamSubscription,
} from '@loro-dev/streams-crdt/loro';
import { EphemeralStore, type Value } from 'loro-crdt';
import { v4 as uuidv4 } from 'uuid';
import {
  LODY_PRESENCE_HEARTBEAT_MS,
  LODY_PRESENCE_TTL_MS,
  LORO_STREAMS_BUCKET_ID,
  createLoroStreamUrl,
  getLoroMetaStreamId,
  getLoroStreamsPresenceBaseUrl,
  getLodyMachinePresenceKey,
  getLodySessionPresenceKey,
  getServerNow,
  parseLodyPresenceStates,
  toLodyPresenceStreamUrl,
  type LodyMachinePresenceState,
  type LodyPresenceInstanceId,
  type LodyPresenceState,
  type LodyPresenceStateMap,
  type LodySessionPresenceState,
  type MachineId,
  type SessionId,
  type SessionStatus,
  type WorkspaceId,
} from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';

type StreamsAuthCallback = (context?: { reason: string }) => Promise<string | undefined>;

export type CliPresenceRuntimeOptions = {
  workspaceId: WorkspaceId;
  logger: Logger;
};

export type CliPresenceStreamsOptions = {
  streamsBaseUrl: string;
  auth: StreamsAuthCallback;
  /** Hosted shard topology from the token response; presence publishes to its dedicated host when set. */
  shardHostSuffix?: string;
};

// Presence is a liveness channel: a failed join or a dead room must never be
// permanent. Initial joins retry forever with capped backoff, and terminal
// room states (`error`/`disconnected` — the transport's own reconnects only
// cover retriable failures) trigger an explicit rejoin.
const JOIN_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
const REJOIN_DELAYS_MS = [2_000, 5_000, 10_000, 30_000, 60_000];

export class CliPresenceRuntime {
  private readonly instanceId = uuidv4() as LodyPresenceInstanceId;
  /**
   * Workspace presence replica: this process's own writes PLUS every other peer
   * (remote CLIs, other clients) received over the shared workspace presence
   * room. Read by in-process consumers that need the whole room — machine
   * online checks, the PR poller's `session-viewing` signal.
   */
  private readonly store = new EphemeralStore(LODY_PRESENCE_TTL_MS);
  /**
   * Entries AUTHORED BY THIS PROCESS only, and the sole payload of the local
   * data plane — that plane splits by ORIGIN, not by content. Relaying
   * {@link store} instead would hand the renderer's "local" snapshot authority
   * over peers it already replicates live from the cloud; see
   * `specs/local-first-two-plane.md` (presence 的平面划分按「来源」) for why.
   */
  private readonly localOriginStore = new EphemeralStore(LODY_PRESENCE_TTL_MS);
  // Streams sink is optional and attached only when the remote bridge connects;
  // presence production (store + heartbeat) runs regardless, so local-first
  // renderers can read it over the local data plane while offline.
  private transport: EphemeralStreamCrdt | null = null;
  private readonly machineTimer: NodeJS.Timeout;
  private readonly localOriginChangeListeners = new Set<() => void>();
  private subscription: EphemeralStreamSubscription | null = null;
  private machineId: MachineId | null = null;
  private machineKey: string | null = null;
  private readonly sessionKeys = new Map<SessionId, string>();
  private machineHeartbeatSeq = 0;
  /**
   * The one outstanding heartbeat whose delivery age is being measured, or null.
   * See {@link observeHeartbeatDelivery}.
   */
  private heartbeatDeliveryProbe: { seq: number; enqueuedAtMs: number } | null = null;
  private sessionPresenceSeq = 0;
  private started = false;
  private stopped = false;
  private joinRetryTimer: NodeJS.Timeout | null = null;
  private rejoinTimer: NodeJS.Timeout | null = null;
  private rejoinBackoffIndex = 0;
  private joinedOnce = false;
  private joinedWaiters: Array<(joined: boolean) => void> = [];

  constructor(private readonly options: CliPresenceRuntimeOptions) {
    this.machineTimer = setInterval(() => {
      this.writeMachineHeartbeat();
    }, LODY_PRESENCE_HEARTBEAT_MS);
    this.machineTimer.unref?.();
  }

  /**
   * Subscribe to this process's OWN presence writes (drives the local
   * data-plane push). Peer updates arriving from the presence room never fire
   * it — they are not this plane's payload.
   */
  subscribeLocalOriginPresence(listener: () => void): () => void {
    this.localOriginChangeListeners.add(listener);
    return () => this.localOriginChangeListeners.delete(listener);
  }

  /** Snapshot of this process's OWN presence entries, for the local data plane. */
  encodeLocalOriginPresence(): Uint8Array {
    return this.localOriginStore.encodeAll();
  }

  private notifyLocalOriginChange(): void {
    for (const listener of this.localOriginChangeListeners) {
      listener();
    }
  }

  /**
   * Single write path for locally-authored presence: keeps the workspace
   * replica and the local-origin view from ever diverging, and is the only
   * place that announces a local-plane push.
   *
   * Every call queues one serial POST on the workspace's SHARED presence
   * transport, ahead of the machine heartbeat, with no coalescing and no queue
   * bound. Callers must therefore be driven by a timer, a lifecycle transition,
   * or a user navigation — never by a stream/progress/chunk callback. A burst
   * here makes this machine read offline even though the room stays `joined`.
   * Bounds: `specs/loro-ephemeral-presence-channel.md`.
   */
  private writeLocalOrigin(key: string, state: LodyPresenceState): void {
    this.store.set(key, state as unknown as Value);
    this.localOriginStore.set(key, state as unknown as Value);
    this.notifyLocalOriginChange();
  }

  /** Single delete path for locally-authored presence (see {@link writeLocalOrigin}). */
  private deleteLocalOrigin(key: string): void {
    this.store.delete(key);
    this.localOriginStore.delete(key);
    this.notifyLocalOriginChange();
  }

  /**
   * Attach the cloud Streams sink (idempotent). Presence keeps being produced
   * locally without this; attaching only additionally mirrors it to the cloud
   * presence stream once the remote bridge is online.
   */
  attachStreams(streamsOptions: CliPresenceStreamsOptions): void {
    if (this.stopped || this.transport) return;
    const durableStreamUrl = createLoroStreamUrl({
      bucketId: LORO_STREAMS_BUCKET_ID,
      streamId: getLoroMetaStreamId(this.options.workspaceId),
      baseUrl: getLoroStreamsPresenceBaseUrl(
        streamsOptions.streamsBaseUrl,
        undefined,
        streamsOptions.shardHostSuffix
      ),
    });
    this.transport = new EphemeralStreamCrdt({
      streamUrl: toLodyPresenceStreamUrl(durableStreamUrl),
      auth: streamsOptions.auth,
      adaptor: EphemeralStoreAdaptor(this.store),
    });
    if (this.started) {
      return;
    }
    this.started = true;
    this.options.logger.debug(`[${this.options.workspaceId}] Joining Loro presence room`);
    void this.joinWithRetry(0);
  }

  private async joinWithRetry(attempt: number): Promise<void> {
    const transport = this.transport;
    if (!transport) return;
    let failure: unknown;
    try {
      const result = await transport.join({
        onStatusChange: (status) => {
          if (this.transport === transport) {
            this.handleRoomStatus(status);
          }
        },
      });
      if (this.stopped || this.transport !== transport) {
        if (result.ok) result.value.unsubscribe();
        return;
      }
      if (result.ok) {
        this.subscription = result.value;
        this.options.logger.debug(
          `[${this.options.workspaceId}] Loro presence subscription established`
        );
        return;
      }
      failure = result.error;
    } catch (error) {
      if (this.stopped || this.transport !== transport) return;
      failure = error;
    }
    const delayMs =
      JOIN_RETRY_DELAYS_MS[Math.min(attempt, JOIN_RETRY_DELAYS_MS.length - 1)] ?? 30_000;
    this.options.logger.warn(
      `[${this.options.workspaceId}] Failed to join Loro presence room (attempt=${attempt + 1}); retrying in ${delayMs}ms: ${formatErrorMessage(
        failure
      )}`
    );
    this.joinRetryTimer = setTimeout(() => {
      this.joinRetryTimer = null;
      void this.joinWithRetry(attempt + 1);
    }, delayMs);
    this.joinRetryTimer.unref?.();
  }

  private handleRoomStatus(status: string): void {
    this.options.logger.debug(`[${this.options.workspaceId}] Loro presence room status: ${status}`);
    if (this.stopped) return;
    if (status === 'joined') {
      this.rejoinBackoffIndex = 0;
      this.resolveJoinedWaiters(true);
      // Presence writes are idempotent, while the server may have lost its
      // ephemeral state during any reconnect. Reassert on every joined edge.
      this.republishLocalState();
      return;
    }
    // The transport retries retriable failures internally; `error` and
    // `disconnected` are terminal for its read loop and need an explicit
    // rejoin, otherwise presence silently stops flowing for the rest of the
    // process lifetime.
    if (status === 'error' || status === 'disconnected') {
      this.scheduleRejoin();
    }
  }

  private scheduleRejoin(): void {
    if (this.stopped || this.rejoinTimer) return;
    const delayMs =
      REJOIN_DELAYS_MS[Math.min(this.rejoinBackoffIndex, REJOIN_DELAYS_MS.length - 1)] ?? 60_000;
    this.rejoinBackoffIndex += 1;
    this.rejoinTimer = setTimeout(() => {
      this.rejoinTimer = null;
      if (this.stopped || !this.transport) return;
      this.options.logger.warn(
        `[${this.options.workspaceId}] Loro presence room in terminal state; rejoining`
      );
      this.transport.rejoin();
    }, delayMs);
    this.rejoinTimer.unref?.();
  }

  /** Re-broadcast machine + session presence after the room recovered. */
  private republishLocalState(): void {
    if (this.stopped) return;
    if (this.machineKey) {
      this.writeMachineHeartbeat();
    }
    let republished = 0;
    for (const key of this.sessionKeys.values()) {
      const state = this.localOriginStore.get(key) as LodySessionPresenceState | undefined;
      if (!state) continue;
      this.writeLocalOrigin(key, { ...state, updatedAt: getServerNow() });
      republished += 1;
    }
    if (republished > 0) {
      this.options.logger.debug(
        `[${this.options.workspaceId}] Republished ${republished} session presence entr${republished === 1 ? 'y' : 'ies'} after presence room recovery`
      );
    }
  }

  private resolveJoinedWaiters(joined: boolean): void {
    if (joined) {
      this.joinedOnce = true;
    }
    const waiters = this.joinedWaiters;
    this.joinedWaiters = [];
    for (const waiter of waiters) {
      waiter(joined);
    }
  }

  /**
   * Resolves true once the remote presence room has applied its initial
   * bootstrap. Local-only presence production does not satisfy this boundary.
   */
  waitUntilJoined(timeoutMs: number): Promise<boolean> {
    if (this.joinedOnce && this.transport) return Promise.resolve(true);
    if (this.stopped || !this.transport) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
      this.joinedWaiters.push((joined) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(joined);
      });
    });
  }

  /** Current presence snapshot (local writes + remote peers, TTL-pruned). */
  getPresenceStates(): LodyPresenceStateMap {
    return parseLodyPresenceStates(this.store.getAllStates() as Record<string, unknown>);
  }

  /**
   * Detach the cloud Streams sink but keep producing presence locally (the
   * remote bridge went offline / was revoked). A later `attachStreams` re-joins.
   */
  async detachStreams(): Promise<void> {
    if (this.stopped || !this.transport) return;
    if (this.joinRetryTimer) {
      clearTimeout(this.joinRetryTimer);
      this.joinRetryTimer = null;
    }
    if (this.rejoinTimer) {
      clearTimeout(this.rejoinTimer);
      this.rejoinTimer = null;
    }
    this.subscription?.unsubscribe();
    this.subscription = null;
    const transport = this.transport;
    this.transport = null;
    this.started = false;
    this.joinedOnce = false;
    this.resolveJoinedWaiters(false);
    this.rejoinBackoffIndex = 0;
    await transport.close();
  }

  /**
   * Subscribe to parsed presence snapshots. Fires on any store change (remote
   * peer updates and our own local writes alike).
   */
  subscribe(listener: (states: LodyPresenceStateMap) => void): () => void {
    return this.store.subscribe(() => {
      listener(this.getPresenceStates());
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.resolveJoinedWaiters(false);
    clearInterval(this.machineTimer);
    if (this.joinRetryTimer) {
      clearTimeout(this.joinRetryTimer);
      this.joinRetryTimer = null;
    }
    if (this.rejoinTimer) {
      clearTimeout(this.rejoinTimer);
      this.rejoinTimer = null;
    }
    this.clearMachinePresence();
    for (const sessionId of Array.from(this.sessionKeys.keys())) {
      this.clearSessionPresence(sessionId);
    }
    this.subscription?.unsubscribe();
    this.subscription = null;
    this.localOriginChangeListeners.clear();
    await this.transport?.close();
    this.transport = null;
    this.store.destroy();
    this.localOriginStore.destroy();
  }

  setMachineOnline(machineId: MachineId): void {
    if (this.stopped) return;
    this.machineId = machineId;
    this.machineKey = getLodyMachinePresenceKey(machineId, this.instanceId);
    this.writeMachineHeartbeat();
  }

  writeMachineHeartbeat(): void {
    if (this.stopped || !this.machineId || !this.machineKey) return;
    const seq = ++this.machineHeartbeatSeq;
    const state: LodyMachinePresenceState = {
      kind: 'machine',
      machineId: this.machineId,
      instanceId: this.instanceId,
      updatedAt: getServerNow(),
    };
    this.writeLocalOrigin(this.machineKey, state);
    this.options.logger.debug(
      `[${this.options.workspaceId}] Loro presence machine heartbeat written (seq=${seq} updatedAt=${state.updatedAt})${this.describePresenceWriteQueue()}`
    );
    this.observeHeartbeatDelivery(seq, state.updatedAt);
  }

  /**
   * Content-free snapshot of the SHARED presence write queue: counts, ages, a room
   * status and an error code. Never a presence value, key, or machine identity.
   *
   * Empty while no transport is attached, because there is then no queue to describe.
   */
  private describePresenceWriteQueue(): string {
    const subscription = this.subscription;
    if (!subscription) return '';
    const parts = [`queued=${subscription.pendingLocalCount}`, `room=${subscription.status}`];
    const { lastLocalAppendAtMs } = subscription;
    if (lastLocalAppendAtMs !== undefined) {
      // Documented as a `Date.now()` stamp, so it is compared against the local wall
      // clock rather than the server-corrected `getServerNow()` used for `updatedAt`.
      parts.push(`sinceLastAppendMs=${Math.max(0, Date.now() - lastLocalAppendAtMs)}`);
    }
    const { lastWriteError } = subscription;
    if (lastWriteError) {
      // Only the write path clears this, so it explains a non-zero queue even when the
      // read side is healthy and the room still reports `joined`.
      parts.push(
        `writeError=${lastWriteError.code}`,
        `writeErrorRetryable=${lastWriteError.retryable}`
      );
    }
    const unacked = this.heartbeatDeliveryProbe;
    if (unacked) {
      parts.push(
        `unackedHeartbeatSeq=${unacked.seq}`,
        `unackedForMs=${Math.max(0, getServerNow() - unacked.enqueuedAtMs)}`
      );
    }
    return ` ${parts.join(' ')}`;
  }

  /**
   * Records how old the machine heartbeat already is when it actually leaves this
   * process.
   *
   * The line above proves only a LOCAL store write. The presence queue is serial,
   * shared with every other presence writer in this workspace, and unbounded, so a
   * heartbeat can sit behind a backlog; its `updatedAt` is stamped at enqueue and never
   * refreshed, so a delayed one arrives ALREADY past {@link LODY_PRESENCE_TTL_MS}.
   * Readers receive it and still report this machine offline, while the room keeps
   * reporting `joined` and no error is raised anywhere. Nothing else in this runtime
   * observes that, which is why the incident behind
   * `specs/loro-ephemeral-presence-channel.md` could not be diagnosed from logs.
   *
   * One probe at a time: a probe per heartbeat would itself grow with the backlog it
   * measures. A probe that never settles IS the signal — every later heartbeat reports
   * its age through {@link describePresenceWriteQueue}.
   */
  private observeHeartbeatDelivery(seq: number, enqueuedAtMs: number): void {
    const subscription = this.subscription;
    if (!subscription || this.heartbeatDeliveryProbe) return;
    // The heartbeat just enqueued is itself pending, so anything else is ahead of it.
    const queuedAhead = Math.max(0, subscription.pendingLocalCount - 1);
    const probe = { seq, enqueuedAtMs };
    this.heartbeatDeliveryProbe = probe;
    void subscription
      .waitUntilSynced()
      .then(() => {
        const ageAtSendMs = Math.max(0, getServerNow() - enqueuedAtMs);
        const detail = `[${this.options.workspaceId}] Loro presence machine heartbeat delivered (seq=${seq} queuedAhead=${queuedAhead} ageAtSendMs=${ageAtSendMs})`;
        if (ageAtSendMs >= LODY_PRESENCE_TTL_MS) {
          this.options.logger.warn(
            `${detail}: older than the ${LODY_PRESENCE_TTL_MS}ms freshness window on arrival, so readers still report this machine offline`
          );
          return;
        }
        this.options.logger.debug(detail);
      })
      .catch((error: unknown) => {
        this.options.logger.debug(
          `[${this.options.workspaceId}] Loro presence machine heartbeat delivery unobserved (seq=${seq} queuedAhead=${queuedAhead}): ${formatErrorMessage(error)}`
        );
      })
      .finally(() => {
        if (this.heartbeatDeliveryProbe === probe) {
          this.heartbeatDeliveryProbe = null;
        }
      });
  }

  setSessionPresence(args: {
    sessionId: SessionId;
    machineId: MachineId | undefined;
    status: SessionStatus | undefined;
  }): void {
    if (this.stopped) return;
    if (!args.status || args.status.type === 'idle') {
      this.clearSessionPresence(args.sessionId);
      return;
    }
    // Session meta may not have synced yet (fast-path dispatch, fresh
    // sessions); presence is only ever published by the executing machine, so
    // the local machine identity is the correct fallback.
    const machineId = args.machineId ?? this.machineId;
    if (!machineId) {
      this.options.logger.debug(
        `[${this.options.workspaceId}] Skipped session presence write: machineId unknown (session=${args.sessionId})`
      );
      return;
    }
    const key = getLodySessionPresenceKey(args.sessionId, this.instanceId);
    this.sessionKeys.set(args.sessionId, key);
    const seq = ++this.sessionPresenceSeq;
    const state: LodySessionPresenceState = {
      kind: 'session',
      sessionId: args.sessionId,
      machineId,
      instanceId: this.instanceId,
      status: args.status,
      updatedAt: getServerNow(),
    };
    this.writeLocalOrigin(key, state);
    this.options.logger.debug(
      `[${this.options.workspaceId}] Loro presence session heartbeat written (session=${args.sessionId} status=${args.status.type} seq=${seq})`
    );
  }

  clearSessionPresence(sessionId: SessionId): void {
    const key = this.sessionKeys.get(sessionId);
    if (!key) return;
    this.sessionKeys.delete(sessionId);
    this.deleteLocalOrigin(key);
    this.options.logger.debug(
      `[${this.options.workspaceId}] Loro presence session entry cleared (session=${sessionId})`
    );
  }

  private clearMachinePresence(): void {
    if (!this.machineKey) return;
    this.deleteLocalOrigin(this.machineKey);
    this.machineKey = null;
    this.machineId = null;
  }
}
