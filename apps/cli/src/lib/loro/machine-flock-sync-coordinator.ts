import { getMachineFlockDocId, type MachineId, type WorkspaceId } from '@lody/shared';
import type { LoroRepo, RepoTransportRoomStatus, TransportSubscription } from 'loro-repo';

import { formatErrorMessage } from '@/utils/format-error';
import type { Logger } from '@/utils/logger';

import { computeLoroReconnectDelayMs } from './connection-recovery';
import {
  isRecoverableStreamsRoomStatus,
  streamsRoomBinding,
  type StreamsRoomBinding,
} from './streams-room-binding';
import { readTimeoutEnv, withTimeout } from './timeout-utils';

type MachineFlockSyncState = {
  machineId: MachineId;
  docId: string;
  dirty: boolean;
  dirtyVersion: number;
  retryAttempt: number;
  retryTimer: NodeJS.Timeout | null;
  activeSync: Promise<boolean> | null;
  joinPromise: Promise<void> | null;
  roomSub: TransportSubscription | null;
  // Detached-aware 'streams' binding view of `roomSub`; all status reads and
  // first-sync waits go through it, never the classic surface (which hides
  // 'detached' behind 'disconnected' and would rejoin-spin while offline).
  roomBinding: StreamsRoomBinding | null;
  detachRoomStatusListener: (() => void) | null;
};

export type MachineFlockSyncCoordinatorOptions = {
  repo: LoroRepo;
  workspaceId: WorkspaceId;
  logger: Logger;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  random?: () => number;
};

export type MachineFlockSyncRequestOptions = {
  reason?: string;
  timeoutMs?: number;
  scheduleRetry?: boolean;
  resetBackoff?: boolean;
};

// The dirty flag plus the meta-room-synced retry pick the doc up on re-attach,
// which is why 'detached' must stay non-recoverable here too.
const isRecoverableMachineFlockRoomStatus = isRecoverableStreamsRoomStatus;

export class MachineFlockSyncCoordinator {
  private readonly repo: LoroRepo;
  private readonly workspaceId: WorkspaceId;
  private readonly logger: Logger;
  private readonly random: () => number;
  private readonly retryBaseDelayMs?: number;
  private readonly retryMaxDelayMs?: number;
  private readonly states = new Map<MachineId, MachineFlockSyncState>();
  private cleanedUp = false;

  constructor(options: MachineFlockSyncCoordinatorOptions) {
    this.repo = options.repo;
    this.workspaceId = options.workspaceId;
    this.logger = options.logger;
    this.random = options.random ?? Math.random;
    this.retryBaseDelayMs = options.retryBaseDelayMs;
    this.retryMaxDelayMs = options.retryMaxDelayMs;
  }

  ensureJoined(machineId: MachineId, options: { reason?: string } = {}): Promise<void> {
    const state = this.getState(machineId);
    return this.ensureStateJoined(state, options.reason ?? 'ensure-joined');
  }

  markDirty(machineId: MachineId, options: MachineFlockSyncRequestOptions = {}): void {
    if (this.cleanedUp) {
      return;
    }

    const state = this.getState(machineId);
    state.dirty = true;
    state.dirtyVersion += 1;
    if (options.resetBackoff) {
      state.retryAttempt = 0;
    }

    const reason = options.reason ?? 'dirty';
    void this.ensureStateJoined(state, `dirty:${reason}`).catch((error: unknown) => {
      this.logger.debug(
        `[${this.workspaceId}] Machine Flock room join failed before background sync (machine=${machineId} reason=${reason}): ${formatErrorMessage(
          error
        )}`
      );
    });
    void this.syncNow(machineId, {
      ...options,
      reason,
      scheduleRetry: options.scheduleRetry ?? true,
    });
  }

  async syncNow(
    machineId: MachineId,
    options: MachineFlockSyncRequestOptions = {}
  ): Promise<boolean> {
    if (this.cleanedUp) {
      return false;
    }

    const state = this.getState(machineId);
    if (state.activeSync) {
      return await state.activeSync;
    }

    state.activeSync = this.syncStateNow(state, options).finally(() => {
      state.activeSync = null;
    });
    return await state.activeSync;
  }

