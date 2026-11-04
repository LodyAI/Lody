import type { SessionHistoryParsed } from '@lody/shared';
import type { DurationUnitLabels } from '@/lib/format-duration';
import { isSyncingRoomSyncState, type RoomSyncState } from '@/lib/room-sync-state';
import {
  resolveLiveSessionHistoryDurationMs,
  resolveSessionHistoryDurationMs,
} from '@/lib/session-history-duration';

/**
 * Silence on a live turn after which its "Last update" reads as a weak
 * warning: long enough that a token stream has clearly paused, short enough to
 * flag a stuck turn before the user gives up on it. A long command run can
 * cross it legitimately, so the warning says "may", never "stuck".
 */
export const TURN_LAST_UPDATE_STALE_MS = 60_000;

/** Silence after which the live status line itself says "no output for …". */
export const TURN_SILENCE_NOTICE_MS = 2 * 60_000;

/**
 * Changes stamped this soon after live sync (re)starts are treated as the
 * catch-up batch, not live output: a reconnect imports what was missed, and
 * its notifications can land just after the room reports `synced`.
 */
export const LIVE_SYNC_SETTLE_MS = 1_000;

/**
 * What the machine's presence says the session is doing — the same signal
 * as the live status line. `null` when nothing is running, including a turn
 * whose history was never finalized because its daemon went away.
 */
export type LiveTurnActivity = 'working' | 'awaitingUser';

/** Whether this client is receiving the session's history as it happens. */
export type HistoryLiveSync = 'live' | 'syncing' | 'offline';

/**
 * The live-sync state plus when it last became `live` (`null` while it is
 * not). Only changes stamped inside the current window count as live output.
 */
export type HistoryLiveWindow = { sync: HistoryLiveSync; since: number | null };

/**
 * The session room supplies the control-plane connection window. Roost history
 * arrives through owner checkpoint observation; room sync alone does not certify
 * that history is current.
 */
export const resolveHistoryLiveSync = (
  syncState: RoomSyncState,
  browserOnline: boolean
): HistoryLiveSync => {
  if (!browserOnline) return 'offline';
  if (syncState === 'synced') return 'live';
  return isSyncingRoomSyncState(syncState) ? 'syncing' : 'offline';
};

/**
 * What the popover can honestly say about a running turn's last update.
 * Only `updated` carries a time: it is reported only for a change this client
 * received while continuously in live sync, so a catch-up import after
 * opening, switching back or reconnecting never reads as fresh output.
 */
export type TurnLiveness =
  | { kind: 'offline' }
  | { kind: 'awaitingUser' }
  | { kind: 'syncing' }
  | { kind: 'noUpdateYet' }
  | { kind: 'updated'; sinceMs: number; stale: boolean };

export const resolveTurnLiveness = ({
  activity,
  sync,
  liveSince,
  lastUpdateAt,
  nowMs,
}: {
  activity: LiveTurnActivity;
  sync: HistoryLiveSync;
  /** When `sync` last became `live`; `null` while it is not. */
  liveSince: number | null;
  /** `ConversationView.lastUpdateAt`. */
  lastUpdateAt: number | null;
  nowMs: number;
}): TurnLiveness => {
  if (sync === 'offline') return { kind: 'offline' };
  if (activity === 'awaitingUser') return { kind: 'awaitingUser' };
  if (sync === 'syncing' || liveSince === null) return { kind: 'syncing' };
  if (lastUpdateAt === null || lastUpdateAt < liveSince + LIVE_SYNC_SETTLE_MS) {
    return { kind: 'noUpdateYet' };
  }
  const sinceMs = Math.max(0, nowMs - lastUpdateAt);
  return { kind: 'updated', sinceMs, stale: sinceMs >= TURN_LAST_UPDATE_STALE_MS };
};

export type AssistantTurnTimingMessage = Pick<
  SessionHistoryParsed,
  'timestamp' | 'startedAt' | 'endedAt' | 'permissionWaitMs'
>;

/**
 * Timing facts for the turn-configuration popover, in display order. Kept as
 * data so the clock and locale stay with the caller.
 *
 * - `started`: the turn's start; `runningMs` is set while the turn runs.
 * - `ended` / `duration`: a turn that is not running and recorded `endedAt`.
 *   `duration` is the same quantity as the "Worked for" label.
 * - `lastUpdate`: running turns only.
 */
export type AssistantTurnTimingRow =
  | { kind: 'started'; atMs: number; runningMs: number | null }
  | { kind: 'ended'; atMs: number }
  | { kind: 'duration'; durationMs: number }
  | { kind: 'lastUpdate'; liveness: TurnLiveness };

const finiteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** `startedAt` when recorded, else the turn's `timestamp` (older entries carry only that). */
export const resolveAssistantTurnStartMs = (message: AssistantTurnTimingMessage): number | null => {
  const startedAt = finiteNumber(message.startedAt);
  if (startedAt !== null) return startedAt;
  const parsed = Date.parse(message.timestamp);
  return Number.isFinite(parsed) ? parsed : null;
};

export const buildAssistantTurnTimingRows = (
  message: AssistantTurnTimingMessage,
  {
    liveness,
    nowMs,
  }: {
    /**
     * Set only while this is the newest unfinished turn AND presence says the
     * session is running. An unfinished turn nothing is running (its daemon
     * died before finalizing) gets neither a running time nor a last update.
     */
    liveness: TurnLiveness | null;
    nowMs: number;
  }
): AssistantTurnTimingRow[] => {
  const rows: AssistantTurnTimingRow[] = [];
  const startMs = resolveAssistantTurnStartMs(message);
  if (startMs !== null) {
    rows.push({
      kind: 'started',
      atMs: startMs,
      runningMs: liveness ? resolveLiveSessionHistoryDurationMs(message, nowMs) : null,
    });
  }
  if (liveness) {
    rows.push({ kind: 'lastUpdate', liveness });
    return rows;
  }
  const endedAt = finiteNumber(message.endedAt);
  if (endedAt === null) return rows;
  rows.push({ kind: 'ended', atMs: endedAt });
  const durationMs = resolveSessionHistoryDurationMs(message);
  if (durationMs !== null) rows.push({ kind: 'duration', durationMs });
  return rows;
};

/**
 * How long a working turn has gone without live output, once that reaches
 * {@link TURN_SILENCE_NOTICE_MS}; otherwise `null` — including while waiting on
 * the user, offline, or before any live update (no evidence either way).
 */
export const resolveTurnSilenceMs = (liveness: TurnLiveness): number | null =>
  liveness.kind === 'updated' && liveness.sinceMs >= TURN_SILENCE_NOTICE_MS
    ? liveness.sinceMs
    : null;

/** Whole minutes ("4m", "1h 05m"): a silence notice that ticks every second reads as noise. */
export const formatSilenceCompact = (durationMs: number, units: DurationUnitLabels): string => {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '';
  const sep = units.separator ?? ' ';
  const totalMinutes = Math.floor(durationMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) {
    return `${hours}${units.hour}${sep}${String(minutes).padStart(2, '0')}${units.minute}`;
  }
  return `${minutes}${units.minute}`;
};

const CLOCK_FORMATS = {
  time: { hour: '2-digit', minute: '2-digit', second: '2-digit' },
  monthDayTime: {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  },
  fullDateTime: {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  },
  full: { dateStyle: 'full', timeStyle: 'long' },
  /** `en-CA` renders this as `YYYY-MM-DD`: a comparable calendar-day key. */
  dayKey: { year: 'numeric', month: '2-digit', day: '2-digit' },
} satisfies Record<string, Intl.DateTimeFormatOptions>;

const clockFormatters = new Map<string, Intl.DateTimeFormat>();

const clockFormatter = (
  locale: string | undefined,
  kind: keyof typeof CLOCK_FORMATS,
  timeZone: string | undefined
): Intl.DateTimeFormat => {
  const key = `${locale ?? ''}|${kind}|${timeZone ?? ''}`;
  let formatter = clockFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { ...CLOCK_FORMATS[kind], timeZone });
    clockFormatters.set(key, formatter);
  }
  return formatter;
};

/** Calendar day of `ms` in `timeZone` (the runtime's local zone when omitted). */
const calendarDay = (ms: number, timeZone: string | undefined): string =>
  clockFormatter('en-CA', 'dayKey', timeZone).format(ms);

/**
 * A turn instant in the user's local time: seconds-precise because the popover
 * exists to judge liveness. Today's instants show the time alone; other days
 * add the date (and the year when it differs). `full` is the hover text,
 * including the weekday and time zone. `timeZone` exists for tests only.
 */
export const formatTurnClockTime = (
  ms: number,
  { locale, nowMs, timeZone }: { locale: string | undefined; nowMs: number; timeZone?: string }
): { short: string; full: string } => {
  if (!Number.isFinite(ms)) return { short: '', full: '' };
  const full = clockFormatter(locale, 'full', timeZone).format(ms);
  const day = calendarDay(ms, timeZone);
  const today = calendarDay(nowMs, timeZone);
  if (day === today) return { short: clockFormatter(locale, 'time', timeZone).format(ms), full };
  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  return {
    short: clockFormatter(locale, sameYear ? 'monthDayTime' : 'fullDateTime', timeZone).format(ms),
    full,
  };
};
