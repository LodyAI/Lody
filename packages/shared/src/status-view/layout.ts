import { buildPinnedSectionLayout, type PinSection, sortByManualOrder } from '../pinned-sections';
import {
  buildOpenedBySessionTree,
  getPinnedSessionTreeIds,
  pinnedFirstRootRank,
  type OpenedBySessionTreeNode,
} from './opened-by-tree';
import {
  statusViewWokenAt,
  statusViewActivityAt,
  statusViewTier,
  statusViewTierChangeAt,
  statusViewUnread,
  type StatusViewTier,
} from './tiers';

/**
 * The list layout of the Status view: the Pinned area, then Focus, Later and
 * Settled. Pure and JSON in, JSON out, so the desktop sidebar, the phone
 * WebView and the native clients' shared runtime compute the same rows.
 * Design: .agents/notes/implemented/architecture/2026-11-21-status-view-on-phones.md.
 */

/** One visible conversation: non-archived, scope applied, contained Tabs folded in. */
export type StatusViewSession = {
  id: string;
  /** Last tie-break in Settled, after activity. */
  title?: string;
  /** The conversation's own `SessionMeta.lastMessageAt`; drives unread. */
  lastMessageAt: number | null;
  /**
   * Latest activity for tiering and ordering. The host may roll contained Tabs
   * up into it and fall back to the creation time. Defaults to `lastMessageAt`.
   */
  activityAt?: number | null;
  lastReadAt: number | null;
  isPinned: boolean;
  pinSectionId: string | null;
  orderKey: string | null;
  snoozedUntil: number | null;
  settledAt: number | null;
  focusRestoredAt: number | null;
  /** The row this one nests under: the opener, or the opener Tab's owner. */
  openedById: string | null;
  isWorking: boolean;
  isWaitingPermission: boolean;
  /** May Later, Settle, Move to Focus and reorder Focus. */
  canManage: boolean;
  /** May pin, unpin and place in a pin section. */
  canPrefer: boolean;
};

export type StatusViewLayoutInput = {
  sessions: StatusViewSession[];
  sections: PinSection[];
  /** False while the section rows have not been read yet. */
  sectionsLoaded: boolean;
  /** May create, rename, reorder and delete pin sections. */
  canManageSections: boolean;
  /**
   * Pinned rows the scope hid, by the `pinSectionId` of their pinned root
   * (`""` for the default section). Unknown sections count under the default.
   */
  scopeHiddenCounts?: Record<string, number>;
  /** Synced server clock. */
  nowMs: number;
};

export type StatusViewRowTier = 'pinned' | StatusViewTier;

export type StatusViewRow = {
  id: string;
  tier: StatusViewRowTier;
  /** Opened-by children rendered under this row. */
  children: StatusViewRow[];
  /** `max(activityAt, expired snoozedUntil)`. */
  activityAt: number;
  unread: boolean;
  /** Set while the row is in Later. */
  snoozedUntil: number | null;
  /** An expired snooze floating at the top of Focus. */
  woken: boolean;
  canManage: boolean;
  canPrefer: boolean;
};

export type StatusViewPinnedSection = {
  /** `null` is the default section. */
  sectionId: string | null;
  name: string | null;
  rows: StatusViewRow[];
  hiddenCount: number;
};

export type StatusViewLayout = {
  pinned: StatusViewPinnedSection[];
  focus: StatusViewRow[];
  later: StatusViewRow[];
  settled: StatusViewRow[];
  canManageSections: boolean;
  /** Earliest future instant at which the layout can change by time alone. */
  nextChangeAt: number | null;
};

/** Key of the default section in {@link StatusViewLayoutInput.scopeHiddenCounts}. */
export const STATUS_VIEW_DEFAULT_SECTION_COUNT_KEY = '';

const rowActivity = (session: StatusViewSession, nowMs: number): number =>
  statusViewActivityAt(session.activityAt ?? session.lastMessageAt, session.snoozedUntil, nowMs);

