import {
  hasPendingUserTurnActivation,
  scheduleOwnSessionId,
  type MachineId,
  type ScheduleRegistryRow,
  type SessionId,
  type SessionLiveStatusResponse,
  type SessionMeta,
  type SessionStatus,
} from '@lody/shared';
import type { RoomSyncState } from '@/lib/room-sync-state';
import { UNSTARTED_TRAILING_USER_TURN_TIMEOUT_MS } from '@/lib/session-dispatch-state';

/** Bounded wait for live-status RPC so clicking Run now never hangs on an unreachable host. */
export const SCHEDULE_RUN_LIVE_STATUS_TIMEOUT_MS = 3_000;

export type BoundScheduleSessionTarget = {
  sessionId: SessionId;
  kind: 'existing_session' | 'own_session';
};

export type BoundSessionLocalSnapshot = {
  /** Fresh ephemeral session presence (`running` / `requestPermission` / `initializing`), or null. */
  liveStatus: SessionStatus | null;
  /** Ephemeral presence transport health. Absence of presence is only meaningful when `'synced'`. */
  presenceSyncState: RoomSyncState;
  /** Whether the target machine has a fresh presence heartbeat. */
  machineOnline: boolean;
  /** Durable SessionMeta from the catalog, if currently loaded. */
  sessionMeta?: SessionMeta;
  /** Server-synchronized clock timestamp in ms. */
  nowMs: number;
};

export type BoundSessionRunCheckResult =
  | { state: 'idle' }
  | {
      state: 'busy';
      source: 'presence' | 'rpc' | 'pointer';
      detail?: 'running' | 'initializing' | 'waiting';
    }
  | {
      state: 'unknown';
      reason: 'machine_offline' | 'presence_unsynced' | 'rpc_failed';
      error?: string;
    };

/**
 * Resolve the single chat a schedule runs into when it must be checked before a
 * manual Run now, or `undefined` when Run now creates a fresh chat (or an
 * uncreated `own_session` chat with no live activity).
 */
export function resolveScheduleBoundSessionTarget(
  row: Pick<ScheduleRegistryRow, 'scheduleId' | 'destination'>,
  lookup: {
    hasSession: (sessionId: SessionId) => boolean;
    hasLiveStatus?: (sessionId: SessionId) => boolean;
  }
): BoundScheduleSessionTarget | undefined {
  if (row.destination.kind === 'existing_session') {
    return {
      sessionId: row.destination.sessionId as SessionId,
      kind: 'existing_session',
    };
  }
  if (row.destination.kind === 'own_session') {
    const sessionId = scheduleOwnSessionId(row.scheduleId, row.destination.epoch);
    if (lookup.hasSession(sessionId) || lookup.hasLiveStatus?.(sessionId)) {
      return { sessionId, kind: 'own_session' };
    }
    return undefined;
  }
  return undefined;
}

function hasFreshPendingPointer(snapshot: BoundSessionLocalSnapshot): boolean {
  const meta = snapshot.sessionMeta;
  if (!meta || !hasPendingUserTurnActivation(meta)) return false;
  const dispatchedAtMs = meta.lastMessageAt ?? Date.parse(meta.createdAt);
  return (
    Number.isFinite(dispatchedAtMs) &&
    snapshot.nowMs - dispatchedAtMs < UNSTARTED_TRAILING_USER_TURN_TIMEOUT_MS
  );
}

function presenceDetail(status: SessionStatus): 'running' | 'initializing' | 'waiting' | undefined {
  if (status.type === 'running') return 'running';
  if (status.type === 'initializing') return 'initializing';
  if (status.type === 'requestPermission') return 'waiting';
  return undefined;
}

export function classifyLocalBoundSessionBusy(
  snapshot: BoundSessionLocalSnapshot
): Extract<BoundSessionRunCheckResult, { state: 'busy' }> | null {
  if (snapshot.liveStatus != null) {
    return {
      state: 'busy',
      source: 'presence',
      detail: presenceDetail(snapshot.liveStatus),
    };
  }
  if (hasFreshPendingPointer(snapshot)) {
    return {
      state: 'busy',
      source: 'pointer',
      detail: 'initializing',
    };
  }
  return null;
}

/**
 * Inspect whether a schedule's bound session is currently busy before manual
 * Run now.
 *
 * Uses ephemeral live presence and fresh pending dispatch pointers first, then
 * queries the owning daemon's authoritative `session/live-status` RPC when the
 * target machine is reachable, and re-reads local state after the await to
 * close the check-to-dispatch race window.
 */
export async function inspectBoundSessionBeforeRun(args: {
  machineId: MachineId;
  sessionId: SessionId;
  getSnapshot: () => BoundSessionLocalSnapshot;
  requestLiveStatus?: (
    machineId: MachineId,
    sessionId: SessionId,
    options?: { timeoutMs?: number }
  ) => Promise<SessionLiveStatusResponse | null>;
  timeoutMs?: number;
}): Promise<BoundSessionRunCheckResult> {
  const initial = args.getSnapshot();
  const localBusy = classifyLocalBoundSessionBusy(initial);
  if (localBusy) return localBusy;

  if (initial.presenceSyncState === 'synced' && !initial.machineOnline) {
    return { state: 'unknown', reason: 'machine_offline' };
  }

  if (!args.requestLiveStatus) {
    if (initial.presenceSyncState === 'synced' && initial.machineOnline) {
      return { state: 'idle' };
    }
    return { state: 'unknown', reason: 'presence_unsynced' };
  }

  let response: SessionLiveStatusResponse | null = null;
  let rpcError: string | undefined;
  try {
    response = await args.requestLiveStatus(args.machineId, args.sessionId, {
      timeoutMs: args.timeoutMs ?? SCHEDULE_RUN_LIVE_STATUS_TIMEOUT_MS,
    });
  } catch (error) {
    rpcError = error instanceof Error ? error.message : String(error);
  }

  // Re-read the freshest local snapshot after the async RPC to catch a session
  // that flipped to busy while the status request was in flight.
  const latest = args.getSnapshot();
  const latestBusy = classifyLocalBoundSessionBusy(latest);
  if (latestBusy) return latestBusy;

  if (response?.success === true) {
    if (
      response.state === 'running' ||
      response.state === 'initializing' ||
      response.state === 'waiting'
    ) {
      return { state: 'busy', source: 'rpc', detail: response.state };
    }
    return { state: 'idle' };
  }

  return {
    state: 'unknown',
    reason: 'rpc_failed',
    error: rpcError ?? (response && !response.success ? response.error : undefined),
  };
}
