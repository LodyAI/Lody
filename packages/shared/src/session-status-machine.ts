import type {
  InitializingStage,
  SessionRunningActivity,
  SessionStatus,
  SessionStatusType,
} from './schema';
import { getServerNow } from './time-sync';

/**
 * Session status state machine (shared by CLI + Web).
 *
 * Core states:
 * - idle: waiting for user input
 * - running: agent processing turn (heartbeat-driven)
 * - requestPermission: waiting for user permission response
 * - initializing: session setup/resume
 *
 * See specs/session-status.md for full design.
 *
 * State diagram:
 *
 *                    ┌──────────────────┐
 *                    │  initializing    │
 *                    └────────┬─────────┘
 *                             │ init complete
 *                             v
 *                    ┌──────────────────┐
 *          ┌────────>│      idle        │<────────┐
 *          │         └────────┬─────────┘         │
 *          │                  │ user sends        │
 *          │                  │ message           │
 *          │                  v                   │
 *          │         ┌──────────────────┐         │
 *          │         │     running      │─────────┘
 *          │         └────────┬─────────┘  turn complete /
 *          │                  │            heartbeat timeout
 *          │                  │
 *          │   resume/new     │
 *          └──────────────────┘
 */

export const SessionStatusFactory = {
  idle(): SessionStatus {
    return { type: 'idle' };
  },
  running(activity?: SessionRunningActivity): SessionStatus {
    return activity ? { type: 'running', activity } : { type: 'running' };
  },
  requestPermission(): SessionStatus {
    return { type: 'requestPermission' };
  },
  initializing(stage?: InitializingStage, detail?: string): SessionStatus {
    // Never emit undefined-valued keys: Loro values cannot represent
    // `undefined` and round-trip them as null, which breaks strict schema
    // consumers (see ActiveSessionStatusSchema in presence.ts).
    return {
      type: 'initializing',
      ...(stage !== undefined ? { stage } : {}),
      ...(detail !== undefined ? { detail } : {}),
    };
  },
} as const;

/**
 * Check if a session is actively processing (running/requestPermission/initializing).
 * Used to determine if heartbeat should be sent.
 *
 * Note: This does NOT check heartbeat TTL. Web live UI should read session
 * presence instead of durable SessionMeta status.
 */
export const isActiveSessionStatus = (status: SessionStatus | undefined): boolean => {
  if (status == null) {
    return false;
  }
  return (
    status.type === 'running' ||
    status.type === 'requestPermission' ||
    status.type === 'initializing'
  );
};

/**
 * Default TTL for heartbeat in milliseconds.
 * If no heartbeat is received within this time, the entity is considered stale/offline.
 */
export const HEARTBEAT_TTL_MS = 180_000;

/**
 * Alias for backward compatibility.
 * @deprecated Use HEARTBEAT_TTL_MS instead
 */
export const SESSION_HEARTBEAT_TTL_MS = HEARTBEAT_TTL_MS;

/**
 * Check if a session is actively processing AND has a recent durable heartbeat.
 * Web live UI should use session presence instead; this remains for legacy and
 * non-presence callers.
 *
 * Uses server-synchronized time to ensure consistent detection across clients.
 *
 * @param status - The session status
 * @param lastRunningSeen - The timestamp of the last heartbeat (from SessionMeta.lastRunningSeen)
 * @param ttlMs - Optional TTL in milliseconds (defaults to SESSION_HEARTBEAT_TTL_MS)
 * @returns true if status is active AND heartbeat is within TTL, false otherwise
 */
export const isSessionActiveWithHeartbeat = (
  status: SessionStatus | undefined,
  lastRunningSeen: number | undefined,
  ttlMs: number = SESSION_HEARTBEAT_TTL_MS
): boolean => {
  if (!isActiveSessionStatus(status)) {
    return false;
  }

  // If no heartbeat timestamp, treat as stale (session may be from before heartbeat was added)
  if (lastRunningSeen == null || !Number.isFinite(lastRunningSeen)) {
    return false;
  }

  const nowMs = getServerNow();
  const elapsedMs = nowMs - lastRunningSeen;
  return elapsedMs < ttlMs;
};

/**
 * Re-export SessionStatusType from schema for convenience.
 */
export type { SessionStatusType };