const tierInput = (session: StatusViewSession, nowMs: number) => ({
  activityAt: rowActivity(session, nowMs),
  isWorking: session.isWorking,
  isWaitingPermission: session.isWaitingPermission,
  snoozedUntil: session.snoozedUntil,
  settledAt: session.settledAt,
  focusRestoredAt: session.focusRestoredAt,
});

const TREE_ACCESSORS = {
  getId: (session: StatusViewSession) => session.id,
  getOpenedBySessionId: (session: StatusViewSession) => session.openedById,
} as const;

/** Ids in the Pinned area: pinned rows plus the visible rows they opened. */
export function statusViewPinnedIds(sessions: readonly StatusViewSession[]): Set<string> {
  return getPinnedSessionTreeIds(sessions, {
    ...TREE_ACCESSORS,
    isPinned: (session) => session.isPinned,
  });
}

/** The pinned row an opened row is carried by, however many openers up. */
function pinnedOwner(
  session: StatusViewSession,
  byId: ReadonlyMap<string, StatusViewSession>
): StatusViewSession | undefined {
  const seen = new Set<string>();
  let cursor: StatusViewSession | undefined = session;
  while (cursor && !cursor.isPinned && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    cursor = cursor.openedById ? byId.get(cursor.openedById) : undefined;
  }
  return cursor?.isPinned ? cursor : undefined;
}

/** Where a row in the Pinned area sits: an opened row follows its pinned opener. */
export function statusViewPinPlacement(
  session: StatusViewSession,
  byId: ReadonlyMap<string, StatusViewSession>,
  nowMs: number
) {
  const owner = pinnedOwner(session, byId);
  return {
    id: session.id,
    pinSectionId: owner?.isPinned ? owner.pinSectionId : null,
    orderKey: owner?.isPinned ? owner.orderKey : null,
    recency: rowActivity(session, nowMs),
  };
}

/** Focus: expired snoozes first (latest wake-up first), then manual order. */
function orderFocus(members: StatusViewSession[], nowMs: number): StatusViewSession[] {
  const woken: StatusViewSession[] = [];
  const regular: StatusViewSession[] = [];
  for (const session of members) {
    if (statusViewWokenAt(session.snoozedUntil, session.focusRestoredAt, nowMs) !== null)
      woken.push(session);
    else regular.push(session);
  }
  woken.sort((a, b) => (b.snoozedUntil ?? 0) - (a.snoozedUntil ?? 0) || a.id.localeCompare(b.id));
  const ordered = sortByManualOrder(regular, (session) => ({
    id: session.id,
    orderKey: session.orderKey,
  }));
  return [...woken, ...ordered];
}

function orderLater(members: StatusViewSession[]): StatusViewSession[] {
  return [...members].sort((a, b) => {
    const aUntil = a.snoozedUntil ?? Number.MAX_SAFE_INTEGER;
    const bUntil = b.snoozedUntil ?? Number.MAX_SAFE_INTEGER;
    return aUntil - bUntil || a.id.localeCompare(b.id);
  });
}

function orderSettled(members: StatusViewSession[], nowMs: number): StatusViewSession[] {
  return [...members].sort(
    (a, b) =>
      rowActivity(b, nowMs) - rowActivity(a, nowMs) ||
      (a.title ?? '').localeCompare(b.title ?? '') ||
      a.id.localeCompare(b.id)
  );
}

function toRows(
  nodes: OpenedBySessionTreeNode<StatusViewSession>[],
  tier: StatusViewRowTier,
  nowMs: number
): StatusViewRow[] {
  const rows: StatusViewRow[] = [];
  for (const node of nodes) {
    const session = node.item;
    const row: StatusViewRow = {
      id: session.id,
      tier,
      children: [],
      activityAt: rowActivity(session, nowMs),
      unread: statusViewUnread(session, nowMs),
      snoozedUntil: tier === 'later' ? session.snoozedUntil : null,
      woken:
        tier === 'focus' &&
        statusViewWokenAt(session.snoozedUntil, session.focusRestoredAt, nowMs) !== null,
      canManage: session.canManage,
      canPrefer: session.canPrefer,
    };
    if (node.depth === 1) rows[rows.length - 1]?.children.push(row);
    else rows.push(row);
  }
  return rows;
}