  retryDirtyNow(reason: string): void {
    if (this.cleanedUp) {
      return;
    }

    for (const state of this.states.values()) {
      if (!state.dirty) {
        continue;
      }
      this.clearRetryTimer(state);
      state.retryAttempt = 0;
      void this.syncNow(state.machineId, {
        reason,
        scheduleRetry: true,
        resetBackoff: true,
      });
    }
  }

  async cleanUp(): Promise<void> {
    this.cleanedUp = true;
    const pendingOperations: Promise<unknown>[] = [];
    for (const state of this.states.values()) {
      this.clearRetryTimer(state);
      if (state.activeSync) {
        pendingOperations.push(state.activeSync);
      }
      if (state.joinPromise) {
        pendingOperations.push(state.joinPromise);
      }
      this.releaseRoomSubscription(state);
    }
    await Promise.allSettled(pendingOperations);
    this.states.clear();
  }

  private async syncStateNow(
    state: MachineFlockSyncState,
    options: MachineFlockSyncRequestOptions
  ): Promise<boolean> {
    const reason = options.reason ?? 'sync-now';
    if (options.resetBackoff) {
      state.retryAttempt = 0;
    }
    this.clearRetryTimer(state);

    try {
      await this.ensureStateJoined(state, `sync:${reason}`);
    } catch (error) {
      this.logger.debug(
        `[${this.workspaceId}] Machine Flock room join failed before sync (machine=${state.machineId} reason=${reason}): ${formatErrorMessage(
          error
        )}`
      );
    }

    const syncVersion = state.dirtyVersion;
    const timeoutMs =
      options.timeoutMs ?? readTimeoutEnv('LODY_LORO_SYNC_MACHINE_FLOCK_TIMEOUT_MS', 8_000);
    const timeoutMessage = `Timeout waiting for machine Flock doc sync (doc=${state.docId})`;

    try {
      const handle = await this.repo.openFlockDoc(state.docId);
      const report = await withTimeout(handle.syncOnce(), timeoutMs, timeoutMessage);
      // A resolved syncOnce is only a durable cloud confirmation when at least
      // one transport actually attempted and succeeded. With ZERO transports
      // (offline, nothing attached) it resolves vacuously — the doc must stay
      // dirty so the meta-room-synced retry pushes it after re-attach.
      const confirmed = report.transports.length > 0 && report.ok;
      if (!confirmed) {
        this.logger.debug(
          `[${this.workspaceId}] Machine Flock doc sync resolved without transport confirmation (machine=${state.machineId} reason=${reason} transports=${report.transports.length})`
        );
        // Two different non-confirmations, and only one of them is worth
        // retrying on a timer. ZERO attempted transports means the daemon is
        // deliberately offline: a backoff retry would re-attempt every dirty
        // doc forever (capped at 60s) for nothing, which is the same spin the
        // room-status guard above refuses and the reason the code-collab
        // publisher stays ungated. Stay dirty and let `retryDirtyNow` on
        // meta-room-synced push it the moment a transport attaches.
        const attempted = report.transports.length > 0;
        state.dirty = true;
        if (attempted && (options.scheduleRetry ?? true)) {
          this.scheduleRetry(state, reason, false);
        }
        return false;
      }
      if (state.dirtyVersion === syncVersion) {
        state.dirty = false;
        state.retryAttempt = 0;
      } else if (state.dirty) {
        this.scheduleRetry(state, `${reason}:new-writes`, true);
      }
      this.logger.debug(
        `[${this.workspaceId}] Machine Flock doc synced (machine=${state.machineId} reason=${reason})`
      );
      return true;
    } catch (error) {
      this.logger.debug(
        `[${this.workspaceId}] Machine Flock doc sync was not confirmed before continuing (machine=${state.machineId} reason=${reason}): ${formatErrorMessage(
          error
        )}`
      );
      if (options.scheduleRetry ?? true) {
        state.dirty = true;
        this.scheduleRetry(state, reason, false);
      }
      return false;
    }
  }

