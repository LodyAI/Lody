/**
 * The Status view's tiers in display order:
 * - `focus`   (进行中): expanded by default, manually ordered via `orderKey`
 * - `later`   (稍后):   collapsed by default, snoozed until `snoozedUntil`, sorted by wake-up time ascending
 * - `settled` (已完成): collapsed by default, manually settled or inactive >= 7 days, sorted by recency descending
 *
 * Pure: every time-dependent rule takes `nowMs` on the synced server clock.
 * Behavior: specs/sidebar-status-view.md.
 */
export const STATUS_VIEW_TIERS = ['focus', 'later', 'settled'] as const;

export type StatusViewTier = (typeof STATUS_VIEW_TIERS)[number];

/** Inactivity window after which a quiet conversation automatically settles (7 days). */
export const STATUS_VIEW_SETTLE_INACTIVITY_MS = 7 * 24 * 60 * 60 * 1000;

/** Rows past this many top-level entries fold behind "Show all" in Settled. */
export const STATUS_VIEW_SETTLED_FOLD_THRESHOLD = 20;

/** What classification needs of one row. */
export type StatusViewTierInput = {
  /** Latest activity in epoch ms; 0 or null when unknown. */
  activityAt?: number | null;
  isWorking?: boolean;
  isWaitingPermission?: boolean;
  snoozedUntil?: number | null;
  settledAt?: number | null;
  focusRestoredAt?: number | null;
};

const finite = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * Later and Settled start collapsed so Focus remains the sole active list.
 * Surfaces own the stored override; this is only the default.
 */
export function isStatusTierCollapsedByDefault(key: string): boolean {
  return key === 'later' || key === 'settled';
}

/**
 * The elapsed `snoozedUntil` once `nowMs >= snoozedUntil`, otherwise `null`.
 * Derives wake-up activity, unread state and Focus top placement without
 * background writes.
 */
export function expiredSnoozeTimestamp(
  snoozedUntil: number | null | undefined,
  nowMs: number
): number | null {
  const until = finite(snoozedUntil);
  if (until === null) return null;
  return until <= nowMs ? until : null;
}

/** `max(activityAt, expired snoozedUntil)`: the activity a row shows and sorts by. */
export function statusViewActivityAt(
  activityAt: number | null | undefined,
  snoozedUntil: number | null | undefined,
  nowMs: number
): number {
  return Math.max(finite(activityAt) ?? 0, expiredSnoozeTimestamp(snoozedUntil, nowMs) ?? 0);
}

/**
 * Unread when the latest message, or an expired snooze, is newer than the read
 * receipt. `lastMessageAt` is the conversation's own message time.
 */
export function statusViewUnread(
  input: {
    lastMessageAt?: number | null;
    lastReadAt?: number | null;
    snoozedUntil?: number | null;
  },
  nowMs: number
): boolean {
  const message = finite(input.lastMessageAt);
  const woken = expiredSnoozeTimestamp(input.snoozedUntil, nowMs);
  const effective =
    message !== null && woken !== null ? Math.max(message, woken) : (message ?? woken);
  if (effective === null) return false;
  const read = finite(input.lastReadAt);
  return read === null || effective > read;
}

/**
 * Classify one non-pinned, non-archived conversation into Focus, Later or Settled.
 *
 * Snooze expiry and 7-day inactivity settling are derived, so no background
 * writer is needed across offline replicas.
 */
export function statusViewTier(input: StatusViewTierInput, nowMs: number): StatusViewTier {
  // Blocked permission approvals always surface in Focus so they are never hidden.
  if (input.isWaitingPermission) return 'focus';

  const snoozedUntil = finite(input.snoozedUntil);
  if (snoozedUntil !== null && snoozedUntil > nowMs) return 'later';

  const effectiveMessageMs = statusViewActivityAt(input.activityAt, snoozedUntil, nowMs);
  const settledAt = finite(input.settledAt);
  if (settledAt !== null && settledAt > 0 && effectiveMessageMs <= settledAt) return 'settled';

  const effectiveActivityMs = Math.max(effectiveMessageMs, finite(input.focusRestoredAt) ?? 0);
  if (
    !input.isWorking &&
    effectiveActivityMs > 0 &&
    nowMs - effectiveActivityMs >= STATUS_VIEW_SETTLE_INACTIVITY_MS
  ) {
    return 'settled';
  }
  return 'focus';
}