function treeRows(
  ordered: StatusViewSession[],
  tier: StatusViewRowTier,
  nowMs: number,
  rankByActivity: boolean
): StatusViewRow[] {
  const nodes = buildOpenedBySessionTree(ordered, {
    ...TREE_ACCESSORS,
    ...(rankByActivity
      ? {
          rootRank: (session: StatusViewSession) =>
            pinnedFirstRootRank(rowActivity(session, nowMs), session.isPinned),
        }
      : {}),
  });
  return toRows(nodes, tier, nowMs);
}

/** Split rows into the Status tiers in their display order, without the Pinned area. */
export function buildStatusViewTiers(
  sessions: readonly StatusViewSession[],
  nowMs: number
): Pick<StatusViewLayout, 'focus' | 'later' | 'settled'> {
  const byTier: Record<StatusViewTier, StatusViewSession[]> = {
    focus: [],
    later: [],
    settled: [],
  };
  for (const session of sessions)
    byTier[statusViewTier(tierInput(session, nowMs), nowMs)].push(session);
  return {
    focus: treeRows(orderFocus(byTier.focus, nowMs), 'focus', nowMs, false),
    later: treeRows(orderLater(byTier.later), 'later', nowMs, false),
    settled: treeRows(orderSettled(byTier.settled, nowMs), 'settled', nowMs, true),
  };
}

export function buildStatusViewLayout(input: StatusViewLayoutInput): StatusViewLayout {
  const { nowMs } = input;
  const byId = new Map(input.sessions.map((session) => [session.id, session]));
  const pinnedIds = statusViewPinnedIds(input.sessions);
  const pinnedSessions = input.sessions.filter((session) => pinnedIds.has(session.id));

  const sectionLayout = buildPinnedSectionLayout(
    pinnedSessions,
    input.sections,
    (session) => statusViewPinPlacement(session, byId, nowMs),
    { sectionsLoaded: input.sectionsLoaded }
  );

  const knownSectionIds = new Set(input.sections.map((section) => section.id));
  const hidden = new Map<string | null, number>();
  if (input.sectionsLoaded) {
    for (const [key, count] of Object.entries(input.scopeHiddenCounts ?? {})) {
      if (!Number.isFinite(count) || count <= 0) continue;
      const sectionId =
        key !== STATUS_VIEW_DEFAULT_SECTION_COUNT_KEY && knownSectionIds.has(key) ? key : null;
      hidden.set(sectionId, (hidden.get(sectionId) ?? 0) + count);
    }
  }

  const pinned = sectionLayout.map<StatusViewPinnedSection>((entry) => ({
    sectionId: entry.sectionId,
    name: entry.section?.name ?? null,
    rows: treeRows(entry.items, 'pinned', nowMs, false),
    hiddenCount: hidden.get(entry.sectionId) ?? 0,
  }));

  const statusSessions = input.sessions.filter((session) => !pinnedIds.has(session.id));
  const tiers = buildStatusViewTiers(statusSessions, nowMs);

  let nextChangeAt: number | null = null;
  const consider = (at: number | null) => {
    if (at !== null && at > nowMs && (nextChangeAt === null || at < nextChangeAt)) {
      nextChangeAt = at;
    }
  };
  for (const session of input.sessions) {
    if (pinnedIds.has(session.id)) {
      consider(session.snoozedUntil);
    } else {
      consider(statusViewTierChangeAt(tierInput(session, nowMs), nowMs));
    }
  }

  return {
    pinned,
    ...tiers,
    canManageSections: input.canManageSections,
    nextChangeAt,
  };
}

/** Rows of a tier list with their children, in render order. */
export function flattenStatusViewRows(rows: readonly StatusViewRow[]): StatusViewRow[] {
  return rows.flatMap((row) => [row, ...row.children]);
}