  private async ensureStateJoined(state: MachineFlockSyncState, reason: string): Promise<void> {
    if (this.cleanedUp) {
      return;
    }
    if (state.roomSub) {
      if (!isRecoverableMachineFlockRoomStatus(state.roomBinding?.status ?? null)) {
        return;
      }
      this.releaseRoomSubscription(state, state.roomSub);
    }
    if (state.joinPromise) {
      return await state.joinPromise;
    }

    state.joinPromise = (async () => {
      const handle = await this.repo.openFlockDoc(state.docId);
      const sub = await handle.joinRoom();
      if (this.cleanedUp) {
        sub.unsubscribe();
        return;
      }
      const binding = streamsRoomBinding(sub);
      state.roomSub = sub;
      state.roomBinding = binding;
      state.detachRoomStatusListener = binding.onStatusChange((status) => {
        this.handleRoomStatusChange(state, sub, status);
      });
      this.handleRoomStatusChange(state, sub, binding.status);
      if (state.roomSub !== sub) {
        return;
      }
      void binding.firstSyncedWithRemote.then(
        () => {
          if (this.cleanedUp || state.roomSub !== sub) {
            return;
          }
          this.logger.debug(
            `[${this.workspaceId}] Machine Flock room first sync completed (machine=${state.machineId} reason=${reason})`
          );
        },
        (error: unknown) => {
          if (this.cleanedUp || state.roomSub !== sub) {
            return;
          }
          this.logger.debug(
            `[${this.workspaceId}] Machine Flock room first sync failed (machine=${state.machineId} reason=${reason}): ${formatErrorMessage(
              error
            )}`
          );
        }
      );
    })();

    try {
      await state.joinPromise;
    } finally {
      state.joinPromise = null;
    }
  }

  private handleRoomStatusChange(
    state: MachineFlockSyncState,
    sub: TransportSubscription,
    // Runtime statuses come from a RepoRoomSubscription and include 'detached'
    // even though the classic listener type does not name it.
    status: RepoTransportRoomStatus
  ): void {
    if (this.cleanedUp || state.roomSub !== sub) {
      return;
    }
    if (!isRecoverableMachineFlockRoomStatus(status)) {
      return;
    }

    this.logger.debug(
      `[${this.workspaceId}] Machine Flock room became ${status}; will rejoin before the next sync (machine=${state.machineId})`
    );
    this.releaseRoomSubscription(state, sub);
    if (state.dirty) {
      this.scheduleRetry(state, `room-${status}`, false);
    }
  }

  private releaseRoomSubscription(
    state: MachineFlockSyncState,
    sub: TransportSubscription | null = state.roomSub
  ): void {
    if (!sub || state.roomSub !== sub) {
      return;
    }

    state.detachRoomStatusListener?.();
    state.detachRoomStatusListener = null;
    state.roomSub = null;
    state.roomBinding = null;
    sub.unsubscribe();
  }

  private scheduleRetry(state: MachineFlockSyncState, reason: string, resetBackoff: boolean): void {
    if (this.cleanedUp || !state.dirty) {
      return;
    }
    if (resetBackoff) {
      state.retryAttempt = 0;
    }
    if (state.retryTimer) {
      return;
    }

    const delayMs = computeLoroReconnectDelayMs(state.retryAttempt, {
      baseDelayMs:
        this.retryBaseDelayMs ??
        readTimeoutEnv('LODY_LORO_MACHINE_FLOCK_RETRY_BASE_DELAY_MS', 1_000),
      maxDelayMs:
        this.retryMaxDelayMs ??
        readTimeoutEnv('LODY_LORO_MACHINE_FLOCK_RETRY_MAX_DELAY_MS', 60_000),
      random: this.random,
    });
    state.retryAttempt += 1;
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      if (this.cleanedUp || !state.dirty) {
        return;
      }
      void this.syncNow(state.machineId, {
        reason: `retry:${reason}`,
        scheduleRetry: true,
      });
    }, delayMs);
    this.logger.debug(
      `[${this.workspaceId}] Scheduled Machine Flock doc sync retry in ${delayMs}ms (machine=${state.machineId} reason=${reason})`
    );
  }

  private clearRetryTimer(state: MachineFlockSyncState): void {
    if (!state.retryTimer) {
      return;
    }
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }

  private getState(machineId: MachineId): MachineFlockSyncState {
    const existing = this.states.get(machineId);
    if (existing) {
      return existing;
    }

    const state: MachineFlockSyncState = {
      machineId,
      docId: getMachineFlockDocId(this.workspaceId, machineId),
      dirty: false,
      dirtyVersion: 0,
      retryAttempt: 0,
      retryTimer: null,
      activeSync: null,
      joinPromise: null,
      roomSub: null,
      roomBinding: null,
      detachRoomStatusListener: null,
    };
    this.states.set(machineId, state);
    return state;
  }
}
