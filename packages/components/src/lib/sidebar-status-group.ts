/**
 * The sidebar's "Status" (`状态`) groups in display order:
 * - `focus`   (进行中): expanded by default, manually ordered via `orderKey`
 * - `later`   (稍后):   collapsed by default, snoozed until `snoozedUntil`, sorted by wake-up time ascending
 * - `settled` (已完成): collapsed by default, manually settled or inactive >= 7 days, sorted by recency descending
 *
 * Behavior: specs/sidebar-status-view.md.
 */
export const SIDEBAR_STATUS_GROUPS = ['focus', 'later', 'settled'] as const;

export type SidebarStatusGroup = (typeof SIDEBAR_STATUS_GROUPS)[number];

/** Inactivity window after which a quiet session automatically settles (7 days). */
export const SIDEBAR_SETTLED_INACTIVITY_MS = 7 * 24 * 60 * 60 * 1000;

/** What classification needs of one sidebar row. */
export type SidebarStatusGroupInput = {
  latestMessageAt?: Date | number | string | null;
  isWorking?: boolean;
  isWaitingPermission?: boolean;
  snoozedUntil?: number | null;
  settledAt?: number | null;
  focusRestoredAt?: number | null;
};

function toTimestampMs(value: Date | number | string | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : 0;
  }
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : 0;
  }
  return 0;
}

/**
 * Default collapse state for a status bucket when the user has not explicitly
 * toggled it: `later` and `settled` start collapsed so Focus remains the sole
 * active workspace.
 */
export function isStatusBucketCollapsedByDefault(key: string): boolean {
  return key === 'later' || key === 'settled';
}

/**
 * Resolve effective collapse state for a bucket given the user's persisted
 * override map.
 */
export function isSidebarBucketCollapsed(
  key: string,
  collapsedBuckets?: Readonly<Record<string, boolean | undefined>>
): boolean {
  const override = collapsedBuckets?.[key];
  if (typeof override === 'boolean') return override;
  return isStatusBucketCollapsedByDefault(key);
}

/**
 * Classify one non-pinned, non-archived conversation into Focus, Later, or Settled.
 *
 * Snooze expiration and 7-day inactivity settling are pure derived states so no
 * background writer is needed across offline replicas.
 */
export function sidebarStatusGroup(
  input: SidebarStatusGroupInput,
  nowMs: number = Date.now()
): SidebarStatusGroup {
  // Blocked permission approvals always surface in Focus so they are never hidden.
  if (input.isWaitingPermission) {
    return 'focus';
  }

  if (typeof input.snoozedUntil === 'number' && input.snoozedUntil > nowMs) {
    return 'later';
  }

  const lastMessageMs = toTimestampMs(input.latestMessageAt);
  if (
    typeof input.settledAt === 'number' &&
    input.settledAt > 0 &&
    lastMessageMs <= input.settledAt
  ) {
    return 'settled';
  }

  const restoredMs = typeof input.focusRestoredAt === 'number' ? input.focusRestoredAt : 0;
  const effectiveActivityMs = Math.max(lastMessageMs, restoredMs);
  if (
    !input.isWorking &&
    effectiveActivityMs > 0 &&
    nowMs - effectiveActivityMs >= SIDEBAR_SETTLED_INACTIVITY_MS
  ) {
    return 'settled';
  }

  return 'focus';
}

/**
 * Compact countdown label for a snoozed conversation in the Later section,
 * e.g. `3d`, `2h`, `45m`, `<1m`. Returns `null` once expired.
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

export type SnoozePresetId = 'laterToday' | 'tomorrowMorning' | 'nextWeek';

export type SnoozePreset = {
  id: SnoozePresetId;
  timestamp: number;
  countdown: string;
};

/** Quick snooze targets relative to `now` (local wall clock for morning anchors, deduplicated). */
export function buildSnoozePresets(now: Date): SnoozePreset[] {
  const nowMs = now.getTime();
  const laterToday = nowMs + 3 * 60 * 60 * 1000;

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const tomorrowMorning = tomorrow.getTime();

  const nextMonday = new Date(now);
  const dayOfWeek = nextMonday.getDay(); // 0=Sun..6=Sat
  // On Sunday, tomorrow morning is already Monday 9:00, so Next week targets the following Monday.
  const daysUntilMonday = dayOfWeek === 0 ? 8 : 8 - dayOfWeek;
  nextMonday.setDate(nextMonday.getDate() + daysUntilMonday);
  nextMonday.setHours(9, 0, 0, 0);
  const nextWeek = nextMonday.getTime();

  return [
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