/**
 * The next instant after `nowMs` at which this row's tier or wake-up state can
 * change by time alone, or `null`.
 */
export function statusViewTierChangeAt(input: StatusViewTierInput, nowMs: number): number | null {
  const snoozedUntil = finite(input.snoozedUntil);
  if (snoozedUntil !== null && snoozedUntil > nowMs) return snoozedUntil;
  if (input.isWaitingPermission || input.isWorking) return null;
  if (statusViewTier(input, nowMs) !== 'focus') return null;
  const effectiveActivityMs = Math.max(
    statusViewActivityAt(input.activityAt, snoozedUntil, nowMs),
    finite(input.focusRestoredAt) ?? 0
  );
  if (effectiveActivityMs <= 0) return null;
  const settlesAt = effectiveActivityMs + STATUS_VIEW_SETTLE_INACTIVITY_MS;
  return settlesAt > nowMs ? settlesAt : null;
}

/**
 * Compact countdown label for a snoozed conversation in Later, e.g. `3d`,
 * `2h`, `45m`, `<1m`. Returns `null` once expired.
 */
export function formatSnoozeCountdown(snoozedUntilMs: number, nowMs: number): string | null {
  const remainingMs = snoozedUntilMs - nowMs;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;

  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  if (remainingMs < minuteMs) return '<1m';
  if (remainingMs < 59.5 * minuteMs) return `${Math.ceil(remainingMs / minuteMs)}m`;
  if (remainingMs < 23.5 * hourMs) return `${Math.ceil(remainingMs / hourMs)}h`;
  return `${Math.max(1, Math.round(remainingMs / dayMs))}d`;
}

export type SnoozePresetId = 'oneHour' | 'laterToday' | 'tomorrowMorning' | 'nextWeek';

export type SnoozePreset = {
  id: SnoozePresetId;
  timestamp: number;
  countdown: string;
};

/**
 * Quick snooze targets relative to `now`. Morning anchors use the host's local
 * wall clock (the person's time zone), so the result depends on it.
 */
export function buildSnoozePresets(now: Date | number): SnoozePreset[] {
  const nowDate = new Date(typeof now === 'number' ? now : now.getTime());
  const nowMs = nowDate.getTime();
  const oneHour = nowMs + 60 * 60 * 1000;
  const laterToday = nowMs + 3 * 60 * 60 * 1000;

  const tomorrow = new Date(nowMs);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const tomorrowMorning = tomorrow.getTime();

  const nextMonday = new Date(nowMs);
  const dayOfWeek = nextMonday.getDay(); // 0=Sun..6=Sat
  // On Sunday, tomorrow morning is already Monday 9:00, so Next week targets the following Monday.
  const daysUntilMonday = dayOfWeek === 0 ? 8 : 8 - dayOfWeek;
  nextMonday.setDate(nextMonday.getDate() + daysUntilMonday);
  nextMonday.setHours(9, 0, 0, 0);
  const nextWeek = nextMonday.getTime();

  return [
    { id: 'oneHour', timestamp: oneHour, countdown: formatSnoozeCountdown(oneHour, nowMs) ?? '1h' },
    {
      id: 'laterToday',
      timestamp: laterToday,
      countdown: formatSnoozeCountdown(laterToday, nowMs) ?? '3h',
    },
    {
      id: 'tomorrowMorning',
      timestamp: tomorrowMorning,
      countdown: formatSnoozeCountdown(tomorrowMorning, nowMs) ?? '1d',
    },
    {
      id: 'nextWeek',
      timestamp: nextWeek,
      countdown: formatSnoozeCountdown(nextWeek, nowMs) ?? '7d',
    },
  ];
}
